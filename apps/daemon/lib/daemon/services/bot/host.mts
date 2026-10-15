import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
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
import {
  botConfigHash,
  isInQuietHours,
  resolveBotConfigPath,
  validateBotConfig,
  type BotAdapter,
  type BotConfig,
} from './config.mts'
import {
  BotAdapterError,
  createInboxClient,
  createNotifier,
  describeAdapter,
  itemFingerprint,
  type BotAdapterDescription,
  type InboxClient,
  type InboxItem,
} from './adapters.mts'
import {
  isTerminalItemState,
  requiresDeliveryLane,
  type BotItemState,
  type BotStepKind,
} from './machine.mts'
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
 * The host also owns the user-local integrations: each running bot's config is
 * loaded and cached by content hash, its inbox is polled on cadence, and its
 * items are admitted, watched for withdrawal or change and delivered through
 * the inbox.complete and notify steps. Every adapter call is bounded by a
 * timeout and logged with safe metadata only.
 *
 * The host never restarts, upgrades or reinstalls the app or daemon it runs in.
 */

/** Diagnostic sink; wired to the daemon log by the caller. */
export type BotLog = (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void

/** How often the host advances items and runs its watchdogs. */
const DEFAULT_TICK_MS = 60_000
/** How often an inbox poll is due when adapters exist. */
const DEFAULT_POLL_MS = 10 * 60_000
/** Ceiling the poll interval backs off to after repeated adapter failures. */
const MAX_POLL_BACKOFF_MS = 60 * 60_000
const DAY_MS = 24 * 60 * 60 * 1_000
/** Consecutive adapter failures before one escalation is raised. */
const ADAPTER_ERROR_ESCALATION_THRESHOLD = 3
/** Failed steps for one item before one escalation is raised. */
const ITEM_FAILURE_ESCALATION_THRESHOLD = 3
/** Minimum spacing between two escalation notifications. */
const ESCALATION_MIN_INTERVAL_MS = 10 * 60_000
/**
 * States whose source is watched after a successful poll (§5.5): an item that
 * is being worked on or is parked for the user. `discovered`/`verifying` items
 * are only snapshots, so their text is refreshed instead of parked.
 */
const IN_FLIGHT_ITEM_STATES: readonly BotItemState[] = [
  'verified',
  'dispatched',
  'in_progress',
  'ready',
  'accepting',
  'accepted',
  'rejected',
  'merging',
  'merged',
  'completing',
]

export interface BotStepContext {
  bot: BotRecord
  item: BotItemRecord
  step: BotStepRecord
  /** Effective config when the bot has a usable one; absent otherwise. */
  config?: BotConfig
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
  /** Run one tick now (all running bots, or just one); a named bot also polls. */
  tick(botId?: string): Promise<void>
  health(botId: string): Promise<BotHealth>
  control(botId: string, action: 'start' | 'pause' | 'resume' | 'stop'): BotRecord
  validateConfig(configPath: string): Promise<BotConfigValidateResult>
  itemAction(botId: string, itemId: string, action: 'retry' | 'dismiss' | 'answer' | 'cleanup', answer?: string): Promise<BotItemRecord>
}

/**
 * The outcome of reading one bot's config file:
 * - `none`: no config path bound, so the bot has no adapters and no policies.
 * - `invalid`: a bound config that could not be read or parsed; the pass is
 *   skipped so no step runs with unknown policies.
 * - `ready`: the validated, default-applied config.
 */
type BotConfigLoad =
  | { status: 'none' }
  | { status: 'invalid' }
  | { status: 'ready'; config: BotConfig }

/** Result of checking whether an item's source is still the one it was sent. */
type SourceGate = 'open' | 'changed' | 'gone' | 'retry' | 'unavailable'

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
  /** Validated config per bot, keyed by content hash so an unchanged file is not re-parsed. */
  const configCache = new Map<string, { hash: string; config: BotConfig }>()
  /** Config problems already logged, keyed by hash (or path), so one bad file logs once. */
  const loggedConfigIssues = new Set<string>()
  /** Current poll delay per bot; doubles on an adapter failure and resets on success. */
  const pollBackoff = new Map<string, number>()
  /** Consecutive adapter failures per bot, for the escalation threshold. */
  const adapterErrorStreak = new Map<string, number>()
  /** Failed steps per item, for the escalation threshold. */
  const itemFailures = new Map<string, number>()
  /** Conditions already escalated, so one condition notifies once. */
  const escalatedConditions = new Set<string>()
  /** Epoch ms of the last escalation, so notifications are rate-limited. */
  let lastEscalationAt = 0
  /** Notifications already logged as deferred, so quiet hours do not spam the log. */
  const deferredNotifyLogged = new Set<string>()
  /** Parked items already reported as changed, keyed by item and fingerprint. */
  const sourceChangedLogged = new Set<string>()

  function nowIso(): string {
    return new Date().toISOString()
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
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

  // ── configuration ────────────────────────────────────────────────────────

  /**
   * Load one bot's user-local config, cached by content hash. An unreadable or
   * invalid file is reported once per hash (never with file contents) and the
   * caller skips that bot's pass rather than running steps with unknown policy.
   */
  async function loadConfigForBot(bot: BotRecord): Promise<BotConfigLoad> {
    const boundPath = bot.configPath?.trim()
    if (boundPath === undefined || boundPath === '') return { status: 'none' }
    let resolved: string
    try {
      resolved = resolveBotConfigPath(boundPath)
    } catch {
      logConfigIssueOnce(bot, `path:${boundPath}`, 'bot config path is outside the config home bots/ directory')
      return { status: 'invalid' }
    }
    let text: string
    try {
      text = await readFile(resolved, 'utf-8')
    } catch {
      logConfigIssueOnce(bot, `read:${resolved}`, 'bot config file could not be read')
      return { status: 'invalid' }
    }
    const hash = botConfigHash(text)
    const cached = configCache.get(bot.id)
    if (cached !== undefined && cached.hash === hash) return { status: 'ready', config: cached.config }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      logConfigIssueOnce(bot, `invalid:${hash}`, 'bot config is not valid JSON')
      return { status: 'invalid' }
    }
    const validation = validateBotConfig(parsed)
    if (!validation.ok) {
      logConfigIssueOnce(bot, `invalid:${hash}`, `bot config is invalid: ${validation.issues.join('; ')}`)
      return { status: 'invalid' }
    }
    configCache.set(bot.id, { hash, config: validation.config })
    if (bot.configHash !== hash) store.updateBot(bot.id, { configHash: hash })
    return { status: 'ready', config: validation.config }
  }

  function logConfigIssueOnce(bot: BotRecord, key: string, message: string): void {
    if (loggedConfigIssues.has(key)) return
    loggedConfigIssues.add(key)
    store.appendLog({ botId: bot.id, level: 'warn', code: 'config.invalid', message })
    log?.('warn', `bot ${bot.id}: ${message}`)
  }

  /** True when notifications must be held because quiet hours are active. */
  function shouldDefer(config: BotConfig, action: string): boolean {
    const quiet = config.quietHours
    if (quiet === undefined || !quiet.defer.includes(action)) return false
    try {
      return isInQuietHours(quiet, new Date())
    } catch {
      return false
    }
  }

  /** Log-safe adapter label: the executable base name or the MCP tool. */
  function adapterLabel(adapter: BotAdapter): string {
    const description: BotAdapterDescription = describeAdapter(adapter)
    return description.kind === 'mcp' ? `mcp:${description.tool}` : `command:${description.command}`
  }

  // ── escalation ───────────────────────────────────────────────────────────

  function resetAdapterErrors(botId: string): void {
    adapterErrorStreak.delete(botId)
  }

  /**
   * Record one adapter failure with safe metadata only (op and error code, never
   * the request, response, argv or environment), and escalate once the failure
   * streak reaches the threshold.
   */
  function recordAdapterError(bot: BotRecord, config: BotConfig | undefined, adapter: BotAdapter, op: string, error: unknown): void {
    const streak = (adapterErrorStreak.get(bot.id) ?? 0) + 1
    adapterErrorStreak.set(bot.id, streak)
    const code = error instanceof BotAdapterError ? error.code : 'adapter.error'
    store.appendLog({
      botId: bot.id,
      level: 'error',
      code: 'adapter.error',
      message: `adapter ${adapterLabel(adapter)} ${op} failed (${code})`,
    })
    if (streak >= ADAPTER_ERROR_ESCALATION_THRESHOLD) {
      void escalate(bot, config, `adapter:${bot.id}`, `adapter ${adapterLabel(adapter)} failed ${streak} times in a row`)
    }
  }

  /**
   * Raise one escalation: recorded in the log (which feeds `escalations24h` and
   * the Bot page) and, in live mode outside quiet hours, sent through the
   * notifier. One notifier message per new condition, rate-limited.
   */
  async function escalate(bot: BotRecord, config: BotConfig | undefined, key: string, message: string): Promise<void> {
    if (escalatedConditions.has(key)) return
    const nowMs = Date.now()
    if (nowMs - lastEscalationAt < ESCALATION_MIN_INTERVAL_MS) return
    escalatedConditions.add(key)
    lastEscalationAt = nowMs
    store.appendLog({ botId: bot.id, level: 'error', code: 'escalation', message })
    log?.('warn', `bot ${bot.id} escalation: ${message}`)
    if (config === undefined) return
    if (bot.mode === 'dryRun' || config.mode === 'dryRun') {
      store.appendLog({ botId: bot.id, level: 'info', code: 'escalation.dry_run', message: 'dry run: escalation notification not sent' })
      return
    }
    if (shouldDefer(config, 'notify')) return
    try {
      await createNotifier(config.notifier).send({ text: message })
    } catch {
      store.appendLog({ botId: bot.id, level: 'warn', code: 'escalation.notify_failed', message: 'escalation notification could not be sent' })
    }
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

  /**
   * Complete the source item in the user's inbox. Like merge and push this is an
   * outward effect: dry-run only records what would have been completed, and the
   * caller gates it with `inbox.get` first (§5.5).
   */
  const inboxCompleteStep: BotStepHandler = {
    sideEffect: true,
    dryRun: ({ item }) => ({ output: { dryRun: true, wouldComplete: { sourceId: item.sourceId } } }),
    async run({ bot, item, config }) {
      if (config === undefined) throw new Error('bot config is unavailable for inbox.complete')
      const inbox = createInboxClient(config.inbox)
      try {
        const result = await inbox.complete(item.sourceId)
        if (!result.ok) throw new Error('inbox.complete was not confirmed')
        resetAdapterErrors(bot.id)
        return { output: { ok: true } }
      } catch (error) {
        recordAdapterError(bot, config, config.inbox, 'complete', error)
        throw error
      }
    },
  }

  /**
   * Notify the user with one message per item. It is an outward effect, so
   * dry-run records the would-be message, and quiet hours hold the step pending
   * until the window ends. A `completing` item becomes `completed` here, so
   * `completed` always means both completion and notification happened.
   */
  const notifyStep: BotStepHandler = {
    sideEffect: true,
    dryRun: ({ item }) => ({
      output: { dryRun: true, wouldNotify: buildNotificationText(item) },
      ...(item.state === 'completing' ? { to: 'completed' as BotItemState } : {}),
    }),
    async run({ bot, item, config }) {
      if (config === undefined) throw new Error('bot config is unavailable for notifications')
      const notifier = createNotifier(config.notifier)
      try {
        const result = await notifier.send({ text: buildNotificationText(item) })
        resetAdapterErrors(bot.id)
        return {
          output: { ok: result.ok, ...(result.messageId === undefined ? {} : { messageId: result.messageId }) },
          ...(item.state === 'completing' ? { to: 'completed' as BotItemState } : {}),
        }
      } catch (error) {
        recordAdapterError(bot, config, config.notifier, 'send', error)
        throw error
      }
    },
  }

  const handlers: Partial<Record<BotStepKind, BotStepHandler>> = {
    'lane.acquire': laneAcquire,
    'worktree.create': worktreeCreate,
    'session.create': sessionCreate,
    'session.send': sessionSend,
    merge: mergeStep,
    push: pushStep,
    'inbox.complete': inboxCompleteStep,
    notify: notifyStep,
  }

  // ── inbox polling and source checks ──────────────────────────────────────

  function pollDue(bot: BotRecord, nowMs: number): boolean {
    if (bot.nextPollAt === undefined) return true
    const due = Date.parse(bot.nextPollAt)
    return Number.isNaN(due) ? true : due <= nowMs
  }

  /** Schedule the next poll, backing off after a failure and resetting on success. */
  function scheduleNextPoll(bot: BotRecord, backOff: boolean): void {
    const current = pollBackoff.get(bot.id) ?? pollMs
    const next = backOff ? Math.min(current * 2, MAX_POLL_BACKOFF_MS) : pollMs
    pollBackoff.set(bot.id, next)
    store.updateBot(bot.id, { nextPollAt: new Date(Date.now() + next).toISOString() })
  }

  /** Map an inbox project hint onto a configured project id, or undefined. */
  function mapProject(config: BotConfig, hint: string | undefined): string | undefined {
    const trimmed = hint?.trim()
    if (trimmed === undefined || trimmed === '') return undefined
    const policy = config.projects.find(project => project.id === trimmed || project.match.includes(trimmed))
    return policy?.id
  }

  /** True when this bot already admitted its daily budget of items. */
  function dailyLimitReached(bot: BotRecord, config: BotConfig): boolean {
    const since = new Date(Date.now() - DAY_MS).toISOString()
    const created = store.listItems(bot.id).filter(item => item.createdAt >= since).length
    return created >= config.budgets.maxItemsPerDay
  }

  /**
   * Fold one successful `inbox.list` into durable items: admit new sources
   * (deduplicated by source id, capped per pass and per day, mapped to a
   * configured project), reopen a changed terminal source as a new generation,
   * and park an in-flight item whose request changed.
   */
  function applyInboxSnapshot(bot: BotRecord, config: BotConfig, listed: readonly InboxItem[]): void {
    const dryRun = bot.mode === 'dryRun' || config.mode === 'dryRun'
    let admitted = 0
    for (const source of listed) {
      const fingerprint = itemFingerprint(source)
      const existing = store.findItemBySource(bot.id, source.id)
      if (existing === undefined) {
        if (admitted >= config.concurrency.maxDispatchPerTick) {
          store.appendLog({
            botId: bot.id,
            level: 'info',
            code: 'poll.admitted',
            message: `admitted ${admitted} new item(s) this poll; the rest wait for the next poll`,
          })
          break
        }
        if (dailyLimitReached(bot, config)) {
          store.appendLog({
            botId: bot.id,
            level: 'warn',
            code: 'poll.daily_limit',
            message: `daily item budget ${config.budgets.maxItemsPerDay} reached; no new item admitted`,
          })
          break
        }
        const project = mapProject(config, source.project)
        store.createItem({
          botId: bot.id,
          sourceId: source.id,
          generation: 1,
          fingerprint,
          title: source.title,
          ...(source.body === undefined ? {} : { body: source.body }),
          ...(project === undefined ? {} : { project }),
          state: 'discovered',
          ...(dryRun ? { dryRun: true } : {}),
        })
        admitted += 1
        store.appendLog({
          botId: bot.id,
          level: 'info',
          code: 'poll.discovered',
          message: `discovered source item ${source.id}${project === undefined ? ' (unmapped project)' : ''}`,
        })
        continue
      }

      if (isTerminalItemState(existing.state)) {
        // A source that is still open with a different fingerprint starts a new
        // generation; the terminal one keeps its history.
        if (existing.fingerprint !== fingerprint && !dailyLimitReached(bot, config)) {
          const generation = store.nextGeneration(bot.id, source.id)
          const project = mapProject(config, source.project)
          store.createItem({
            botId: bot.id,
            sourceId: source.id,
            generation,
            fingerprint,
            title: source.title,
            ...(source.body === undefined ? {} : { body: source.body }),
            ...(project === undefined ? {} : { project }),
            state: 'discovered',
            ...(dryRun ? { dryRun: true } : {}),
          })
          store.appendLog({
            botId: bot.id,
            level: 'info',
            code: 'poll.generation',
            message: `source item ${source.id} reopened as generation ${generation}`,
          })
        }
        continue
      }

      if (existing.fingerprint === undefined || existing.fingerprint === fingerprint) continue

      if (existing.state === 'parked') {
        const key = `changed:${existing.id}:${fingerprint}`
        if (sourceChangedLogged.has(key)) continue
        sourceChangedLogged.add(key)
        store.appendLog({
          botId: bot.id,
          itemId: existing.id,
          level: 'warn',
          code: 'source.changed',
          message: `source item ${existing.sourceId} changed while parked`,
        })
        continue
      }

      parkForSourceChange(bot, existing, source.title)
    }
  }

  /**
   * Confirm that every in-flight or parked item that is absent from the list is
   * really gone. `inbox.get` decides: an adapter error is retryable and is never
   * treated as a withdrawal.
   */
  async function confirmWithdrawals(bot: BotRecord, config: BotConfig, inbox: InboxClient, listed: readonly InboxItem[]): Promise<void> {
    const present = new Set(listed.map(item => item.id))
    for (const item of store.listItems(bot.id)) {
      if (isTerminalItemState(item.state)) continue
      if (item.state !== 'parked' && !IN_FLIGHT_ITEM_STATES.includes(item.state)) continue
      if (present.has(item.sourceId)) continue
      let fetched: (InboxItem & { open: boolean }) | null
      try {
        fetched = (await inbox.get(item.sourceId)).item
      } catch (error) {
        recordAdapterError(bot, config, config.inbox, 'get', error)
        continue
      }
      resetAdapterErrors(bot.id)
      if (fetched !== null && fetched.open === true) continue
      withdrawItem(bot, item, 'source item is no longer open in the inbox', config)
    }
  }

  /**
   * Poll the inbox on cadence (or on demand). A failed call is logged with safe
   * metadata and backs the poll off; a successful call re-checks the sources it
   * already admitted.
   */
  async function pollBot(bot: BotRecord, config: BotConfig, force: boolean): Promise<boolean> {
    if (!force && !pollDue(bot, Date.now())) return false
    const inbox = createInboxClient(config.inbox)
    let listed: InboxItem[]
    try {
      listed = (await inbox.list()).items
    } catch (error) {
      recordAdapterError(bot, config, config.inbox, 'list', error)
      scheduleNextPoll(bot, true)
      return true
    }
    resetAdapterErrors(bot.id)
    store.appendLog({
      botId: bot.id,
      level: 'info',
      code: 'poll.ok',
      message: `inbox poll returned ${listed.length} item(s) via ${adapterLabel(config.inbox)}`,
    })
    applyInboxSnapshot(bot, config, listed)
    await confirmWithdrawals(bot, config, inbox, listed)
    scheduleNextPoll(bot, false)
    return true
  }

  /**
   * Withdraw an item whose source disappeared or was completed elsewhere: no
   * merge, push or completion, the lane is released, the user is notified and
   * the session and worktree are left intact for inspection.
   */
  function withdrawItem(bot: BotRecord, item: BotItemRecord, reason: string, config: BotConfig | undefined): void {
    let withdrawn: BotItemRecord
    try {
      withdrawn = store.transitionItem(item.id, 'withdrawn', { error: reason })
    } catch (error) {
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'error',
        code: 'source.withdraw_failed',
        message: `could not withdraw item ${item.id}: ${errorMessage(error)}`,
      })
      return
    }
    cancelPendingSteps(bot, item.id)
    store.appendLog({
      botId: bot.id,
      itemId: item.id,
      level: 'warn',
      code: 'source.withdrawn',
      message: `item ${item.id} withdrawn: ${reason}`,
    })
    if (config !== undefined) enqueueStep(withdrawn, 'notify')
  }

  /** Park an in-flight item whose source text changed since it was dispatched. */
  function parkForSourceChange(bot: BotRecord, item: BotItemRecord, nextTitle: string | undefined): void {
    try {
      store.transitionItem(item.id, 'parked', {
        parkedFrom: item.state,
        question: `source changed: "${item.title ?? ''}" -> "${nextTitle ?? ''}"; answer 'continue' to use the new text or 'dismiss'`,
        error: 'source_changed',
      })
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'warn',
        code: 'source.changed',
        message: `item ${item.id} parked: the source item changed since it was dispatched`,
      })
    } catch (error) {
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'error',
        code: 'source.park_failed',
        message: `could not park item ${item.id}: ${errorMessage(error)}`,
      })
    }
  }

  /** Mark every still-pending step of one item unknown so nothing re-runs it. */
  function cancelPendingSteps(bot: BotRecord, itemId: string): void {
    for (const step of store.listPendingSteps(bot.id)) {
      if (step.itemId !== itemId) continue
      store.markStepStatus(step.id, 'unknown')
    }
  }

  /**
   * Ask the inbox whether an item's source is still open and unchanged. Runs
   * immediately before merge and before inbox.complete; an adapter error is
   * retryable, never a withdrawal.
   */
  async function gateSource(bot: BotRecord, config: BotConfig, item: BotItemRecord): Promise<SourceGate> {
    const inbox = createInboxClient(config.inbox)
    try {
      const fetched = (await inbox.get(item.sourceId)).item
      if (fetched === null || fetched.open !== true) return 'gone'
      if (item.fingerprint !== undefined && itemFingerprint(fetched) !== item.fingerprint) return 'changed'
      resetAdapterErrors(bot.id)
      return 'open'
    } catch (error) {
      recordAdapterError(bot, config, config.inbox, 'get', error)
      return 'retry'
    }
  }

  // ── step scheduling ──────────────────────────────────────────────────────

  function idemKeyFor(item: BotItemRecord, kind: BotStepKind, attempt = 1): string {
    return `${item.id}:${item.generation}:${kind}:${attempt}`
  }

  /** Insert one pending step unless its idempotency key already exists. */
  function enqueueStep(item: BotItemRecord, kind: BotStepKind, patch?: BotItemPatch): BotStepRecord | undefined {
    const idemKey = idemKeyFor(item, kind)
    if (store.findStepByIdemKey(idemKey) !== undefined) return undefined
    const { step } = store.beginStep({
      itemId: item.id,
      kind,
      idemKey,
      ...(patch === undefined ? {} : { patch }),
    })
    return step
  }

  /**
   * Enqueue the next step of an item that is waiting for one: merge after
   * acceptance, push after merge, then inbox.complete and notify in
   * `completing`, so a pushed item always reaches `completed`.
   */
  function advanceItem(bot: BotRecord, item: BotItemRecord): void {
    if (isTerminalItemState(item.state)) return
    if (item.state === 'merging') {
      enqueueStep(item, 'merge')
      return
    }
    if (item.state === 'merged') {
      enqueueStep(item, 'push')
      return
    }
    if (item.state !== 'completing') return
    const complete = store.findStepByIdemKey(idemKeyFor(item, 'inbox.complete'))
    if (complete === undefined) {
      enqueueStep(item, 'inbox.complete')
      return
    }
    if (complete.status === 'done') enqueueStep(item, 'notify')
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

  async function failStep(bot: BotRecord, item: BotItemRecord, step: BotStepRecord, error: unknown, config: BotConfig | undefined): Promise<void> {
    const message = errorMessage(error)
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
    const failures = (itemFailures.get(item.id) ?? 0) + 1
    itemFailures.set(item.id, failures)
    if (failures >= ITEM_FAILURE_ESCALATION_THRESHOLD) {
      await escalate(bot, config, `item-failures:${item.id}`, `item ${item.id} failed ${failures} steps`)
    }
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

  async function runStep(bot: BotRecord, step: BotStepRecord, config: BotConfig | undefined): Promise<void> {
    const item = store.getItem(bot.id, step.itemId)
    if (isTerminalItemState(item.state)) {
      // A step of a resolved item (for example after a withdrawal cancelled its
      // siblings) is never re-run.
      store.markStepStatus(step.id, 'unknown')
      return
    }
    const handler = handlers[step.kind]
    if (handler === undefined) {
      reportUnavailable(bot, item, step)
      return
    }
    if (canRun?.() === false) return
    if (!laneHeld(item)) {
      // A lane-state item must already hold its lane; otherwise it is parked for
      // a user decision instead of running an effect without the lane. The step
      // becomes unknown so it is never re-run automatically.
      store.markStepStatus(step.id, 'unknown')
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'warn',
        code: 'lane.missing',
        message: `item ${item.id} is in ${item.state} without holding the ${item.project} lane; parking`,
      })
      store.transitionItem(item.id, 'parked', {
        parkedFrom: item.state,
        question: `item lost its project delivery lane while in ${item.state}`,
      })
      return
    }

    // Source gate: never merge or complete an item whose source was withdrawn or
    // changed. An adapter error leaves the step pending for a later tick.
    if (step.kind === 'merge' || step.kind === 'inbox.complete') {
      if (config !== undefined) {
        const gate = await gateSource(bot, config, item)
        if (gate === 'retry') return
        if (gate === 'gone') {
          withdrawItem(bot, item, `source item is no longer open in the inbox (before ${step.kind})`, config)
          return
        }
        if (gate === 'changed') {
          parkForSourceChange(bot, item, undefined)
          return
        }
      }
    }

    // Quiet hours: hold a notification until the window ends by leaving the step
    // pending, so it is sent afterwards exactly once.
    if (step.kind === 'notify' && config !== undefined && shouldDefer(config, 'notify')) {
      if (!deferredNotifyLogged.has(step.id)) {
        deferredNotifyLogged.add(step.id)
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'notify.deferred',
          message: 'notification deferred during quiet hours',
        })
      }
      return
    }

    const context: BotStepContext = {
      bot,
      item,
      step,
      ...(config === undefined ? {} : { config }),
      dryRun: bot.mode === 'dryRun' || config?.mode === 'dryRun' || item.dryRun,
    }
    try {
      const result = handler.sideEffect === true && context.dryRun
        ? (handler.dryRun?.(context) ?? { output: { dryRun: true, wouldRun: step.kind } })
        : await runEffect(step, context, handler)
      commitStep(item, step, await result)
    } catch (error) {
      if (error instanceof BotLaneBusyError) {
        // The lane is busy: leave the step pending so the next tick retries it.
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'lane.busy',
          message: `project ${error.project} is delivering another item`,
        })
        return
      }
      await failStep(bot, item, step, error, config)
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Resolve every pending step of one bot by probe; never replays blindly. */
  async function reconcileBot(bot: BotRecord): Promise<void> {
    for (const step of store.listPendingSteps(bot.id)) {
      const item = store.getItem(bot.id, step.itemId)
      if (isTerminalItemState(item.state)) {
        store.markStepStatus(step.id, 'unknown')
        continue
      }
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
            message: `proven-done ${step.kind} could not advance item: ${errorMessage(error)}`,
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
   * One tick pass: poll due inboxes, watch the sources already admitted, advance
   * items whose next step is due, then run the pending steps. Every tick path
   * (timer, start, public `bot.tick`) runs through {@link scheduleTick}, so two
   * passes are never in flight at once and each pass re-checks `stopped` and the
   * admission gate.
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
      const load = await loadConfigForBot(bot)
      if (load.status === 'invalid') continue
      const config = load.status === 'ready' ? load.config : undefined
      // A named `bot.tick` forces a poll; the timer polls only when it is due.
      const polled = config === undefined ? false : await pollBot(bot, config, botId !== undefined)
      if (stopped) return
      for (const item of store.listItems(bot.id)) {
        if (stopped) return
        advanceItem(bot, item)
      }
      for (const step of store.listPendingSteps(bot.id)) {
        if (stopped) return
        await runStep(bot, step, config)
      }
      const fresh = store.getBot(bot.id)
      store.updateBot(bot.id, {
        lastTickAt: nowIso(),
        ...(polled || fresh.nextPollAt !== undefined
          ? {}
          : { nextPollAt: new Date(tickStartedAt + pollMs).toISOString() }),
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
      let resolved: string
      try {
        resolved = resolveBotConfigPath(configPath)
      } catch (error) {
        return { valid: false, error: errorMessage(error) }
      }
      let text: string
      try {
        text = await readFile(resolved, 'utf-8')
      } catch {
        return { valid: false, error: 'bot config file could not be read' }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        return { valid: false, error: 'bot config is not valid JSON' }
      }
      const validation = validateBotConfig(parsed)
      if (!validation.ok) return { valid: false, error: validation.issues.join('; ') }
      return { valid: true, name: validation.config.name }
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

/** The one user-facing message per item: outcome, merge, checks and gaps. */
function buildNotificationText(item: BotItemRecord): string {
  const lines: string[] = []
  lines.push(`Bot item ${item.id}${item.title === undefined ? '' : `: ${item.title}`}`)
  lines.push(`State: ${item.state}`)
  if (item.project !== undefined) lines.push(`Project: ${item.project}`)
  if (item.mergedSha !== undefined) lines.push(`Merged commit: ${item.mergedSha}`)
  if (item.worktreeId !== undefined) lines.push(`Worktree: ${item.worktreeId}`)
  if (item.error !== undefined) lines.push(`Reason: ${item.error}`)
  if (item.acceptance !== undefined && item.acceptance.length > 0) {
    const verified = item.acceptance.filter(check => check.status === 'verified').map(check => check.claim)
    const notVerified = item.acceptance
      .filter(check => check.status !== 'verified')
      .map(check => `${check.claim} (${check.status})`)
    if (verified.length > 0) lines.push(`Verified: ${verified.join('; ')}`)
    lines.push(notVerified.length > 0 ? `Not verified: ${notVerified.join('; ')}` : 'Not verified: none')
  }
  return lines.join('\n')
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
