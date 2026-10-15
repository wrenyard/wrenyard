import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { resolveWrenyardConfigRoot } from '@wrenyard/paths'
import type { Session } from '@wrenyard/session'
import { ProjectManager } from '../../../core/project/manager.mts'
import type { ForemanDatabase } from '../../../db/types.mts'
import type {
  BotConfigValidateResult,
  BotHealth,
  BotHealthComponent,
  BotHealthHost,
  BotItemRecord,
  BotModel,
  BotRecord,
} from '../../../protocol/methods/bot.mts'
import type { OperationComponents } from '../operation-components.mts'
import { requiresDeliveryLane, type BotItemState, type BotStepKind } from './machine.mts'
import {
  BotLaneBusyError,
  classifyStepProbe,
  createBotStore,
  type BotItemPatch,
  type BotStepRecord,
  type BotStore,
} from './store.mts'

/**
 * Bot host: the daemon-owned service that owns bots for one workspace.
 *
 * It mirrors the scheduler lifecycle (prepare / start / stop / flush, one
 * unref'd timer, no overlapping ticks, workspace-scoped records) and drives
 * every item through its idempotent steps. The host itself never reasons: all
 * judgment belongs to task runs, and every outward effect is a named step with
 * an idempotency key so a restart reconciles instead of repeating.
 *
 * The host never restarts, upgrades or reinstalls the app or daemon it runs in.
 */

/** Diagnostic sink; wired to the daemon log by the caller. */
export type BotLog = (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void

/** How often the host advances items and runs its watchdogs. */
const DEFAULT_TICK_MS = 60_000
/** How often an inbox poll is due when adapters exist. */
const DEFAULT_POLL_MS = 10 * 60_000

export interface BotStepContext {
  bot: BotRecord
  item: BotItemRecord
  step: BotStepRecord
  /** True when the effect must be recorded instead of performed. */
  dryRun: boolean
}

export interface BotStepResult {
  /** Structured step output, stored verbatim on the journal row. */
  output?: unknown
  /** Item state to move to when the step succeeds. */
  to?: BotItemState
  patch?: BotItemPatch
}

/** Outcome of one restart probe. */
export type BotStepProbe = 'done' | 'not-done' | 'unavailable'

export interface BotStepHandler {
  /**
   * True for outward effects (merge, push, inbox.complete, annotate, release,
   * notify): in dry-run mode the step is recorded with a would-be output and
   * `run` is never called.
   */
  sideEffect?: boolean
  /** Recorded instead of `run` while the bot is in dry-run mode. */
  dryRun?: (context: BotStepContext) => Promise<BotStepResult> | BotStepResult
  /**
   * Restart probe. Proves whether the effect already happened; a kind with no
   * probe can never be proven, so a pending one becomes `unknown` and is never
   * re-executed automatically.
   */
  probe?: (context: BotStepContext) => Promise<BotStepProbe>
  /** Item state a proven-done step moves the item to during reconciliation. */
  doneState?: BotItemState
  run: (context: BotStepContext) => Promise<BotStepResult>
}

export interface CreateBotHostOptions {
  db: ForemanDatabase
  /** The workspace root this host serves; another root's bots are never ticked. */
  workspaceRoot: string
  /** The session feature the host creates and drives sessions through. */
  session: Pick<Session, 'createSession' | 'listSessions' | 'send' | 'readLedger'>
  /** Project manager used for the worktree, merge and push steps. */
  projectManager?: ProjectManager
  /** Tick cadence in milliseconds; defaults to 60 s. */
  tickMs?: number
  /** Inbox poll cadence in milliseconds; defaults to 10 min. */
  pollMs?: number
  /**
   * Routing policy hook: the model to dispatch or judge with. Stage (a) has no
   * config parser, so an unmapped send fails its step instead of guessing.
   */
  routeModel?: (input: { kind: 'dispatch' | 'followUp' | 'acceptance' | 'judgment'; class?: string }) => BotModel | undefined
  /** Brief builder; defaults to the generic bot brief. */
  buildBrief?: (item: BotItemRecord, step: BotStepRecord) => string
  log?: BotLog
  /**
   * Admission gate checked at tick entry and again before every step, so a hot
   * switch or shutdown cannot race a bot step.
   */
  canRun?: () => boolean
  /**
   * Device/daemon identity reported by `bot.health.host`, built by the daemon
   * from the same helper `health.ping` uses. When omitted, this process's own
   * hostname/platform/arch are reported and the mode falls back to `source`.
   */
  identity?: () => BotHealthHost
  /**
   * Operation component service backing `bot.health.components`. Only `list` is
   * read, so health never triggers a refresh; when it is absent or throws the
   * reported list is empty.
   */
  operationComponents?: Pick<OperationComponents, 'list'>
}

export interface BotHost {
  readonly store: BotStore
  /** Load and prepare without reconciling or arming the timer (hot-switch staging). */
  prepare(): Promise<void>
  /** Reconcile pending steps once, then tick every 60 s. */
  start(): Promise<void>
  stop(): void
  /** True while a tick or a reconciliation is in flight. */
  readonly ticking: boolean
  /** Await every queued write. The store writes synchronously, so this settles at once. */
  flush(): Promise<void>
  /** Resolve every pending step by probe; unprobeable ones become unknown. */
  reconcile(): Promise<void>
  /** Run one tick now (all running bots, or just one). */
  tick(botId?: string): Promise<void>
  health(botId: string): Promise<BotHealth>
  control(botId: string, action: 'start' | 'pause' | 'resume' | 'stop'): BotRecord
  validateConfig(configPath: string): Promise<BotConfigValidateResult>
  itemAction(botId: string, itemId: string, action: 'retry' | 'dismiss' | 'answer' | 'cleanup', answer?: string): Promise<BotItemRecord>
}

/** Deterministic worktree id for one item: bot id + item id, 8 URL-safe chars. */
export function deterministicWorktreeId(botId: string, itemId: string): string {
  return createHash('sha1').update(`${botId}:${itemId}`).digest('base64url').slice(0, 8)
}

export function createBotHost(options: CreateBotHostOptions): BotHost {
  const { db, workspaceRoot, session, log, canRun } = options
  const store = createBotStore({ db, workspaceRoot })
  const projectManager = options.projectManager ?? new ProjectManager({ workspaceRoot })
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS

  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let prepared = false
  /** Ticks queued or running; the public `ticking` flag is true while it is > 0. */
  let inFlightTicks = 0
  /** Tail of the serialized tick chain; every tick path joins it, never races it. */
  let tickChain: Promise<void> = Promise.resolve()
  /** Epoch ms the next scheduled tick was due; used to measure tick lag. */
  let nextTickAt = 0
  let startedAt = new Date().toISOString()
  let tickCount = 0
  let lastTickAt: string | undefined
  let lastTickLagMs = 0
  let maxTickLagMs = 0
  /** `itemId:kind` keys already reported as unavailable, so the log stays once-per-item. */
  const unavailableLogged = new Set<string>()

  function nowIso(): string {
    return new Date().toISOString()
  }

  /** This process's device/daemon identity, used when none is injected. */
  function resolveHostIdentity(): BotHealthHost {
    try {
      const injected = options.identity?.()
      if (injected !== undefined) return injected
    } catch {
      // Fall through to this process's own values.
    }
    return { hostname: hostname(), platform: process.platform, arch: process.arch, mode: 'source' }
  }

  /** Component states for `bot.health`, read from the cached list only. */
  async function listComponents(): Promise<BotHealthComponent[]> {
    const service = options.operationComponents
    if (service === undefined) return []
    try {
      return (await service.list()).map(snapshot => ({ id: snapshot.id, state: snapshot.state }))
    } catch {
      return []
    }
  }

  /**
   * Serialize one tick pass behind every pass already queued. A tick issued
   * while another pass is in flight joins the chain and runs its own pass after
   * it, so the same pending step is never executed by two passes at once.
   */
  function scheduleTick(pass: () => Promise<void>): Promise<void> {
    const run = tickChain.then(pass, pass)
    // Keep the chain alive whatever a pass outcome is; the caller still sees the
    // real result through its own promise.
    tickChain = run.then(() => undefined, () => undefined)
    inFlightTicks += 1
    const settled = (): void => { inFlightTicks -= 1 }
    void run.then(settled, settled)
    return run
  }

  function itemContext(bot: BotRecord, step: BotStepRecord): BotStepContext {
    const item = store.getItem(bot.id, step.itemId)
    return { bot, item, step, dryRun: bot.mode === 'dryRun' || item.dryRun }
  }

  // ── step handlers ────────────────────────────────────────────────────────

  const worktreeCreate: BotStepHandler = {
    async probe({ bot, item }) {
      if (!item.project) return 'unavailable'
      const id = deterministicWorktreeId(bot.id, item.id)
      return projectManager.listWorktrees(item.project).some(worktree => worktree.id === id)
        ? 'done'
        : 'not-done'
    },
    async run({ bot, item }) {
      if (!item.project) throw new Error('item has no project')
      const id = deterministicWorktreeId(bot.id, item.id)
      const existing = projectManager.listWorktrees(item.project).find(worktree => worktree.id === id)
      if (existing) {
        return { output: { worktreeId: existing.id, branch: existing.branch, reused: true }, patch: { worktreeId: existing.id, branch: existing.branch } }
      }
      const creator = new ProjectManager({ workspaceRoot, idGenerator: () => id })
      const created = creator.createWorktree(item.project)
      return {
        output: { worktreeId: created.worktree_id, branch: created.branch },
        patch: { worktreeId: created.worktree_id, branch: created.branch },
      }
    },
  }

  const sessionCreate: BotStepHandler = {
    async probe({ item }) {
      return item.sessionId === undefined ? 'not-done' : 'done'
    },
    async run({ bot, item }) {
      if (item.sessionId !== undefined) return { output: { sessionId: item.sessionId, reused: true } }
      const created = await session.createSession()
      // The session feature exposes only archived/pinned list metadata, so the
      // bot owns the {bot, item} association on the item row, which is the
      // durable form of the same binding.
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'info',
        code: 'session.bound',
        message: `session ${created.sessionId} bound to bot ${bot.id} item ${item.id}`,
      })
      return { output: { sessionId: created.sessionId, bot: bot.id, item: item.id }, patch: { sessionId: created.sessionId } }
    },
  }

  /** The latest `turn.started` model of one session, or undefined. */
  function latestSessionModel(sessionId: string): BotModel | undefined {
    let found: BotModel | undefined
    for (const event of session.readLedger(sessionId)) {
      if (event.type !== 'turn.started') continue
      found = {
        provider: event.model.provider,
        model: event.model.model,
        reasoningEffort: (event.model.reasoningEffort ?? 'default') as BotModel['reasoningEffort'],
      }
    }
    return found
  }

  /**
   * The model one send must use. A first dispatch takes the routing policy's
   * choice; every follow-up reuses the session's own latest turn model and
   * adopts (and logs) it when it changed, so a user switch is never overridden.
   */
  function resolveSendModel(bot: BotRecord, item: BotItemRecord): BotModel | undefined {
    if (item.sessionId !== undefined) {
      const adopted = latestSessionModel(item.sessionId)
      if (adopted !== undefined) {
        if (item.sessionModel !== undefined && !sameModel(item.sessionModel, adopted)) {
          store.appendLog({
            botId: bot.id,
            itemId: item.id,
            level: 'info',
            code: 'session.model.adopted',
            message: `adopted session model ${adopted.provider}/${adopted.model}`,
          })
        }
        return adopted
      }
      return item.sessionModel
    }
    return options.routeModel?.({ kind: 'dispatch', ...(item.class === undefined ? {} : { class: item.class }) })
  }

  const sessionSend: BotStepHandler = {
    doneState: 'in_progress',
    async probe({ item, step }) {
      if (item.sessionId === undefined) return 'not-done'
      const marker = `[bot:${step.idemKey}]`
      const found = session.readLedger(item.sessionId).some(
        event => event.type === 'turn.started' && event.text.includes(marker),
      )
      return found ? 'done' : 'not-done'
    },
    async run({ bot, item, step }) {
      if (item.sessionId === undefined) throw new Error('item has no session')
      const model = resolveSendModel(bot, item)
      if (model === undefined) throw new Error('no routed model is available for this item')
      const text = options.buildBrief?.(item, step) ?? defaultBrief(item, step)
      const result = await session.send(item.sessionId, { text, model })
      return {
        output: { turn: result.turn, model },
        patch: { sessionModel: model },
        // A first dispatch becomes in progress; a follow-up keeps its state.
        ...(item.state === 'dispatched' ? { to: 'in_progress' as BotItemState } : {}),
      }
    },
  }

  const mergeStep: BotStepHandler = {
    sideEffect: true,
    doneState: 'merged',
    // A merge result is authoritative and a landed merge cannot be probed
    // without git, so a pending merge is never replayed automatically.
    async probe() { return 'unavailable' },
    dryRun: ({ item }) => ({
      output: { dryRun: true, wouldMerge: { project: item.project, worktreeId: item.worktreeId } },
      to: 'merged',
    }),
    async run({ item }) {
      if (!item.project || !item.worktreeId) throw new Error('item has no project worktree to merge')
      const result = projectManager.mergeWorktree(item.project, item.worktreeId)
      if (!result.merged) {
        // A non-merged worktree needs a human decision, so the item parks with
        // the reason verbatim instead of silently failing.
        return {
          output: result,
          to: 'parked',
          patch: {
            parkedFrom: 'merging',
            question: `merge of worktree ${item.worktreeId} into ${item.project} failed: ${result.reason ?? 'unknown'}`,
            error: result.error ?? result.reason ?? 'merge_failed',
          },
        }
      }
      return {
        output: result,
        to: 'merged',
        ...(result.after_sha === undefined ? {} : { patch: { mergedSha: result.after_sha } }),
      }
    },
  }

  const pushStep: BotStepHandler = {
    sideEffect: true,
    doneState: 'completing',
    async probe() { return 'unavailable' },
    dryRun: ({ item }) => ({
      output: { dryRun: true, wouldPush: { project: item.project } },
      to: 'completing',
    }),
    async run({ item }) {
      if (!item.project) throw new Error('item has no project to push')
      const result = await projectManager.pushProject({ project: item.project })
      if (!result.pushed) {
        return {
          output: result,
          to: 'parked',
          patch: {
            parkedFrom: 'merged',
            question: `push of ${item.project} failed: ${result.reason ?? 'unknown'}`,
            error: result.error ?? result.reason ?? 'push_failed',
          },
        }
      }
      return { output: result, to: 'completing' }
    },
  }

  /**
   * The explicit `ready -> accepting` lane-acquire step. It performs no outward
   * effect: the store acquires the project's delivery lane inside the same
   * transaction that writes the new state, and a busy lane throws so the item
   * stays `ready` to retry on a later tick.
   */
  const laneAcquire: BotStepHandler = {
    async run() { return { to: 'accepting' } },
  }

  const handlers: Partial<Record<BotStepKind, BotStepHandler>> = {
    'lane.acquire': laneAcquire,
    'worktree.create': worktreeCreate,
    'session.create': sessionCreate,
    'session.send': sessionSend,
    merge: mergeStep,
    push: pushStep,
  }

  // ── step execution ───────────────────────────────────────────────────────

  /**
   * True when a lane-state item may run its handlers: it must actually hold its
   * project's delivery lane. The store owns the lane rule, so this is only a
   * consistency check before an effect runs.
   */
  function laneHeld(item: BotItemRecord): boolean {
    if (!requiresDeliveryLane(item.state)) return true
    if (item.project === undefined) return true
    return store.getLane(item.project)?.itemId === item.id
  }

  /**
   * Commit one successful step: the terminal step status and the next item
   * state. The store applies the lane rule inside that same transaction.
   */
  function commitStep(item: BotItemRecord, step: BotStepRecord, result: BotStepResult): void {
    const nextState = result.to ?? item.state
    const patch: BotItemPatch = { ...result.patch }
    if (nextState !== item.state) patch.state = nextState
    store.finishStep(step.id, {
      status: 'done',
      ...(result.output === undefined ? {} : { output: result.output }),
      patch,
    })
  }

  function reportUnavailable(bot: BotRecord, item: BotItemRecord, step: BotStepRecord): void {
    const key = `${item.id}:${step.kind}`
    if (unavailableLogged.has(key)) return
    unavailableLogged.add(key)
    store.markStepStatus(step.id, 'unknown')
    store.appendLog({
      botId: bot.id,
      itemId: item.id,
      level: 'warn',
      code: 'step.unavailable',
      message: `step ${step.kind} has no handler in this stage; item left in ${item.state}`,
    })
  }

  function failStep(bot: BotRecord, item: BotItemRecord, step: BotStepRecord, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    // A failure while the item is in a lane state parks it in the same
    // transaction that releases the lane, so a stuck handler can never leave the
    // project's lane held forever.
    store.finishStep(step.id, {
      status: 'failed',
      error: message,
      ...(requiresDeliveryLane(item.state)
        ? { patch: { state: 'parked' as BotItemState, parkedFrom: item.state, question: message } }
        : {}),
    })
    log?.('warn', `bot ${bot.id} step ${step.kind} failed for item ${item.id}`)
    store.appendLog({
      botId: bot.id,
      itemId: item.id,
      level: 'error',
      code: 'step.failed',
      message: `${step.kind} failed: ${message}`,
    })
    store.appendLog({
      botId: bot.id,
      itemId: item.id,
      level: 'error',
      code: 'escalation',
      message: `escalation: ${step.kind} failed for item ${item.id} (${message})`,
    })
  }

  /**
   * Run one real effect. The step is marked started in its own transaction
   * immediately before the effect runs, so a restart can tell a step that never
   * ran from one that may already be in flight.
   */
  async function runEffect(step: BotStepRecord, context: BotStepContext, handler: BotStepHandler): Promise<BotStepResult> {
    store.markStepStarted(step.id)
    return await handler.run(context)
  }

  async function runStep(bot: BotRecord, step: BotStepRecord): Promise<void> {
    const context = itemContext(bot, step)
    const handler = handlers[step.kind]
    if (handler === undefined) {
      reportUnavailable(bot, context.item, step)
      return
    }
    if (canRun?.() === false) return
    if (!laneHeld(context.item)) {
      // A lane-state item must already hold its lane; otherwise it is parked for
      // a user decision instead of running an effect without the lane. The step
      // becomes unknown so it is never re-run automatically.
      store.markStepStatus(step.id, 'unknown')
      store.appendLog({
        botId: bot.id,
        itemId: context.item.id,
        level: 'warn',
        code: 'lane.missing',
        message: `item ${context.item.id} is in ${context.item.state} without holding the ${context.item.project} lane; parking`,
      })
      store.transitionItem(context.item.id, 'parked', {
        parkedFrom: context.item.state,
        question: `item lost its project delivery lane while in ${context.item.state}`,
      })
      return
    }
    try {
      const result = handler.sideEffect === true && context.dryRun
        ? (handler.dryRun?.(context) ?? { output: { dryRun: true, wouldRun: step.kind } })
        : await runEffect(step, context, handler)
      commitStep(context.item, step, await result)
    } catch (error) {
      if (error instanceof BotLaneBusyError) {
        // The lane is busy: leave the step pending so the next tick retries it.
        store.appendLog({
          botId: bot.id,
          itemId: context.item.id,
          level: 'info',
          code: 'lane.busy',
          message: `project ${error.project} is delivering another item`,
        })
        return
      }
      failStep(bot, context.item, step, error)
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Resolve every pending step of one bot by probe; never replays blindly. */
  async function reconcileBot(bot: BotRecord): Promise<void> {
    for (const step of store.listPendingSteps(bot.id)) {
      const item = store.getItem(bot.id, step.itemId)
      const context: BotStepContext = { bot, item, step, dryRun: bot.mode === 'dryRun' || item.dryRun }
      // Only a step whose effect may already be in flight is probed. A pending
      // step that never started is still queued and is run normally by the tick.
      if (step.startedAt === undefined) continue
      const handler = handlers[step.kind]
      if (handler === undefined) {
        reportUnavailable(bot, item, step)
        continue
      }
      if (handler.probe === undefined) {
        store.markStepStatus(step.id, 'unknown')
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'warn',
          code: 'step.unprobeable',
          message: `pending ${step.kind} cannot be probed; marked unknown and never re-run`,
        })
        continue
      }
      let probe: BotStepProbe
      try {
        probe = await handler.probe(context)
      } catch {
        probe = 'unavailable'
      }
      const outcome = classifyStepProbe(probe)
      if (outcome === 'retry') continue
      if (outcome === 'unknown') {
        store.markStepStatus(step.id, 'unknown')
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'warn',
          code: 'step.unknown',
          message: `pending ${step.kind} could not be proven done or not done; marked unknown`,
        })
        continue
      }
      store.markStepStatus(step.id, 'done')
      if (handler.doneState !== undefined && handler.doneState !== item.state) {
        try {
          store.transitionItem(item.id, handler.doneState)
        } catch (error) {
          store.appendLog({
            botId: bot.id,
            itemId: item.id,
            level: 'warn',
            code: 'step.reconcile.state',
            message: `proven-done ${step.kind} could not advance item: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'info',
        code: 'step.reconciled',
        message: `pending ${step.kind} was already complete; journal updated`,
      })
    }
  }

  async function reconcileAll(): Promise<void> {
    for (const bot of store.listBots()) {
      if (bot.state !== 'running') continue
      await reconcileBot(bot)
    }
  }

  /** The bots one pass advances: every stored bot, or just the named one. */
  function tickTargets(botId?: string): BotRecord[] {
    return botId === undefined ? store.listBots() : [store.getBot(botId)]
  }

  /**
   * One tick pass: advance the pending steps of the running bots. Every tick
   * path (timer, start, public `bot.tick`) runs through {@link scheduleTick}, so
   * two passes are never in flight at once and each pass re-checks `stopped` and
   * the admission gate.
   */
  async function tickPass(scheduledAt?: number, botId?: string): Promise<void> {
    if (stopped || canRun?.() === false) return
    const tickStartedAt = Date.now()
    if (scheduledAt !== undefined) {
      lastTickLagMs = Math.max(0, tickStartedAt - scheduledAt)
      maxTickLagMs = Math.max(maxTickLagMs, lastTickLagMs)
    }
    for (const bot of tickTargets(botId)) {
      if (stopped) return
      // A paused or stopped bot starts no new step; its items keep their state.
      if (bot.state !== 'running') {
        if (botId !== undefined) {
          store.appendLog({
            botId: bot.id,
            level: 'info',
            code: 'tick.skipped',
            message: `bot ${bot.id} is ${bot.state}; it starts no new step`,
          })
        }
        continue
      }
      for (const step of store.listPendingSteps(bot.id)) {
        if (stopped) return
        await runStep(bot, step)
      }
      store.updateBot(bot.id, {
        lastTickAt: nowIso(),
        nextPollAt: bot.nextPollAt ?? new Date(tickStartedAt + pollMs).toISOString(),
      })
    }
    lastTickAt = nowIso()
    tickCount += 1
  }

  async function prepareHost(): Promise<void> {
    if (stopped || prepared) return
    prepared = true
  }

  async function start(): Promise<void> {
    if (stopped) return
    startedAt = nowIso()
    await prepareHost()
    if (stopped) return
    // Reconcile once before any new work: a step that was in flight when the
    // previous process ended is probed, never repeated.
    await reconcileAll()
    if (stopped) return
    nextTickAt = Date.now() + tickMs
    timer = setInterval(() => {
      const scheduled = nextTickAt
      nextTickAt += tickMs
      void scheduleTick(() => tickPass(scheduled))
    }, tickMs)
    timer.unref()
    await scheduleTick(() => tickPass())
    log?.('info', `bot host started for ${workspaceRoot} (tick every ${tickMs} ms)`)
  }

  return {
    store,
    get ticking(): boolean { return inFlightTicks > 0 },
    prepare: prepareHost,
    start,
    stop(): void {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
    // The store persists synchronously through better-sqlite3, so there is no
    // queued write to await; the method exists so the host mirrors the
    // scheduler's lifecycle exactly.
    async flush(): Promise<void> {},
    reconcile: reconcileAll,
    tick(botId?: string): Promise<void> {
      if (stopped) return Promise.resolve()
      return scheduleTick(() => tickPass(undefined, botId))
    },
    async health(botId: string): Promise<BotHealth> {
      const bot = store.getBot(botId)
      const counters = store.healthCounters(botId)
      return {
        uptimeSince: startedAt,
        ticks: tickCount,
        ...(bot.lastTickAt === undefined ? {} : { lastTickAt: bot.lastTickAt }),
        tickLagMs: { last: lastTickLagMs, max: maxTickLagMs },
        itemsByState: counters.itemsByState,
        stepsFailed24h: counters.stepsFailed24h,
        adapterErrors24h: counters.adapterErrors24h,
        escalations24h: counters.escalations24h,
        ...(counters.lastError === undefined ? {} : { lastError: counters.lastError }),
        host: resolveHostIdentity(),
        components: await listComponents(),
      }
    },
    control(botId: string, action): BotRecord {
      const next = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running'
      const updated = store.updateBot(botId, { state: next })
      store.appendLog({
        botId,
        level: 'info',
        code: 'bot.control',
        message: `bot ${botId} ${action} -> ${next}`,
      })
      return updated
    },
    async validateConfig(configPath: string): Promise<BotConfigValidateResult> {
      const botsDir = join(resolveWrenyardConfigRoot(), 'bots')
      const resolved = resolve(configPath)
      if (resolved !== botsDir && !resolved.startsWith(`${botsDir}${sep}`)) {
        return { valid: false, error: 'config path must live in the config home bots/ directory' }
      }
      try {
        const parsed = JSON.parse(await readFile(resolved, 'utf-8')) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { valid: false, error: 'config must be a JSON object' }
        }
        const name = (parsed as { name?: unknown }).name
        if (typeof name !== 'string' || name.trim() === '') {
          return { valid: false, error: 'config is missing a name' }
        }
        return { valid: true, name: name.trim() }
      } catch (error) {
        return { valid: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async itemAction(botId, itemId, action, answer): Promise<BotItemRecord> {
      const item = store.getItem(botId, itemId)
      if (action === 'retry') return store.transitionItem(itemId, 'discovered', { error: null })
      if (action === 'dismiss') return store.transitionItem(itemId, 'dismissed')
      if (action === 'answer') {
        if (item.state !== 'parked' || item.parkedFrom === undefined) {
          throw new Error(`item ${itemId} is not parked on a decision`)
        }
        if (answer === undefined || answer.trim() === '') throw new Error('an answer is required')
        const resumed = store.transitionItem(itemId, item.parkedFrom, {
          answer: answer.trim(),
          question: null,
        })
        store.appendLog({
          botId,
          itemId,
          level: 'info',
          code: 'item.answered',
          message: `item ${itemId} resumed into ${resumed.state}`,
        })
        return resumed
      }
      // cleanup: an explicit request to remove the worktree and the item rows.
      if (!['completed', 'dismissed', 'failed', 'withdrawn'].includes(item.state)) {
        throw new Error(`item ${itemId} must be terminal before cleanup (it is ${item.state})`)
      }
      if (item.worktreeId !== undefined) {
        const removed = projectManager.removeWorktree(item.worktreeId)
        if (!removed.removed) {
          throw new Error(`worktree ${item.worktreeId} could not be removed: ${removed.error ?? 'unknown'}`)
        }
      }
      store.deleteItem(itemId)
      store.appendLog({
        botId,
        itemId,
        level: 'info',
        code: 'item.cleaned',
        message: `item ${itemId} cleaned up (session and branch left intact)`,
      })
      return item
    },
  }
}

function sameModel(left: BotModel, right: BotModel): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/** The generic dispatch brief: the request, the rules and the idempotency marker. */
function defaultBrief(item: BotItemRecord, step: BotStepRecord): string {
  return [
    `Bot item ${item.id}${item.title === undefined ? '' : `: ${item.title}`}`,
    ...(item.body === undefined ? [] : [`Request:\n${item.body}`]),
    ...(item.project === undefined ? [] : [`Project: ${item.project}`]),
    [
      'Rules: keep the diff minimal; add no tests unless they are needed;',
      'commit locally in this worktree; never merge, push, tag or release;',
      'end with `BOT-READY <head sha>` when done or `BOT-BLOCKED <question>`.',
    ].join(' '),
    `[bot:${step.idemKey}]`,
  ].join('\n\n')
}
