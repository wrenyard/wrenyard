import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import type { Session } from '@wrenyard/session'
import { foremanStateRoot } from '../../../config/state.mts'
import { ProjectManager } from '../../../core/project/manager.mts'
import { runGitSync } from '../../../core/vcs/index.mts'
import type { ForemanDatabase } from '../../../db/types.mts'
import type {
  BotAcceptanceCheck,
  BotConfigValidateResult,
  BotHealth,
  BotHealthComponent,
  BotHealthHost,
  BotItemRecord,
  BotModel,
  BotRecord,
} from '../../../protocol/methods/bot.mts'
import { redactString } from '../../execution/redaction.mts'
import type { OperationComponentId, OperationComponents } from '../operation-components.mts'
import { WorkspaceTodoError, WorkspaceTodoService, todoIndexPath, type TodoStatus } from '../workspace-todo-service.mts'
import {
  DEFAULT_BOT_WATCHDOGS,
  botConfigHash,
  isInQuietHours,
  resolveBotConfigPath,
  validateBotConfig,
  type BotAdapter,
  type BotConfig,
  type BotRoutingEntry,
  type BotWatchdogs,
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

/**
 * Per-bot tick cadence used when a bot has no usable config; a config's
 * `cadence.tickSeconds` (default 60 s) overrides it.
 */
const DEFAULT_TICK_MS = 60_000
/**
 * Smallest tick cadence a bot config may ask for, and therefore the interval of
 * the single host timer: each bot is only advanced once its own cadence has
 * elapsed since its last cadence pass.
 */
const MIN_TICK_MS = 10_000
/** Fallback inbox poll cadence for a bot whose config sets no poll interval. */
const DEFAULT_POLL_MS = 10 * 60_000
/** Ceiling the poll interval backs off to after repeated adapter failures. */
const MAX_POLL_BACKOFF_MS = 60 * 60_000
/**
 * Minimum spacing between two `bot.tick`-forced inbox polls for one bot. A
 * forced poll inside this window is skipped and the pass falls back to the
 * cadence, so a client that ticks on its own schedule cannot flood the log or
 * hammer the adapter.
 */
const FORCED_POLL_MIN_INTERVAL_MS = 30_000
/** Rate limit for the one debug row that reports a run of unchanged polls. */
const UNCHANGED_POLL_LOG_INTERVAL_MS = 60 * 60_000
const DAY_MS = 24 * 60 * 60 * 1_000
/** Consecutive adapter failures before one escalation is raised. */
const ADAPTER_ERROR_ESCALATION_THRESHOLD = 3
/** Failed steps for one item before one escalation is raised. */
const ITEM_FAILURE_ESCALATION_THRESHOLD = 3
/** Acceptance attempts (rebases) allowed when a bot config has no budget. */
const DEFAULT_MAX_ACCEPTANCE_ATTEMPTS = 2
/** Minimum spacing between two escalation notifications. */
const ESCALATION_MIN_INTERVAL_MS = 10 * 60_000
/**
 * Idle window after which an unchanged session is reviewed anyway, so a stalled
 * session is noticed instead of waiting forever for new events.
 */
const REVIEW_IDLE_MS = 10 * 60_000
/**
 * Reason an item is parked because its session finished a turn without
 * `BOT-READY` or `BOT-BLOCKED` and its correction budget is exhausted.
 */
const STALLED_REASON = 'session stalled'
/** Worktree diff sent to `bot-review`; the caller truncates to this. */
const MAX_DIFF_CHARS = 60_000
/** Recent replies sent to `bot-review`; the caller truncates to this. */
const MAX_TURNS_CHARS = 20_000
/** Upper bound when scanning prior attempts of a repeatable step kind. */
const MAX_STEP_ATTEMPTS = 500
/** Retained window of the `*Logged` dedupe sets, so a long-lived host stays bounded. */
const LOGGED_LIMIT = 1_024

/** A `Set` that keeps only the most recent {@link LOGGED_LIMIT} members (FIFO). */
class LoggedSet extends Set<string> {
  override add(value: string): this {
    super.add(value)
    if (this.size > LOGGED_LIMIT) {
      const oldest = this.values().next().value
      if (oldest !== undefined) this.delete(oldest)
    }
    return this
  }
}
/**
 * Step kinds whose effect is a detached task run, and the builtin task each one
 * uses. A tick starts the run and records its id; later ticks poll that run, so
 * no tick ever waits for a model run.
 */
const DETACHED_TASK_KIND: Partial<Record<BotStepKind, string>> = {
  verify: 'bot-verify',
  review: 'bot-review',
  accept: 'test',
}
/** The failure recorded when a detached run cannot be found any more. */
const TASK_RUN_MISSING = 'task run missing'
/** Longest error kept in a run-failure log line; the rest is dropped. */
const RUN_FAILURE_MAX_CHARS = 300
/**
 * Per-kind bookkeeping for a detached task run that ended without a result
 * (failed, cancelled, timeout, or a run that no longer exists). The counter
 * lives on the item; the code names the log line. Assessment results (a
 * finished run whose checks failed or could not be verified) keep their own
 * handling and never count here.
 */
const DETACHED_RUN_FAILURE: Partial<Record<BotStepKind, { counter: string; log: string }>> = {
  verify: { counter: 'verifyRunFailures', log: 'verify.run_failed' },
  review: { counter: 'reviewRunFailures', log: 'review.run_failed' },
  accept: { counter: 'acceptanceRunFailures', log: 'accept.run_failed' },
}
/** The `watchdogs.taskRunMinutes` budget each detached step kind is measured against. */
const TASK_RUN_MINUTES_KIND: Partial<Record<BotStepKind, keyof BotWatchdogs['taskRunMinutes']>> = {
  verify: 'verify',
  review: 'review',
  accept: 'accept',
}
/** A session's closing markers: a blocker question, or a finished-work head sha. */
const BOT_BLOCKED_PATTERN = /BOT-BLOCKED\s+(.+)/u
const BOT_READY_PATTERN = /BOT-READY\s+[0-9a-f]{7,40}/iu
/** Check surfaces and the operation component each one needs. */
const SURFACE_COMPONENT: Record<string, OperationComponentId | undefined> = {
  daemon: undefined,
  renderer: 'browser',
  native: 'desktop',
  static: undefined,
}
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
  /**
   * A detached task step that has only started its run: this is recorded on the
   * still-pending step (leaving its status alone) so a later tick polls the run
   * id instead of starting a second run.
   */
  pendingRun?: { runId: string }
}

/** What preparing a detached task step produced. */
export type BotStepPrepare =
  | { input: BotTaskRunInput }
  | { result: BotStepResult }

/** Outcome of one restart probe. */
export type BotStepProbe = 'done' | 'not-done' | 'unavailable'

/**
 * A live read of daemon execution load, taken from the supervisor or the
 * database directly. It drives the dispatch back-off and the load watchdog, so
 * it is never fetched over IPC. `oldestQueuedMs` is how long the oldest queued
 * execution has already waited.
 */
export interface BotLoadProbe {
  activeExecutions: number
  maxExecutions: number
  oldestQueuedMs?: number
  queuedExecutions: number
}

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
  /**
   * The whole effect of a non-detached step. A detached task step provides
   * {@link BotStepHandler.prepareTask} and {@link BotStepHandler.applyTaskResult}
   * instead.
   */
  run?: (context: BotStepContext) => Promise<BotStepResult>
  /**
   * Detached task steps (`verify`, `review`, `accept`): build the run input, or
   * short-circuit with a result that finishes the step without starting a task.
   * Called only on the tick that starts the run; later ticks poll it.
   */
  prepareTask?: (context: BotStepContext) => Promise<BotStepPrepare>
  /** Detached task steps: map a finished run's structured output onto the step. */
  applyTaskResult?: (context: BotStepContext, output: unknown) => Promise<BotStepResult>
}

/**
 * Per-bot tick bookkeeping reported by `bot.health`: `ticks` counts the timer
 * passes that actually advanced this bot, `forcedTicks` the passes a client
 * asked for with `bot.tick`, and the lag is measured against the bot's own due
 * time so one busy bot cannot distort another bot's numbers.
 */
export interface BotTickStats {
  ticks: number
  forcedTicks: number
  lastLagMs: number
  maxLagMs: number
}

export interface CreateBotHostOptions {
  lowDiskState?: () => BotHealth['lowDisk']
  db: ForemanDatabase
  /** The workspace root this host serves; another root's bots are never ticked. */
  workspaceRoot: string
  /** The session feature the host creates and drives sessions through. */
  session: Pick<Session, 'createSession' | 'listSessions' | 'send' | 'readLedger'>
  /** Project manager used for the worktree, merge and push steps. */
  projectManager?: ProjectManager
  /**
   * Host timer interval in milliseconds; defaults to the smallest cadence a
   * config may ask for ({@link MIN_TICK_MS}). The timer never advances a bot
   * before that bot's own `cadence.tickSeconds` has elapsed.
   */
  tickMs?: number
  /**
   * Fallback inbox poll cadence in milliseconds, used for a bot whose config
   * sets no `cadence.pollMinutes`; defaults to 10 min.
   */
  pollMs?: number
  /**
   * Clock the host reads for its cadence bookkeeping and tick lag; defaults to
   * `Date.now`. A test injects it to advance a cadence without waiting.
   */
  now?: () => number
  /**
   * Live daemon execution load, read from the supervisor or the database with
   * no IPC round trip. It backs off new dispatch and task starts while the
   * daemon is loaded and feeds the `load` watchdog. Absent means the host never
   * backs off on load.
   */
  loadProbe?: () => Promise<BotLoadProbe> | BotLoadProbe
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
   * Task runner port: starts one builtin task run bound to a project (and
   * optionally a managed worktree) and resolves with its terminal structured
   * output. Injected by the daemon; without it, judgment and acceptance steps
   * fail their step rather than guessing a result.
   */
  taskRunner?: BotTaskRunner
  /**
   * Operation component service backing `bot.health.components` and the
   * acceptance readiness check. `list` is read for health (never refreshing);
   * the acceptance step refreshes the components its plan requires with `act`.
   * When it is absent, health reports an empty list and acceptance that needs a
   * component parks instead of running.
   */
  operationComponents?: Pick<OperationComponents, 'list' | 'act'>
}

export interface BotHost {
  readonly store: BotStore
  /** Load and prepare without reconciling or arming the timer (hot-switch staging). */
  prepare(): Promise<void>
  /** Reconcile pending steps once, then tick on the host timer. */
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
/** Minimum spacing between follow-ups to a session whose last turn failed. */
const FAILED_TURN_RETRY_MS = 10 * 60_000

type SourceGate = 'open' | 'gone' | 'retry' | 'unavailable' | { changed: { title: string; body?: string }; fingerprint: string }

/**
 * One judgment or acceptance task run the host asks for. The bot never reasons
 * itself: every decision is a structured task run whose output it stores.
 */
export interface BotTaskRunInput {
  /** Builtin task id: `bot-verify`, `bot-review` or `test`. */
  task: string
  project: string
  /** Managed worktree the run is bound to; absent runs in the project checkout. */
  worktree?: string
  input: unknown
  /**
   * The routing model the bot chose for this run (the `judgment` triple for
   * `bot-verify`/`bot-review`, the `acceptance` triple for `test`). A caller
   * that cannot honor an explicit model uses automatic routing instead.
   */
  model?: BotModel
  /**
   * The routing entry's explicit canonical run target, when it has one. A
   * runner that honors it selects exactly that target; a target the daemon
   * cannot resolve fails the run instead of falling back to automatic routing.
   */
  target?: string
}

/** Terminal or still-in-flight outcome of one task run the host started. */
export interface BotTaskRunStatus {
  /**
   * `queued` is a run waiting for a host resource (the desktop operation lane)
   * before its execution starts; it is a waiting state, never a failure.
   */
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'unknown'
  output?: unknown
  error?: string
}

/**
 * Task runner port, split so a tick never waits for a model run: `startTask`
 * begins one builtin task run bound to a project (and optionally a managed
 * worktree) and returns its run id, and `getTask` reads that run's status
 * without blocking. Injected by the daemon; without it, judgment and acceptance
 * steps fail their step rather than guessing a result.
 */
export interface BotTaskRunner {
  startTask(input: BotTaskRunInput): Promise<{ runId: string } | { rejected: string }>
  getTask(runId: string): Promise<BotTaskRunStatus>
  /**
   * Cancel one in-flight run so a stuck task step stops consuming the daemon.
   * Optional: a runner without it leaves the stuck-task watchdog to escalate
   * only, and the run is not cancelled.
   */
  cancelTask?(runId: string): Promise<void>
}

/** Deterministic worktree id for one item: bot id + item id, 8 URL-safe chars. */
export function deterministicWorktreeId(botId: string, itemId: string): string {
  return createHash('sha1').update(`${botId}:${itemId}`).digest('base64url').slice(0, 8)
}

/** The durable owner one bot records on its item's worktree: `bot:<botId>/<itemId>`. */
function ownerForItem(bot: BotRecord, item: BotItemRecord): string {
  return `bot:${bot.id}/${item.id}`
}

export function createBotHost(options: CreateBotHostOptions): BotHost {
  const { db, workspaceRoot, session, log, canRun } = options
  const store = createBotStore({ db, workspaceRoot })
  const projectManager = options.projectManager ?? new ProjectManager({ workspaceRoot })
  // The native (`kind: 'workspace'`) inbox is backed by the workspace's own todo
  // files. It is built from this host's configured workspace root, so a native
  // inbox never accepts a caller-supplied path; the command (Things) and MCP
  // adapters are untouched and keep going through their own processes. Its index
  // is disposable and lives under the daemon local state root keyed by the
  // workspace, the same convention the daemon uses, never inside the workspace
  // tree or the runtime database.
  const workspaceTodoService = new WorkspaceTodoService(
    workspaceRoot,
    todoIndexPath(foremanStateRoot(), workspaceRoot),
  )
  const timerMs = options.tickMs ?? MIN_TICK_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const clock = options.now ?? Date.now

  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let prepared = false
  /** Ticks queued or running; the public `ticking` flag is true while it is > 0. */
  let inFlightTicks = 0
  /** Tail of the serialized tick chain; every tick path joins it, never races it. */
  let tickChain: Promise<void> = Promise.resolve()
  /** Epoch ms the next scheduled tick was due. */
  let nextTickAt = 0
  let startedAt = new Date().toISOString()
  /**
   * Epoch ms each bot was last advanced by a cadence pass. A `bot.tick` pass is
   * forced and does not touch this, so the counters keep measuring the host's
   * own tick instead of an eager client's.
   */
  const lastBotCadenceAt = new Map<string, number>()
  /** Per-bot cadence counters and lag, so health describes one bot. */
  const botTickStats = new Map<string, BotTickStats>()
  /** `itemId:kind` keys already reported as unavailable, so the log stays once-per-item. */
  const unavailableLogged = new LoggedSet()
  /** Validated config per bot, keyed by content hash so an unchanged file is not re-parsed. */
  const configCache = new Map<string, { hash: string; config: BotConfig }>()
  /** Config problems already logged, keyed by hash (or path), so one bad file logs once. */
  const loggedConfigIssues = new Set<string>()
  /** Current poll delay per bot; doubles on an adapter failure and resets on success. */
  const pollBackoff = new Map<string, number>()
  /** Epoch ms of the last `bot.tick`-forced poll per bot. */
  const forcedPollAt = new Map<string, number>()
  /** Source id -> fingerprint of the last successful poll per bot. */
  const pollSnapshots = new Map<string, Map<string, string>>()
  /** Current run of unchanged polls per bot, for the rate-limited debug row. */
  const unchangedPolls = new Map<string, { count: number; since: string; loggedAt?: number }>()
  /** Consecutive adapter failures per bot, for the escalation threshold. */
  const adapterErrorStreak = new Map<string, number>()
  /** Failed steps per item, for the escalation threshold. */
  const itemFailures = new Map<string, number>()
  /** Conditions already escalated, so one condition notifies once. */
  const escalatedConditions = new Set<string>()
  /** Epoch ms of the last escalation, so notifications are rate-limited. */
  let lastEscalationAt = 0
  /** Notifications already logged as deferred, so quiet hours do not spam the log. */
  const deferredNotifyLogged = new LoggedSet()
  /** Parked items already reported as changed, keyed by item and fingerprint. */
  const sourceChangedLogged = new LoggedSet()
  /** Bots already told that their task runs use automatic routing. */
  const routingAutoLogged = new LoggedSet()
  /** Last load probe result, and the error when the probe itself threw. */
  let lastLoad: BotLoadProbe | undefined
  let loadProbeError: string | undefined
  /** Per-bot load back-off flags, so `load.backoff`/`load.recovered` log once each. */
  const backedOffBots = new Map<string, boolean>()
  /** Watchdog conditions already reported, so one condition logs and escalates once. */
  const watchdogLogged = new LoggedSet()
  /** Epoch ms of the last component watchdog pass, per bot. */
  const componentCheckedAt = new Map<string, number>()

  function nowIso(): string {
    return new Date().toISOString()
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Build the typed inbox client for one bot and its config, injecting the
   * native service.
   *
   * Only a dry-run workspace bot gets a dependency projection: a dependency that
   * finished a same-bot dry run, with a fingerprint still matching the file on
   * disk, counts as finished for intake, so the dry-run flow can advance past a
   * predecessor whose source file was never written. The projection is prepared
   * here, before the client exists, and it resolves fingerprints through a
   * callback-free inbox read, so it cannot recurse. A live bot receives no
   * callback at all, so its gating is exactly the on-disk check.
   */
  async function openInbox(bot: BotRecord, config: BotConfig): Promise<InboxClient> {
    const isDependencyCompleted = await dryRunDependencyProjection(bot, config)
    return createInboxClient(config.inbox, {
      workspaceTodoService,
      ...(isDependencyCompleted === undefined ? {} : { isDependencyCompleted }),
    })
  }

  /**
   * The dry-run-only dependency projection. A source id is projected finished
   * only when its latest same-bot item completed in dry-run mode and the
   * recorded dispatch fingerprint still matches the current source. Anything
   * else — a live bot, a non-workspace inbox, no completed dry run, a changed
   * fingerprint or a read failure — yields `undefined`, so gating falls back to
   * the on-disk status alone and a missing or cancelled dependency stays
   * blocked. It never changes a todo's own status or `open`.
   */
  async function dryRunDependencyProjection(
    bot: BotRecord,
    config: BotConfig,
  ): Promise<((id: string) => boolean) | undefined> {
    if (config.inbox.kind !== 'workspace') return undefined
    if (bot.mode !== 'dryRun' && config.mode !== 'dryRun') return undefined
    const projected = new Set<string>()
    for (const candidate of store.listItems(bot.id)) {
      if (candidate.state !== 'completed' || candidate.dryRun !== true) continue
      // The latest generation for a source is the one that counts; a superseded
      // or re-opened item never projects.
      const latest = store.findItemBySource(bot.id, candidate.sourceId)
      if (latest === undefined || latest.state !== 'completed' || latest.dryRun !== true) continue
      if (latest.fingerprint === undefined) continue
      if (!(await sourceFingerprintMatches(config, candidate.sourceId, latest.fingerprint))) continue
      projected.add(candidate.sourceId)
    }
    if (projected.size === 0) return undefined
    return (id: string) => projected.has(id)
  }

  /** Whether the current source fingerprint still equals a recorded one. */
  async function sourceFingerprintMatches(
    config: BotConfig,
    sourceId: string,
    fingerprint: string,
  ): Promise<boolean> {
    try {
      // A callback-free client, so resolving the fingerprint can never re-enter
      // the projection this helper is building.
      const base = createInboxClient(config.inbox, { workspaceTodoService })
      const fetched = (await base.get(sourceId)).item
      return fetched !== null && itemFingerprint(fetched) === fingerprint
    } catch {
      return false
    }
  }

  /**
   * Reflect one bot lifecycle status onto a native workspace todo.
   *
   * Only a `kind: 'workspace'` inbox has writable source state; a command
   * (Things) or MCP adapter owns its own store and is left untouched, so this is
   * a no-op for them. In dry-run mode the todo file is never modified: the
   * intended transition is recorded as a log row instead of faking a write.
   *
   * The write is guarded so it never clobbers a terminal source: a cancelled
   * todo refuses every transition, and an accepted todo is never downgraded to
   * `in_progress` or `done`. Reading or writing failure is logged and rethrown,
   * so the calling step fails and retries instead of the bot committing its own
   * transition while the source file stayed unchanged.
   */
  async function reflectNativeTodoStatus(
    bot: BotRecord,
    config: BotConfig | undefined,
    sourceId: string,
    status: TodoStatus,
    dryRun: boolean,
  ): Promise<void> {
    if (config?.inbox.kind !== 'workspace') return
    if (dryRun) {
      store.appendLog({
        botId: bot.id,
        level: 'info',
        code: 'todo.status_dry_run',
        message: `dry run: workspace todo ${sourceId} would be set to ${status}`,
      })
      return
    }
    try {
      const todo = await workspaceTodoService.getTodo(sourceId)
      if (todo.status === status) return
      if (todo.status === 'cancelled') {
        throw new WorkspaceTodoError('cancelled', `workspace todo ${sourceId} is cancelled; refusing to set it to ${status}`)
      }
      if (todo.status === 'accepted' && (status === 'in_progress' || status === 'done')) {
        throw new WorkspaceTodoError('accepted', `workspace todo ${sourceId} is accepted; refusing to downgrade it to ${status}`)
      }
      await workspaceTodoService.updateTodo({ id: sourceId, status })
      store.appendLog({
        botId: bot.id,
        level: 'info',
        code: 'todo.status',
        message: `workspace todo ${sourceId} set to ${status}`,
      })
    } catch (error) {
      store.appendLog({
        botId: bot.id,
        level: 'warn',
        code: 'todo.status_failed',
        message: `workspace todo ${sourceId} status ${status} was not written: ${errorMessage(error)}`,
      })
      throw error
    }
  }

  /**
   * Native-only dispatch safeguard. Immediately before dispatch a workspace todo
   * is re-read so an item whose source was withdrawn, or whose dependency is no
   * longer `done`/`accepted` (unfinished or cancelled), is not dispatched.
   * `list`/`get` already treat such a todo as not open; this re-check closes the
   * gap between admission and dispatch.
   *
   * The result is tri-state. `dispatch` lets the item proceed; `blocked` means
   * the read succeeded and the source is missing or not open, so the item is
   * parked; `retry` means the adapter itself failed, so a transient read error
   * neither parks the item nor enqueues dispatch — the item stays `verified`
   * and the recheck runs again on a later tick. A command (Things) or MCP inbox
   * is never re-read here and always returns `dispatch`.
   */
  async function nativeSourceDispatchable(
    bot: BotRecord,
    config: BotConfig | undefined,
    sourceId: string,
  ): Promise<'dispatch' | 'blocked' | 'retry'> {
    if (config?.inbox.kind !== 'workspace') return 'dispatch'
    try {
      const inbox = await openInbox(bot, config)
      return (await inbox.get(sourceId)).item?.open === true ? 'dispatch' : 'blocked'
    } catch (error) {
      store.appendLog({
        botId: bot.id,
        level: 'warn',
        code: 'dispatch.source_retry',
        message: `could not re-read workspace todo ${sourceId}; the dispatch recheck will retry: ${errorMessage(error)}`,
      })
      return 'retry'
    }
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

  // ── judgment and acceptance task runs ────────────────────────────────────

  /**
   * The routing entry one task kind uses: `judgment` for `bot-verify` and
   * `bot-review`, `acceptance` for the builtin `test` task. The entry carries
   * provider/model/reasoningEffort and an optional explicit `target`; the
   * runner selects that target when present and otherwise uses automatic
   * routing.
   */
  function routedModelFor(config: BotConfig, kind: 'judgment' | 'acceptance'): BotRoutingEntry {
    return config.routing[kind] ?? config.routing.default
  }

  /**
   * The routing entry for one item class, falling back to `default`. A session
   * send takes only the provider/model/reasoningEffort triple, never an entry's
   * explicit run `target`.
   */
  function routedClassModel(config: BotConfig | undefined, className: string | undefined): BotModel | undefined {
    if (config === undefined) return undefined
    const entry = (className === undefined ? undefined : config.routing[className]) ?? config.routing.default
    return { provider: entry.provider, model: entry.model, reasoningEffort: entry.reasoningEffort }
  }

  /**
   * Record, once per bot, that a task kind whose routing entry has no explicit
   * `target` relies on automatic routing.
   */
  function noteAutomaticRouting(bot: BotRecord): void {
    if (routingAutoLogged.has(bot.id)) return
    routingAutoLogged.add(bot.id)
    store.appendLog({
      botId: bot.id,
      level: 'info',
      code: 'routing.auto',
      message: 'bot task runs use automatic routing: the routing entry has no explicit target',
    })
  }

  /**
   * Start one task run and return its run id. A rejection is a real error, so
   * the caller's step fails through the existing failure and escalation path
   * instead of guessing a result.
   */
  async function startBotTask(input: BotTaskRunInput): Promise<string> {
    const runner = options.taskRunner
    if (runner === undefined) throw new Error(`bot task runner is unavailable for ${input.task}`)
    const started = await runner.startTask(input)
    if ('rejected' in started) throw new Error(`${input.task} run was rejected: ${started.rejected}`)
    return started.runId
  }

  /** The outcome of one poll of a detached task run. */
  type DetachedPoll =
    | { kind: 'running' }
    | { kind: 'done'; output: unknown }
    | { kind: 'failed'; message: string }

  /**
   * Read one task run's status without waiting for it. A run that no longer
   * exists fails its step with {@link TASK_RUN_MISSING}, because nothing can
   * prove what it produced.
   */
  async function pollDetachedRun(runId: string, task: string): Promise<DetachedPoll> {
    const runner = options.taskRunner
    if (runner === undefined) return { kind: 'failed', message: `bot task runner is unavailable for ${task}` }
    const result = await runner.getTask(runId)
    // A run waiting for the host-wide desktop lane is not a failure: treat it
    // exactly like a running run so no correction or acceptance budget is spent
    // while it waits.
    if (result.status === 'running' || result.status === 'queued') return { kind: 'running' }
    if (result.status === 'unknown') return { kind: 'failed', message: TASK_RUN_MISSING }
    if (result.status !== 'done') {
      const detail = result.error === undefined || result.error === '' ? '' : `: ${result.error}`
      return { kind: 'failed', message: `${task} run ${runId} ${result.status}${detail}` }
    }
    if (result.output === undefined) return { kind: 'failed', message: `${task} returned no structured output` }
    return { kind: 'done', output: result.output }
  }

  /** The run id one detached task step recorded before its effect ran, if any. */
  function detachedRunId(step: BotStepRecord): string | undefined {
    const stored = stepOutput<{ runId?: unknown }>(step)?.runId
    return typeof stored === 'string' && stored !== '' ? stored : undefined
  }

  /**
   * Run one detached task step. The first tick starts the run and records its id
   * on the still-pending step; later ticks poll that run and only map its
   * terminal output once it finished. The tick never waits for the run itself,
   * so a long model run in one project does not stall the others.
   */
  async function runDetachedTask(
    step: BotStepRecord,
    context: BotStepContext,
    handler: BotStepHandler,
  ): Promise<BotStepResult> {
    const prepare = handler.prepareTask
    const apply = handler.applyTaskResult
    if (prepare === undefined || apply === undefined) {
      throw new Error(`step ${step.kind} is detached but has no task handlers`)
    }
    const task = DETACHED_TASK_KIND[step.kind] ?? step.kind
    const existing = detachedRunId(step)
    if (existing !== undefined) {
      const outcome = await pollDetachedRun(existing, task)
      if (outcome.kind === 'running') throw new BotStepRunning()
      if (outcome.kind === 'failed') throw new BotStepRunFailed(existing, outcome.message)
      return await apply(context, outcome.output)
    }
    const prepared = await prepare(context)
    if ('result' in prepared) return prepared.result
    // The started marker is written in its own transaction before the run is
    // created, so a restart can tell a step that never ran from one in flight.
    store.markStepStarted(step.id)
    const runId = await startBotTask(prepared.input)
    store.appendLog({
      botId: context.bot.id,
      itemId: context.item.id,
      level: 'info',
      code: 'task.started',
      message: `${task} run ${runId} started; the item waits for it across ticks`,
    })
    return { pendingRun: { runId } }
  }

  /**
   * A detached task run that ended without a result (failed, cancelled or
   * timeout, or a run that no longer exists) is an infrastructure failure, not
   * an assessment. The item keeps its state and its project lane, the failure is
   * counted on the item and a fresh attempt is queued for a later tick, so one
   * flaky run does not stop delivery. Only once the kind's failure count exceeds
   * the acceptance budget does the item park with the last error (which releases
   * the lane) and raise one escalation.
   */
  async function handleDetachedRunFailure(context: BotStepContext, runId: string, rawMessage: string): Promise<void> {
    const { bot, item, step, config } = context
    const mapping = DETACHED_RUN_FAILURE[step.kind]
    if (mapping === undefined) {
      // Not a kind this rule covers: keep the generic failure path.
      await failStep(bot, item, step, new Error(rawMessage), config)
      return
    }
    const detail = redactString(rawMessage, RUN_FAILURE_MAX_CHARS)
    const failures = (item.counters?.[mapping.counter] ?? 0) + 1
    const counters = { ...(item.counters ?? {}), [mapping.counter]: failures }
    const maxFailures = config?.budgets.maxAcceptanceAttempts ?? DEFAULT_MAX_ACCEPTANCE_ATTEMPTS
    const output = { runId, error: detail, runFailures: failures }
    store.appendLog({
      botId: bot.id,
      itemId: item.id,
      level: 'warn',
      code: mapping.log,
      message: `run ${runId} ${step.kind} failed (${failures}/${maxFailures}): ${detail}`,
    })
    if (failures > maxFailures) {
      store.finishStep(step.id, {
        status: 'failed',
        error: detail,
        output,
        patch: {
          state: 'parked',
          parkedFrom: item.state,
          counters,
          error: detail,
          question: `${step.kind} task run failed ${failures} times (budget ${maxFailures}): ${detail}`,
        },
      })
      await escalate(bot, config, `run-failures:${item.id}:${step.kind}`, `${step.kind} task run failed ${failures} times for item ${item.id}: ${detail}`)
      return
    }
    // Finish this attempt as failed and queue the next one; the item stays in
    // its state, so a lane-holding item keeps its project lane.
    store.finishStep(step.id, { status: 'failed', error: detail, output, patch: { counters, error: detail } })
    const { attempt } = latestStep(item, step.kind)
    enqueueStep(item, step.kind, undefined, attempt + 1)
  }

  /** Trim to the last `max` characters, marking that the head was dropped. */
  function truncateTail(text: string, max: number): string {
    return text.length <= max ? text : `[...${text.length - max} characters omitted...]\n${text.slice(-max)}`
  }

  /** Trim to the first `max` characters, marking that the tail was dropped. */
  function truncateHead(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}\n[...${text.length - max} characters omitted...]`
  }

  // ── session ledger reads ──────────────────────────────────────────────────

  /** True while a session has an admitted turn that has not reached its end. */
  function sessionRunning(sessionId: string): boolean {
    let running = false
    for (const event of session.readLedger(sessionId)) {
      if (event.type === 'turn.started') running = true
      else if (event.type === 'turn.finished' || event.type === 'turn.interrupted') running = false
    }
    return running
  }

  /**
   * The `reply.sent` texts a judgement may read, oldest turn first: only replies
   * that belong to the answer's own turn when it completed, or to a later
   * completed turn. Identity is the ledger's numeric turn index, not the append
   * sequence, so a delayed reply of a pre-answer turn appended after the answer
   * turn started is never read as its outcome. Without an answer follow-up every
   * reply after `fromSeq` qualifies.
   */
  function eligibleReplies(item: BotItemRecord, fromSeq: number): string[] {
    if (item.sessionId === undefined) return []
    const answer = answerTurn(item)
    const events = session.readLedger(item.sessionId)
    const completed = new Set<number>()
    if (answer.marker !== undefined) {
      for (const event of events) {
        if (event.type === 'turn.finished' && event.status === 'completed' && event.turn !== undefined) completed.add(event.turn)
      }
    }
    const replies: string[] = []
    for (const event of events) {
      if (event.type !== 'reply.sent' || event.seq <= fromSeq) continue
      if (answer.marker !== undefined) {
        const turn = event.turn
        if (answer.turn === undefined || turn === undefined || turn < answer.turn || !completed.has(turn)) continue
      }
      replies.push(event.text)
    }
    return replies
  }

  /** The latest reply a judgement may read, or undefined. */
  function latestReply(item: BotItemRecord): string | undefined {
    const replies = eligibleReplies(item, replyFloor(item))
    return replies.length === 0 ? undefined : replies[replies.length - 1]
  }

  /**
   * The last `max` characters of an item's eligible replies, oldest turn first,
   * prefixed with an explicit note when the answer's own turn ended without
   * completing, so a review sees the interruption instead of falling back to the
   * pre-answer reply.
   */
  function recentReplies(item: BotItemRecord, max: number): string {
    const replies = truncateTail(eligibleReplies(item, replyFloor(item)).join('\n\n---\n\n'), max)
    const answer = answerTurn(item)
    if (answer.marker === undefined || answer.turn === undefined || answer.completed) return replies
    const note = answer.finished
      ? '[the answer turn ended without completing; its partial replies are excluded]'
      : '[the answer turn has not finished]'
    return replies === '' ? note : `${note}\n\n---\n\n${replies}`
  }

  /** The ledger's highest sequence number for one session, or 0. */
  function latestEventSeq(sessionId: string): number {
    const events = session.readLedger(sessionId)
    return events.length === 0 ? 0 : (events[events.length - 1]?.seq ?? 0)
  }

  /** ISO time of the newest ledger event for one session, or undefined. */
  function latestEventAt(sessionId: string): string | undefined {
    const events = session.readLedger(sessionId)
    return events.length === 0 ? undefined : events[events.length - 1]?.at
  }

  /**
   * The number of the latest `turn.started` of one session, or 0 when it never
   * started a turn. A nudge is keyed on this number, so one nudge is sent per
   * finished turn and never twice for the same one.
   */
  function latestTurnNumber(sessionId: string): number {
    let turn = 0
    for (const event of session.readLedger(sessionId)) {
      if (event.type !== 'turn.started') continue
      turn = Math.max(turn, event.turn ?? turn + 1)
    }
    return turn
  }

  /**
   * True when the session's latest finished turn failed (a model route, quota or
   * transport failure) rather than ending on the session's own judgement.
   */
  function latestTurnFailed(sessionId: string): boolean {
    let failed = false
    for (const event of session.readLedger(sessionId)) {
      if (event.type === 'turn.started') failed = false
      else if (event.type === 'turn.finished') failed = (event as { status?: string }).status === 'failed'
    }
    return failed
  }

  /**
   * Milliseconds since one item's session last appended a ledger event, or
   * undefined when neither the ledger nor the item row carries a usable time.
   */
  function sessionIdleMs(item: BotItemRecord): number | undefined {
    if (item.sessionId === undefined) return undefined
    const at = latestEventAt(item.sessionId)
    const since = at === undefined ? Date.parse(item.updatedAt) : Date.parse(at)
    return Number.isNaN(since) ? undefined : Date.now() - since
  }

  // ── step lookups ─────────────────────────────────────────────────────────

  /** Parse one step's stored JSON output, or undefined when it is absent or invalid. */
  function stepOutput<T>(step: BotStepRecord | undefined): T | undefined {
    if (step?.output === undefined) return undefined
    try {
      return JSON.parse(step.output) as T
    } catch {
      return undefined
    }
  }

  /** Parse one step's stored JSON input, or undefined when it is absent or invalid. */
  function stepInput<T>(step: BotStepRecord | undefined): T | undefined {
    if (step?.input === undefined) return undefined
    try {
      return JSON.parse(step.input) as T
    } catch {
      return undefined
    }
  }

  /** The highest existing attempt of one repeatable step kind, and its row. */
  function latestStep(item: BotItemRecord, kind: BotStepKind): { step?: BotStepRecord; attempt: number } {
    let attempt = 0
    let step: BotStepRecord | undefined
    for (let n = 1; n <= MAX_STEP_ATTEMPTS; n += 1) {
      const found = store.findStepByIdemKey(idemKeyFor(item, kind, n))
      if (found === undefined) break
      step = found
      attempt = n
    }
    return { step, attempt }
  }

  /** The `bot-verify` result stored on an item's latest completed verify step. */
  function verifyEnvelope(item: BotItemRecord): BotVerifyEnvelope | undefined {
    const { step } = latestStep(item, 'verify')
    if (step?.status !== 'done') return undefined
    const envelope = asVerifyEnvelope(stepOutput<unknown>(step))
    return envelope?.decision === 'real' ? envelope : undefined
  }

  /** The acceptance plan a verified item carries on its verify step. */
  function acceptancePlan(item: BotItemRecord): BotVerifyCheck[] {
    const envelope = verifyEnvelope(item)
    return envelope?.acceptance?.checks ?? []
  }

  /** The latest answer follow-up step of one item: the `session.send` carrying a `botAnswer`. */
  function answerStep(item: BotItemRecord): BotStepRecord | undefined {
    const { attempt } = latestStep(item, 'session.send')
    for (let n = attempt; n >= 1; n -= 1) {
      const step = store.findStepByIdemKey(idemKeyFor(item, 'session.send', n))
      if (step !== undefined && answerTextFromStep(step) !== undefined) return step
    }
    return undefined
  }

  /**
   * The answer turn of one item: the marker of its latest answer follow-up, the
   * numeric index of the newer turn that marker started, its ledger sequence and
   * whether that turn reached a terminal `turn.finished` — with `completed` true
   * only for a `completed` status. An interruption is not a reply, but the ledger
   * always writes the matching `turn.finished` after `turn.interrupted`, so the
   * scan never stops at the interruption and the barrier still clears.
   */
  function answerTurn(item: BotItemRecord): { marker?: string; turn?: number; startedSeq: number; finished: boolean; completed: boolean } {
    if (item.sessionId === undefined) return { startedSeq: 0, finished: false, completed: false }
    const step = answerStep(item)
    if (step === undefined) return { startedSeq: 0, finished: false, completed: false }
    const marker = `[bot:${step.idemKey}]`
    const since = item.counters?.answerSeq ?? 0
    const events = session.readLedger(item.sessionId)
    let startedSeq = 0
    let turn: number | undefined
    let turnId: string | undefined
    for (const event of events) {
      if (event.seq <= since) continue
      if (event.type === 'turn.started' && event.text.includes(marker)) {
        startedSeq = event.seq
        turnId = event.id
        turn = event.turn
        break
      }
    }
    if (turnId === undefined) return { marker, startedSeq: 0, finished: false, completed: false }
    for (const event of events) {
      if (event.seq <= startedSeq) continue
      if (event.type === 'turn.finished' && event.id === turnId) {
        return { marker, turn, startedSeq, finished: true, completed: event.status === 'completed' }
      }
    }
    return { marker, turn, startedSeq, finished: false, completed: false }
  }

  /**
   * The ledger sequence before which no reply may be judged: the start of the
   * latest answer's turn, so a delayed reply that predates the answer is never
   * read as its outcome. Without an answer every reply qualifies.
   */
  function replyFloor(item: BotItemRecord): number {
    const turn = answerTurn(item)
    if (turn.marker === undefined) return 0
    return turn.startedSeq === 0 ? Number.MAX_SAFE_INTEGER : turn.startedSeq
  }

  /**
   * The answer delivery/review barrier: true while an answer has been handed to
   * the session but the newer turn its marker started has not yet reached a
   * terminal `turn.finished` (an interruption still writes one). It is keyed to
   * the session's own ledger sequence and turn id, never to wall-clock, so a
   * delayed tick cannot slip a review in before the answer turn ends.
   */
  function answerBarrierPending(item: BotItemRecord): boolean {
    if (item.sessionId === undefined) return false
    if (item.counters?.answerPending !== 1) return false
    const turn = answerTurn(item)
    return turn.startedSeq === 0 || !turn.finished
  }

  /**
   * True when a review is due: the session produced new ledger events since the
   * last review, or it has been idle past the idle window since the last one.
   */
  function reviewDue(item: BotItemRecord): boolean {
    if (item.sessionId === undefined) return false
    // An answer whose newer turn has not started and finished holds the review
    // back, so no judgement runs against the pre-answer reply.
    if (answerBarrierPending(item)) return false
    const counters = item.counters ?? {}
    if (latestEventSeq(item.sessionId) > (counters.lastReviewSeq ?? 0)) return true
    if (Date.now() - (counters.lastReviewAtMs ?? 0) <= REVIEW_IDLE_MS) return false
    const at = latestEventAt(item.sessionId)
    const idleSince = at === undefined ? Date.parse(item.updatedAt) : Date.parse(at)
    return Number.isNaN(idleSince) || Date.now() - idleSince > REVIEW_IDLE_MS
  }

  // ── git helpers for the ready gate ───────────────────────────────────────

  /** Resolve one ref to a commit sha in a checkout, or undefined. */
  function revParse(cwd: string, ref: string): string | undefined {
    const result = runGitSync(cwd, ['rev-parse', '--verify', '--quiet', ref])
    const sha = result.stdout.trim()
    return result.code === 0 && sha !== '' ? sha : undefined
  }

  /**
   * True when the worktree head is strictly ahead of the project's target
   * branch; `undefined` when the target branch or either head cannot be
   * resolved, so the caller fails the gate instead of guessing.
   */
  function worktreeAheadOfTarget(project: string, worktreeId: string): boolean | undefined {
    try {
      const entry = projectManager.getProject(project)
      const targetRef = entry.defaultBranch === undefined
        ? (revParse(entry.path, 'refs/heads/main') === undefined ? 'refs/heads/master' : 'refs/heads/main')
        : `refs/heads/${entry.defaultBranch}`
      const targetSha = revParse(entry.path, targetRef)
      if (targetSha === undefined) return undefined
      const worktreePath = projectManager.resolveWorktreePath(worktreeId, project)
      const head = revParse(worktreePath, 'HEAD')
      if (head === undefined) return undefined
      if (head === targetSha) return false
      return runGitSync(worktreePath, ['merge-base', '--is-ancestor', targetSha, head]).code === 0
    } catch {
      return undefined
    }
  }

  /**
   * The ready gate (§5.3): the session is not running a turn, the worktree is
   * clean, it has at least one commit ahead of the target branch, and the latest
   * reply carries `BOT-READY <head sha>`.
   */
  async function checkReadyGate(item: BotItemRecord): Promise<{ ok: true } | { ok: false; failed: string }> {
    if (item.sessionId === undefined) return { ok: false, failed: 'the item has no session' }
    if (sessionRunning(item.sessionId)) return { ok: false, failed: 'the session is still running a turn' }
    if (!item.project || !item.worktreeId) return { ok: false, failed: 'the item has no project worktree' }
    const worktree = projectManager.listWorktrees(item.project).find(entry => entry.id === item.worktreeId)
    if (worktree === undefined) return { ok: false, failed: `worktree ${item.worktreeId} is not registered` }
    if (!worktree.clean) return { ok: false, failed: `worktree ${item.worktreeId} has uncommitted changes` }
    const ahead = worktreeAheadOfTarget(item.project, item.worktreeId)
    if (ahead === undefined) return { ok: false, failed: 'the worktree could not be compared with the target branch' }
    if (!ahead) return { ok: false, failed: 'the worktree has no commits ahead of the target branch' }
    const reply = latestReply(item)
    if (reply === undefined || !BOT_READY_PATTERN.test(reply)) {
      return { ok: false, failed: 'the latest reply does not carry `BOT-READY <head sha>`' }
    }
    return { ok: true }
  }

  // ── acceptance components ────────────────────────────────────────────────

  /** The operation components one acceptance plan requires, by check surface. */
  function plannedSurfaceComponents(plan: readonly BotVerifyCheck[]): OperationComponentId[] {
    const needed = new Set<OperationComponentId>()
    for (const check of plan) {
      const component = SURFACE_COMPONENT[check.surface]
      if (component !== undefined) needed.add(component)
    }
    return [...needed]
  }

  /**
   * Refresh and read the operation components an acceptance plan requires.
   * Resolves with the first component that is not ready, or undefined when
   * every required component is ready. A failed refresh of the single-owner
   * desktop component defers the step instead of failing it.
   */
  async function checkComponents(
    needed: readonly OperationComponentId[],
  ): Promise<{ id: OperationComponentId; name: string; state: string; host: string } | undefined> {
    if (needed.length === 0) return undefined
    const service = options.operationComponents
    if (service === undefined) throw new Error('operation components are unavailable on this host')
    for (const id of needed) {
      try {
        await service.act(id, 'refresh')
      } catch (error) {
        // The desktop component has one owner per host: while another run holds
        // it, the readiness refresh fails and this item waits for a later tick.
        if (id === 'desktop') throw new BotStepPending('desktop.busy', `desktop component is busy: ${errorMessage(error)}`)
        throw error
      }
    }
    const snapshots = await service.list()
    for (const id of needed) {
      const snapshot = snapshots.find(entry => entry.id === id)
      if (snapshot === undefined) return { id, name: id, state: 'unknown', host: 'this host' }
      if (snapshot.state !== 'ready') return { id, name: snapshot.name, state: snapshot.state, host: snapshot.host }
    }
    return undefined
  }

  /** Map a `test` task result back onto the plan's checks. */
  function mapAcceptanceChecks(plan: readonly BotVerifyCheck[], output: unknown): BotAcceptanceCheck[] {
    const parsed = asTestOutput(output)
    const assessments = new Map((parsed?.assessments ?? []).map(entry => [entry.criterion_id, entry]))
    const evidence = (parsed?.artifacts ?? []).map(artifact => artifact.path)
    const checks: BotAcceptanceCheck[] = []
    for (const check of plan) {
      if (check.surface === 'static') {
        // A static check (lint, typecheck, reading the code) never verifies a
        // runtime claim, so it is always reported as not verified.
        checks.push({
          claim: check.claim,
          method: check.recipe,
          status: 'not_verified',
          note: 'static check; it cannot verify a runtime claim',
        })
        continue
      }
      const assessment = assessments.get(check.id)
      const status = assessment?.status === 'passed'
        ? 'verified' as const
        : assessment?.status === 'failed' ? 'failed' as const : 'not_verified' as const
      checks.push({
        claim: check.claim,
        method: check.recipe,
        status,
        ...(evidence.length === 0 ? {} : { evidence }),
        ...(assessment?.reason === undefined ? {} : { note: assessment.reason }),
      })
    }
    return checks
  }

  /** The follow-up sent to a session when acceptance found failing checks. */
  function buildAcceptanceFailureText(item: BotItemRecord, checks: readonly BotAcceptanceCheck[], output: unknown): string {
    const failed = checks.filter(check => check.status === 'failed')
    const parsed = asTestOutput(output)
    const artifacts = (parsed?.artifacts ?? []).map(artifact => artifact.path)
    const lines: string[] = []
    lines.push(`Bot item ${item.id}: acceptance found ${failed.length} failing check(s).`)
    lines.push(`Failing checks:\n${failed.map((check) => `- ${check.claim}\n  how: ${check.method}${check.note === undefined ? '' : `\n  reason: ${check.note}`}`).join('\n')}`)
    if (artifacts.length > 0) lines.push(`Evidence:\n${artifacts.map(path => `- ${path}`).join('\n')}`)
    lines.push('Fix the failing checks in your worktree, commit there, and reply `BOT-READY <head sha>`.')
    return lines.join('\n')
  }

  /** Send one follow-up into an item's own session, reusing the session's model. */
  async function sendSessionFollowUp(bot: BotRecord, item: BotItemRecord, text: string, config?: BotConfig): Promise<{ turn: number }> {
    if (item.sessionId === undefined) throw new Error('item has no session for a follow-up')
    const model = resolveSendModel(bot, item, config)
    if (model === undefined) throw new Error('no routed model is available for the follow-up')
    const result = await session.send(item.sessionId, { text, model, sender: { botId: bot.id } })
    store.patchItem(item.id, { sessionModel: model })
    return result
  }

  /**
   * The follow-up that delivers a user's answer to a parked session's question,
   * verbatim, carrying the step's stable idempotency marker so a retry or a
   * restart proves whether the turn was already delivered instead of sending it
   * a second time.
   */
  function buildAnswerFollowUp(item: BotItemRecord, step: BotStepRecord, answer: string): string {
    return `Bot item ${item.id}: the user answered your question:\n\n${answer}\n\n[bot:${step.idemKey}]`
  }

  /** The answer a `session.send` step carries on its stored input, when it is an answer follow-up. */
  function answerTextFromStep(step: BotStepRecord): string | undefined {
    const stored = stepInput<{ botAnswer?: unknown }>(step)?.botAnswer
    return typeof stored === 'string' && stored !== '' ? stored : undefined
  }

  /**
   * What one stalled-session check decided: nothing to do, send the single
   * nudge for the finished turn, or park the item because the nudge would
   * exceed the correction budget.
   */
  type StalledNudgeDecision =
    | { kind: 'none' }
    | { kind: 'nudge'; turn: number; counters: Record<string, number> }
    | { kind: 'park'; counters: Record<string, number>; question: string }

  /** The one nudge sent to a session whose turn ended without a closing marker. */
  function stalledNudgeText(item: BotItemRecord): string {
    const worktree = item.worktreeId ?? '(unnamed)'
    return `Your last turn ended without BOT-READY or BOT-BLOCKED. Continue the task in worktree ${worktree}: make the change, commit it locally, and end with BOT-READY <head sha>, or reply BOT-BLOCKED <question> if you need a decision.`
  }

  /**
   * Decide whether one session needs the stalled-session nudge. A session that
   * is running a turn, or whose latest reply already carries `BOT-READY` or
   * `BOT-BLOCKED`, is making progress and is left alone. Otherwise the item is
   * nudged once per finished turn; the incremented correction count parks it
   * instead of sending once the budget is exceeded. `base` lets a caller pass
   * counters it has already advanced for this tick.
   */
  function decideStalledNudge(
    item: BotItemRecord,
    config: BotConfig | undefined,
    base?: Record<string, number>,
  ): StalledNudgeDecision {
    if (item.sessionId === undefined) return { kind: 'none' }
    if (sessionRunning(item.sessionId)) return { kind: 'none' }
    const reply = latestReply(item)
    if (reply !== undefined && (BOT_READY_PATTERN.test(reply) || BOT_BLOCKED_PATTERN.test(reply))) {
      return { kind: 'none' }
    }
    const turn = latestTurnNumber(item.sessionId)
    if (turn === 0) return { kind: 'none' }
    const counters = base ?? item.counters ?? {}
    if ((counters.nudgedTurn ?? 0) >= turn) return { kind: 'none' }
    // A failed turn is an infrastructure failure, not a stall: it spends no
    // correction and is retried on a bounded cadence instead of every tick.
    if (latestTurnFailed(item.sessionId)) {
      const now = Date.now()
      if (now - (counters.failedRetryAt ?? 0) < FAILED_TURN_RETRY_MS) return { kind: 'none' }
      return { kind: 'nudge', turn, counters: { ...counters, nudgedTurn: turn, failedRetryAt: now } }
    }
    const corrections = counters.corrections ?? 0
    const max = config?.budgets.maxCorrections ?? 0
    const next = { ...counters, corrections: corrections + 1, nudgedTurn: turn }
    if (corrections + 1 > max) {
      return {
        kind: 'park',
        counters: next,
        question: `${STALLED_REASON}: turn ${turn} ended without \`BOT-READY\` or \`BOT-BLOCKED\` and the correction budget is exhausted (${corrections + 1}/${max})`,
      }
    }
    return { kind: 'nudge', turn, counters: next }
  }

  /**
   * Apply one stalled-session decision: a nudge goes out through the regular
   * follow-up path (full session id, the session's own latest `turn.started`
   * model) and is logged as `review.nudge`; an exhausted budget parks the item
   * from its current state instead. The nudged turn number is persisted so no
   * second nudge is sent until the session produces a new turn.
   */
  async function applyStalledNudge(
    bot: BotRecord,
    item: BotItemRecord,
    decision: StalledNudgeDecision,
    config?: BotConfig,
  ): Promise<void> {
    if (decision.kind === 'none') return
    if (decision.kind === 'park') {
      store.transitionItem(item.id, 'parked', {
        parkedFrom: item.state,
        counters: decision.counters,
        question: decision.question,
        error: STALLED_REASON,
      })
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'warn',
        code: 'review.nudge_parked',
        message: decision.question,
      })
      return
    }
    await sendSessionFollowUp(bot, item, stalledNudgeText(item), config)
    store.patchItem(item.id, { counters: decision.counters })
    store.appendLog({
      botId: bot.id,
      itemId: item.id,
      level: 'info',
      code: 'review.nudge',
      message: `nudged the stalled session at turn ${decision.turn}`,
    })
  }

  /**
   * The extra blocks appended to a dispatch brief.
   *
   * A stored public answer always becomes a labeled clarification, so a session
   * resumed after a park sees the user's decision in the very prompt that
   * resumes it (the same label the verify task uses in its request body). Only a
   * workspace dry run additionally gets dependency semantics: its `depends_on`
   * values are todo ids, not commit hashes, and a dry run merges nothing, so a
   * predecessor's artifacts may be absent from the current branch. Any other
   * inbox or a live bot adds neither, so no live brief changes.
   */
  async function dispatchContext(
    config: BotConfig | undefined,
    item: BotItemRecord,
    dryRun: boolean,
  ): Promise<string[]> {
    const blocks: string[] = []
    const answer = item.answer?.trim()
    if (answer !== undefined && answer !== '') blocks.push(`User clarification:\n${answer}`)
    if (config?.inbox.kind !== 'workspace' || !dryRun) return blocks
    const dependsOn = await sourceDependencies(item.sourceId)
    if (dependsOn.length === 0) return blocks
    blocks.push([
      `Dependency context (workspace dry run): this item depends_on ${dependsOn.join(', ')}.`,
      'Those values are workspace todo ids, not Git commit hashes.',
      'It was admitted because each dependency is done or accepted on disk, or a matching completed same-bot dry-run run recorded it finished.',
      "A dry run never merges a predecessor's changes into main, so a predecessor's artifacts may be absent from the current branch.",
      'Treat scheduling completion as distinct from artifact availability: if a prerequisite artifact is genuinely missing, report it in your reply instead of weakening or bypassing the requirement.',
    ].join(' '))
    return blocks
  }

  /** A workspace todo's dependency ids, or none when the source cannot be read. */
  async function sourceDependencies(sourceId: string): Promise<string[]> {
    try {
      return (await workspaceTodoService.getTodo(sourceId)).depends_on
    } catch {
      return []
    }
  }

  /**
   * The dispatch brief: the verified brief, the acceptance checks, the working
   * rules and the idempotency marker. It names the worktree so every dispatched
   * task run binds it. The optional context blocks (a public-answer
   * clarification and, for a workspace dry run, dependency semantics) are
   * inserted after the request.
   */
  function dispatchBrief(item: BotItemRecord, step: BotStepRecord, context: readonly string[] = []): string {
    const envelope = verifyEnvelope(item)
    const lines: string[] = []
    lines.push(`Bot item ${item.id}${item.title === undefined ? '' : `: ${item.title}`}`)
    if (item.project !== undefined) lines.push(`Project: ${item.project}`)
    if (item.worktreeId !== undefined) lines.push(`Worktree id: ${item.worktreeId}`)
    const brief = envelope?.brief
    if (brief !== undefined && brief.trim() !== '') lines.push(`Brief:\n${brief}`)
    else if (item.body !== undefined) lines.push(`Request:\n${item.body}`)
    for (const block of context) if (block !== '') lines.push(block)
    const checks = envelope?.acceptance?.checks ?? []
    if (checks.length > 0) {
      lines.push(`Acceptance checks that must hold:\n${checks.map(check => `- [${check.surface}] ${check.claim} — ${check.recipe}`).join('\n')}`)
    }
    lines.push([
      'Rules: keep the diff minimal; add no tests unless they are needed;',
      `work only in worktree ${item.worktreeId ?? '(unnamed)'} and bind every dispatched task to it;`,
      'commit locally in that worktree; commit messages carry no internal ids, local paths or user names;',
      'never merge, push, tag or release;',
      'verify your own change in the real running environment before you finish: use the available computer-use desktop driver (Cua Driver) for native/desktop surfaces and the browser-use operation component (agent-browser) for renderer/web surfaces, and keep the real screenshots as evidence;',
      'the real running environment means your worktree build against an isolated daemon you start yourself (temporary WRENYARD_IPC_PATH, WRENYARD_CONFIG_HOME and WRENYARD_STATE_HOME); never stop, restart, replace or attach to the user\'s installed app, daemon, state, config or IPC socket;',
      'who verifies, how to verify and whether re-verification is needed are never questions for the user — apply the rule above and settle them yourself;',
      'if a tool or environment you need is missing, name the exact missing capability in your `BOT-BLOCKED` line so the bot reports it as a watchdog/escalation instead of asking the user;',
      'only a genuine product trade-off or a permission you cannot obtain may be raised as a question for the user;',
      'finish with a line `BOT-READY <head sha>` when done or `BOT-BLOCKED <question>` when blocked.',
    ].join(' '))
    lines.push(`[bot:${step.idemKey}]`)
    return lines.join('\n\n')
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
    if (description.kind === 'workspace') return 'workspace'
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

  // ── load back-off and watchdogs ──────────────────────────────────────────

  /** The watchdog thresholds a bot uses: its config's, or the neutral defaults. */
  function watchdogsFor(config: BotConfig | undefined): BotWatchdogs {
    return config?.watchdogs ?? DEFAULT_BOT_WATCHDOGS
  }

  /** True while the daemon is loaded enough that the bot starts no new work. */
  function isOverloaded(load: BotLoadProbe | undefined, thresholds: BotWatchdogs): boolean {
    if (load === undefined) return false
    if (load.activeExecutions >= thresholds.loadMaxActiveExecutions) return true
    const queuedLimitMs = thresholds.queuedExecutionMinutes * 60_000
    return queuedLimitMs > 0 && (load.oldestQueuedMs ?? 0) > queuedLimitMs
  }

  /** True while this bot is backed off, so no new dispatch or task run starts. */
  function isBackedOff(botId: string): boolean {
    return backedOffBots.get(botId) === true
  }

  /**
   * Record a load back-off transition: `load.backoff` once when the daemon first
   * looks loaded for this bot, `load.recovered` once when it clears. Only new
   * work is held back; merge, push, completion and notification are not.
   */
  function applyLoadBackoff(bot: BotRecord, load: BotLoadProbe | undefined, thresholds: BotWatchdogs): void {
    const overloaded = isOverloaded(load, thresholds)
    if (overloaded === isBackedOff(bot.id)) return
    backedOffBots.set(bot.id, overloaded)
    if (overloaded) {
      store.appendLog({
        botId: bot.id,
        level: 'warn',
        code: 'load.backoff',
        message: `holding new work: ${load?.activeExecutions ?? 0}/${thresholds.loadMaxActiveExecutions} active executions, ${load?.queuedExecutions ?? 0} queued`,
      })
    } else {
      store.appendLog({
        botId: bot.id,
        level: 'info',
        code: 'load.recovered',
        message: 'daemon load recovered; new dispatch and task runs resume',
      })
    }
  }

  /** Read the live load once per tick; a thrown probe is reported by the watchdog. */
  async function probeLoad(): Promise<{ load?: BotLoadProbe; error?: string }> {
    const probe = options.loadProbe
    if (probe === undefined) return {}
    try {
      const load = await probe()
      lastLoad = load
      loadProbeError = undefined
      return { load }
    } catch (error) {
      const message = errorMessage(error)
      loadProbeError = message
      return { error: message }
    }
  }

  /**
   * Raise one watchdog condition: a warn log with code `watchdog.<kind>` and one
   * escalation through the rate-limited `escalate()`. A condition is reported
   * once, so a persistent problem does not flood the log every tick.
   */
  async function watchdog(bot: BotRecord, config: BotConfig | undefined, kind: string, key: string, message: string): Promise<void> {
    const escalateKey = `watchdog.${kind}:${key}`
    if (watchdogLogged.has(escalateKey)) return
    watchdogLogged.add(escalateKey)
    store.appendLog({ botId: bot.id, level: 'warn', code: `watchdog.${kind}`, message })
    await escalate(bot, config, escalateKey, message)
  }

  const previousDiskStatusByBot = new Map<string, string | undefined>()
  async function checkLowDisk(bot: BotRecord, config: BotConfig | undefined): Promise<void> {
    const state = options.lowDiskState?.()
    if (!state) return
    if (state.status === previousDiskStatusByBot.get(bot.id)) return
    previousDiskStatusByBot.set(bot.id, state.status)
    if (state.status !== 'ok') await watchdog(bot, config, 'low_disk_space', `${bot.id}:state-volume`, `low_disk_space: state volume ${state.status}; available ${state.availableBytes ?? 'unknown'} bytes, minimum ${state.minimumBytes} bytes${state.error ? `; ${state.error}` : ''}`)
    else watchdogLogged.delete(`watchdog.low_disk_space:${bot.id}:state-volume`)
  }

  /**
   * (a) task_stuck: cancel a detached verify/review/accept run that has outlived
   * its kind's budget and hand the outcome to the existing run-failure
   * retry/park rule. A pending step with no recorded run id only escalates.
   */
  async function checkStuckTasks(bot: BotRecord, config: BotConfig | undefined, thresholds: BotWatchdogs): Promise<void> {
    for (const step of store.listPendingSteps(bot.id)) {
      const kind = TASK_RUN_MINUTES_KIND[step.kind]
      if (kind === undefined || step.startedAt === undefined) continue
      const limitMs = thresholds.taskRunMinutes[kind] * 60_000
      if (limitMs <= 0) continue
      const started = Date.parse(step.startedAt)
      if (Number.isNaN(started)) continue
      const elapsed = Date.now() - started
      if (elapsed <= limitMs) continue
      const item = store.getItem(bot.id, step.itemId)
      const minutes = Math.round(elapsed / 60_000)
      const runId = detachedRunId(step)
      if (runId === undefined) {
        await watchdog(bot, config, 'task_stuck', `${item.id}:${step.kind}`, `pending ${step.kind} for item ${item.id} has been started for ${minutes} min with no recorded run id`)
        continue
      }
      // A run still waiting for the host-wide desktop lane is not stuck: skip it
      // so lane wait never counts against the kind's task-run budget.
      try {
        if ((await options.taskRunner?.getTask(runId))?.status === 'queued') continue
      } catch {
        // A status read failure falls through to the existing cancel path.
      }
      try {
        await options.taskRunner?.cancelTask?.(runId)
      } catch (error) {
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'warn',
          code: 'watchdog.task_stuck',
          message: `run ${runId} could not be cancelled: ${errorMessage(error)}`,
        })
      }
      await watchdog(bot, config, 'task_stuck', `${item.id}:${runId}`, `${step.kind} run ${runId} for item ${item.id} ran longer than ${thresholds.taskRunMinutes[kind]} min; cancelled`)
      await handleDetachedRunFailure(
        {
          bot,
          item,
          step,
          ...(config === undefined ? {} : { config }),
          dryRun: bot.mode === 'dryRun' || item.dryRun,
        },
        runId,
        `cancelled by the task_stuck watchdog after ${thresholds.taskRunMinutes[kind]} min`,
      )
    }
  }

  /**
   * (c) cwd: an execution running in a project checkout rather than a managed
   * worktree. There is no reliable link from a bot item to the executions its
   * session spawns, so the project-checkout rule is used while the bot has
   * in-flight items, and the message says which rule was used.
   */
  async function checkExecutionCwd(bot: BotRecord, config: BotConfig | undefined): Promise<void> {
    if (config === undefined) return
    const inFlight = store.listItems(bot.id).some(item => IN_FLIGHT_ITEM_STATES.includes(item.state))
    if (!inFlight) return
    const checkouts: string[] = []
    for (const policy of config.projects) {
      try {
        checkouts.push(projectManager.getProject(policy.id).path)
      } catch {
        // An unregistered project has no checkout to compare against.
      }
    }
    if (checkouts.length === 0) return
    const rows = db.prepare<[], { id: string; cwd: string }>(
      "SELECT id, cwd FROM executions WHERE status IN ('queued','starting','running')",
    ).all()
    const offenders = rows.filter(row => checkouts.some(path => row.cwd === path || row.cwd.startsWith(`${path}/`)))
    if (offenders.length === 0) return
    await watchdog(
      bot,
      config,
      'cwd',
      offenders[0]?.id ?? 'unknown',
      `${offenders.length} execution(s) run in the project checkout rather than a worktree (rule: project-checkout cwd; no session/item linkage); e.g. ${offenders[0]?.cwd ?? ''}`,
    )
  }

  /**
   * (d) component: every `componentCheckMinutes`, an item waiting in `ready` or
   * `accepting` whose plan needs a browser/desktop component that the cached
   * `components.list` does not report as `ready`.
   */
  async function checkComponentsDue(bot: BotRecord, config: BotConfig | undefined): Promise<void> {
    if (config === undefined) return
    const service = options.operationComponents
    if (service === undefined) return
    const periodMs = watchdogsFor(config).componentCheckMinutes * 60_000
    if (periodMs <= 0) return
    const last = componentCheckedAt.get(bot.id) ?? 0
    if (Date.now() - last < periodMs) return
    componentCheckedAt.set(bot.id, Date.now())
    const candidates = store.listItems(bot.id).filter(item => item.state === 'ready' || item.state === 'accepting')
    if (candidates.length === 0) return
    let snapshots: Awaited<ReturnType<OperationComponents['list']>>
    try {
      snapshots = await service.list()
    } catch {
      return
    }
    for (const item of candidates) {
      for (const id of plannedSurfaceComponents(acceptancePlan(item))) {
        const snapshot = snapshots.find(entry => entry.id === id)
        if (snapshot !== undefined && snapshot.state === 'ready') continue
        await watchdog(bot, config, 'component', `${item.id}:${id}`, `item ${item.id} needs the ${id} operation component for acceptance but it is ${snapshot?.state ?? 'unknown'}`)
      }
    }
  }

  /**
   * (f) session_silent: an `in_progress` item whose session is running a turn
   * but has appended no ledger event for `sessionSilentMinutes`.
   */
  async function checkSessionSilent(bot: BotRecord, config: BotConfig | undefined, thresholds: BotWatchdogs): Promise<void> {
    const limitMs = thresholds.sessionSilentMinutes * 60_000
    if (limitMs <= 0) return
    for (const item of store.listItems(bot.id)) {
      if (item.state !== 'in_progress' || item.sessionId === undefined) continue
      if (!sessionRunning(item.sessionId)) continue
      const at = latestEventAt(item.sessionId)
      const since = at === undefined ? Date.parse(item.updatedAt) : Date.parse(at)
      if (Number.isNaN(since)) continue
      const silent = Date.now() - since
      if (silent <= limitMs) continue
      await watchdog(bot, config, 'session_silent', item.id, `item ${item.id} session ${item.sessionId} is running a turn with no new ledger event for ${Math.round(silent / 60_000)} min`)
    }
  }

  /**
   * Enforce `budgets.maxItemHours`: an item that is not terminal, parked or
   * failed and whose age since its first dispatch exceeds the budget is parked,
   * which releases its project lane, with one escalation. The age starts at the
   * recorded `dispatchedAtMs`, falling back to the item's `createdAt`.
   */
  async function enforceItemAge(bot: BotRecord, config: BotConfig | undefined): Promise<void> {
    if (config === undefined) return
    const maxHours = config.budgets.maxItemHours
    if (!(maxHours > 0)) return
    const limitMs = maxHours * 3_600_000
    for (const item of store.listItems(bot.id)) {
      if (isTerminalItemState(item.state) || item.state === 'parked' || item.state === 'failed') continue
      // Delivery already under way is finished by its own steps, never parked for age.
      if (item.state === 'accepted' || item.state === 'merging' || item.state === 'merged' || item.state === 'completing') continue
      const since = item.counters?.dispatchedAtMs ?? Date.parse(item.createdAt)
      if (Number.isNaN(since)) continue
      const age = Date.now() - since
      if (age <= limitMs) continue
      const reason = `item exceeded maxItemHours (${Math.round(age / 3_600_000)} h)`
      try {
        store.transitionItem(item.id, 'parked', { parkedFrom: item.state, question: reason, error: reason })
      } catch {
        // A state that cannot park on its own is left for its own step.
        continue
      }
      await watchdog(bot, config, 'maxItemHours', item.id, reason)
    }
  }

  /** Run every watchdog for one bot after its items were advanced. */
  async function runWatchdogs(bot: BotRecord, config: BotConfig | undefined, load: BotLoadProbe | undefined, probeError: string | undefined): Promise<void> {
    const thresholds = watchdogsFor(config)
    const lastLagMs = botTickStats.get(bot.id)?.lastLagMs ?? 0
    if (probeError !== undefined) {
      await watchdog(bot, config, 'daemon', 'probe', `the load probe threw: ${probeError}`)
    } else if (lastLagMs > thresholds.tickLagWarnMs) {
      await watchdog(bot, config, 'daemon', 'lag', `tick lag ${lastLagMs} ms exceeds ${thresholds.tickLagWarnMs} ms`)
    }
    const queuedLimitMs = thresholds.queuedExecutionMinutes * 60_000
    if (load !== undefined && queuedLimitMs > 0 && (load.oldestQueuedMs ?? 0) > queuedLimitMs) {
      await watchdog(bot, config, 'queued', 'queue', `${load.queuedExecutions} execution(s) queued; the oldest has waited ${Math.round((load.oldestQueuedMs ?? 0) / 60_000)} min (limit ${thresholds.queuedExecutionMinutes} min)`)
    }
    await checkStuckTasks(bot, config, thresholds)
    await checkExecutionCwd(bot, config)
    await checkSessionSilent(bot, config, thresholds)
    await checkComponentsDue(bot, config)
    await enforceItemAge(bot, config)
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
      const owner = ownerForItem(bot, item)
      const existing = projectManager.listWorktrees(item.project).find(worktree => worktree.id === id)
      if (existing) {
        return { output: { worktreeId: existing.id, branch: existing.branch, reused: true }, patch: { worktreeId: existing.id, branch: existing.branch } }
      }
      const creator = new ProjectManager({ workspaceRoot, idGenerator: () => id })
      const created = await creator.createWorktree(item.project, undefined, { owner })
      return {
        output: { worktreeId: created.worktree_id, branch: created.branch, owner },
        patch: { worktreeId: created.worktree_id, branch: created.branch },
      }
    },
  }

  /**
   * Counters for an item that just entered `dispatched`. The first dispatch
   * records when the item started being worked on, which `maxItemHours` is
   * measured from; a later dispatch keeps the original moment.
   */
  function dispatchedCounters(item: BotItemRecord): Record<string, number> {
    const counters = item.counters ?? {}
    return counters.dispatchedAtMs === undefined ? { ...counters, dispatchedAtMs: Date.now() } : counters
  }

  const sessionCreate: BotStepHandler = {
    doneState: 'dispatched',
    async probe({ item }) {
      return item.sessionId === undefined ? 'not-done' : 'done'
    },
    async run({ bot, item }) {
      if (item.sessionId !== undefined) {
        return { output: { sessionId: item.sessionId, reused: true }, to: 'dispatched', patch: { counters: dispatchedCounters(item) } }
      }
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
      return {
        output: { sessionId: created.sessionId, bot: bot.id, item: item.id },
        to: 'dispatched',
        patch: { sessionId: created.sessionId, counters: dispatchedCounters(item) },
      }
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
   * The model one send must use, decided by the session's ledger state rather
   * than by the presence of a session id: a session that already started a turn
   * keeps its own latest model (adopted and logged when it changed, so a user
   * switch is never overridden), an item with a stored model reuses it, and a
   * first dispatch takes the routing entry for the item's class from the loaded
   * bot config, falling back to `default`.
   */
  function resolveSendModel(bot: BotRecord, item: BotItemRecord, config?: BotConfig): BotModel | undefined {
    if (item.sessionId !== undefined && latestTurnFailed(item.sessionId)) {
      // The session's own model just failed; follow up on the model currently
      // routed for the item's class so a dead route is not retried forever.
      const routed = routedClassModel(config, item.class)
      const current = latestSessionModel(item.sessionId) ?? item.sessionModel
      if (routed !== undefined && (current === undefined || !sameModel(current, routed))) {
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'session.model.rerouted',
          message: `last turn failed; following up on ${routed.provider}/${routed.model}`,
        })
        return routed
      }
    }
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
    }
    if (item.sessionModel !== undefined) return item.sessionModel
    return routedClassModel(config, item.class)
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
    async run({ bot, item, step, config, dryRun }) {
      if (item.sessionId === undefined) throw new Error('item has no session')
      // An answer follow-up carries the user's own answer through the same
      // follow-up path as every other session message, so it reuses the
      // session's own latest model (never the bot's default) and its marker is
      // what a retry or restart probes below.
      const answer = answerTextFromStep(step)
      if (answer !== undefined) {
        const delivered = await sendSessionFollowUp(bot, item, buildAnswerFollowUp(item, step, answer), config)
        return {
          output: { turn: delivered.turn, answer: true },
          ...(item.state === 'dispatched' ? { to: 'in_progress' as BotItemState } : {}),
        }
      }
      const model = resolveSendModel(bot, item, config)
      if (model === undefined) throw new Error('no routed model is available for this item')
      const context = await dispatchContext(config, item, dryRun)
      const text = options.buildBrief?.(item, step) ?? dispatchBrief(item, step, context)
      const result = await session.send(item.sessionId, { text, model, sender: { botId: bot.id } })
      // Dispatch starts execution, so a native workspace todo becomes
      // `in_progress`. A dry run records the would-be status instead of touching
      // the file.
      await reflectNativeTodoStatus(bot, config, item.sourceId, 'in_progress', dryRun)
      return {
        output: { turn: result.turn, model },
        patch: { sessionModel: model },
        // A first dispatch becomes in progress; a follow-up keeps its state.
        ...(item.state === 'dispatched' ? { to: 'in_progress' as BotItemState } : {}),
      }
    },
  }

  /**
   * Send one rebase-conflict follow-up into the item's own session, reusing the
   * session's latest `turn.started` model (adopting it when it changed). Only
   * full session ids are used, and a send failure throws so the step is marked
   * failed rather than silently dropping the message.
   */
  async function sendRebaseConflictFollowUp(
    bot: BotRecord,
    item: BotItemRecord,
    conflict: ReturnType<ProjectManager['rebaseWorktree']>,
    config?: BotConfig,
  ): Promise<void> {
    await sendSessionFollowUp(bot, item, buildRebaseConflictText(item, conflict), config)
    store.appendLog({
      botId: bot.id,
      itemId: item.id,
      level: 'info',
      code: 'rebase.conflict_sent',
      message: `rebase conflict sent to session ${item.sessionId ?? '(unknown)'}`,
    })
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
    async run({ bot, item }) {
      if (!item.project || !item.worktreeId) throw new Error('item has no project worktree to merge')
      const result = await projectManager.mergeWorktree(item.project, item.worktreeId, { owner: ownerForItem(bot, item) })
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

  /**
   * Rebase the item's worktree onto the target branch before acceptance. This
   * is worktree-local (it never touches the base checkout or the target branch),
   * so it is not a side effect and also runs for real in dry-run mode. It runs
   * first in `accepting`, after the lane is held.
   */
  const rebaseStep: BotStepHandler = {
    // A rebase is proven done when the target head is already an ancestor of the
    // worktree head, so a restart never re-runs an already-successful rebase.
    async probe({ item }) {
      if (!item.project || !item.worktreeId) return 'unavailable'
      try {
        return projectManager.worktreeContainsTarget(item.project, item.worktreeId) ? 'done' : 'not-done'
      } catch {
        return 'unavailable'
      }
    },
    async run({ bot, item, config }) {
      if (!item.project || !item.worktreeId) throw new Error('item has no project worktree to rebase')
      const result = projectManager.rebaseWorktree(item.project, item.worktreeId)
      if (result.rebased) {
        // Success keeps the item in `accepting`; the next acceptance step is
        // enqueued from the item's state by advanceItem.
        return {
          output: result,
          ...(result.head_sha === undefined ? {} : { patch: { headSha: result.head_sha } }),
        }
      }
      if (result.reason === 'rebase_conflict') {
        const attempts = (item.counters?.acceptanceAttempts ?? 0) + 1
        const maxAttempts = config?.budgets.maxAcceptanceAttempts ?? DEFAULT_MAX_ACCEPTANCE_ATTEMPTS
        if (attempts > maxAttempts) {
          return {
            output: result,
            to: 'parked',
            patch: {
              parkedFrom: item.state,
              counters: { ...(item.counters ?? {}), acceptanceAttempts: attempts },
              question: `acceptance budget exhausted (${attempts}/${maxAttempts}) after repeated rebase conflicts onto ${result.target_branch ?? 'the target branch'}`,
              error: 'rebase_conflict',
            },
          }
        }
        // Reject in its own write (releasing the lane when the item later returns
        // to in_progress), then hand the conflicting paths and the target commits
        // that caused them back to the session for a fix.
        store.transitionItem(item.id, 'rejected', {
          counters: { ...(item.counters ?? {}), acceptanceAttempts: attempts },
          error: result.error ?? 'rebase_conflict',
        })
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'warn',
          code: 'rebase.conflict',
          message: `rebase of worktree ${item.worktreeId} onto ${result.target_branch ?? 'the target branch'} conflicted on ${result.conflicts?.length ?? 0} path(s)`,
        })
        await sendRebaseConflictFollowUp(bot, item, result, config)
        return { output: result, to: 'in_progress' }
      }
      // Any other failure (dirty worktree, missing metadata or path) parks the
      // item with that reason for a user decision.
      return {
        output: result,
        to: 'parked',
        patch: {
          parkedFrom: item.state,
          question: `rebase of worktree ${item.worktreeId} onto ${result.target_branch ?? 'the target branch'} failed: ${result.reason ?? 'unknown'}`,
          error: result.error ?? result.reason ?? 'rebase_failed',
        },
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
    // The effect is proven done once the item is in a lane state: the store
    // acquires the lane inside the same write that moves the item there.
    async probe({ item }) {
      return requiresDeliveryLane(item.state) ? 'done' : 'not-done'
    },
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
      const inbox = await openInbox(bot, config)
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

  /**
   * Verify one `discovered` item with the `bot-verify` judgment task in the
   * project checkout on the current default branch. `real` records the project,
   * class, brief and acceptance plan so dispatch can proceed; `not_real`
   * dismisses the item and queues its notification; `park` parks it with the
   * task's question. The run is detached: the tick that starts it records the
   * run id and returns, and a later tick maps the finished verdict. The task is
   * read-only, so a restart may safely retry it.
   */
  const verifyStep: BotStepHandler = {
    async probe({ item }) {
      return item.state === 'discovered' || item.state === 'verifying' ? 'not-done' : 'done'
    },
    async prepareTask({ bot, item, config }) {
      if (config === undefined) throw new Error('bot config is unavailable for verification')
      const runProject = item.project ?? config.projects[0]?.id
      if (runProject === undefined) {
        return {
          result: {
            to: 'parked',
            patch: { parkedFrom: item.state, question: 'no project is configured to verify this request against', error: 'no_project' },
          },
        }
      }
      const routed = routedModelFor(config, 'judgment')
      if (routed.target === undefined) noteAutomaticRouting(bot)
      // A verify run resumed from a park carries the user's answer so the
      // verifier can act on the clarification instead of asking again. The
      // built-in bot-verify input is strict and has no clarification field, so
      // the answer is appended to the request body as labeled text and the rest
      // of the request is preserved unchanged.
      const body =
        item.answer === undefined
          ? item.body
          : `${item.body === undefined || item.body === '' ? '' : `${item.body}\n\n`}User clarification:\n${item.answer}`
      return {
        input: {
          task: 'bot-verify',
          project: runProject,
          input: {
            request: { title: item.title ?? '', ...(body === undefined ? {} : { body }) },
            ...(item.project === undefined ? {} : { project: item.project }),
            projects: config.projects.map(policy => ({ id: policy.id })),
            classes: Object.keys(config.routing),
          },
          model: routed,
          ...(routed.target === undefined ? {} : { target: routed.target }),
        },
      }
    },
    async applyTaskResult({ bot, item, config }, output) {
      if (config === undefined) throw new Error('bot config is unavailable for verification')
      const verdict = asVerifyEnvelope(output)
      if (verdict === undefined) throw new Error('bot-verify returned an unrecognised decision')
      // A missing tool or environment is a capability gap, never a user decision:
      // report it once by its exact name. A gap that would otherwise park the item
      // leaves it retryable instead, so verification runs again once the
      // capability is present.
      if (verdict.capabilityGap !== undefined) {
        await watchdog(bot, config, 'capability', `${item.id}:${verdict.capabilityGap}`, `item ${item.id} cannot be verified: ${verdict.capabilityGap}`)
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'verify.capability_gap',
          message: verdict.capabilityGap,
        })
        if (verdict.decision === 'park') {
          const { attempt } = latestStep(item, 'verify')
          enqueueStep(item, 'verify', undefined, attempt + 1)
          return { output: verdict }
        }
      }
      if (verdict.decision === 'park') {
        return {
          output: verdict,
          to: 'parked',
          patch: { parkedFrom: item.state, question: verdict.question ?? verdict.reason, error: 'verify_parked' },
        }
      }
      if (verdict.decision === 'not_real') {
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'verify.not_real',
          message: `not dispatched: ${verdict.reason}`,
        })
        // Queued while the item is still `verifying`; both run on a later tick,
        // once the item is already dismissed and terminal.
        enqueueStep(item, 'annotate')
        enqueueStep(item, 'notify')
        return { output: verdict, to: 'dismissed', patch: { error: verdict.reason } }
      }
      const project = mapProject(config, verdict.project ?? item.project)
      if (project === undefined) {
        return {
          output: verdict,
          to: 'parked',
          patch: {
            parkedFrom: item.state,
            question: `unknown project "${verdict.project ?? ''}"; configured projects are ${config.projects.map(policy => policy.id).join(', ')}`,
            error: 'unknown_project',
          },
        }
      }
      const className = verdict.class === undefined || !(verdict.class in config.routing) ? 'default' : verdict.class
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'info',
        code: 'verify.real',
        message: `verified as real for ${project} (class ${className})`,
      })
      return { output: verdict, to: 'verified', patch: { project, class: className, error: null } }
    },
  }

  /**
   * Review one `in_progress` item with the `bot-review` judgment task, on new
   * ledger activity or after an idle timeout, and never while the session is
   * running a turn. The correction and ready follow-ups reuse the session's own
   * latest model, and corrections are capped by the bot budget. The run is
   * detached, and its verdict is applied on the tick that observes it finished.
   */
  const reviewStep: BotStepHandler = {
    // No probe on purpose: a started review whose run id was never recorded may
    // already have been started, so a restart marks it unknown rather than
    // re-running the judgment.
    async prepareTask({ bot, item, config }) {
      if (config === undefined) throw new Error('bot config is unavailable for review')
      if (item.sessionId === undefined) throw new Error('item has no session to review')
      if (item.project === undefined) throw new Error('item has no project to review')
      // The session may have started a turn between the enqueue and this run.
      if (sessionRunning(item.sessionId)) {
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'review.skipped',
          message: 'session is running a turn; review deferred',
        })
        return { result: {} }
      }
      // An answer that was handed to the session while its newer turn is still
      // starting or running defers the review: judging now would read the
      // pre-answer reply and re-park the item. The barrier is a ledger sequence,
      // so the same pending step is retried until the answer turn finishes.
      if (answerBarrierPending(item)) {
        throw new BotStepPending('review.answer_pending', `the answer turn for item ${item.id} has not finished; review deferred`, true)
      }
      const counters = item.counters ?? {}
      const envelope = verifyEnvelope(item)
      const diff = item.worktreeId === undefined
        ? ''
        : truncateHead(await projectManager.diff({ project: item.project, worktree_id: item.worktreeId }), MAX_DIFF_CHARS)
      const routed = routedModelFor(config, 'judgment')
      if (routed.target === undefined) noteAutomaticRouting(bot)
      return {
        input: {
          task: 'bot-review',
          project: item.project,
          ...(item.worktreeId === undefined ? {} : { worktree: item.worktreeId }),
          input: {
            request: { title: item.title ?? '', ...(item.body === undefined ? {} : { body: item.body }) },
            brief: envelope?.brief ?? '',
            worktree: item.worktreeId ?? '',
            diff,
            recentTurns: recentReplies(item, MAX_TURNS_CHARS),
            corrections: counters.corrections ?? 0,
          },
          model: routed,
          ...(routed.target === undefined ? {} : { target: routed.target }),
        },
      }
    },
    async applyTaskResult({ bot, item, step, config, dryRun }, output) {
      if (config === undefined) throw new Error('bot config is unavailable for review')
      if (item.sessionId === undefined) throw new Error('item has no session to review')
      const counters = item.counters ?? {}
      const corrections = counters.corrections ?? 0
      const verdict = asReviewEnvelope(output)
      if (verdict === undefined) throw new Error('bot-review returned an unrecognised verdict')
      // A review that raced an answer must never act on the pre-answer reply: the
      // answer arrived after this review sampled the ledger (the sample is stored
      // on the review step itself, not on the shared counters) or the answer turn
      // is still in flight. The verdict is discarded and a fresh review runs once
      // the answer turn has finished.
      const sampled = stepInput<{ sampledSeq?: unknown }>(step)?.sampledSeq
      const sampledSeq = typeof sampled === 'number' ? sampled : undefined
      const answeredDuringReview = counters.answerSeq !== undefined
        && (sampledSeq === undefined || counters.answerSeq >= sampledSeq)
      if (answerBarrierPending(item) || answeredDuringReview) {
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'review.deferred_answer',
          message: 'the item was answered while the review was in flight; the verdict is discarded',
        })
        return { output: { ...verdict, deferred: 'answered' } }
      }
      // Mark the review point so the next review waits for new activity (or the
      // idle window) instead of running every tick.
      const reviewed = {
        ...counters,
        lastReviewSeq: latestEventSeq(item.sessionId),
        lastReviewAtMs: Date.now(),
      }
      // A missing tool or environment is a capability gap, not a user decision:
      // report it once by its exact name, keep the item on track and increment no
      // correction, whatever verdict came with it.
      if (verdict.capabilityGap !== undefined) {
        await watchdog(bot, config, 'capability', `${item.id}:${verdict.capabilityGap}`, `item ${item.id} cannot be verified: ${verdict.capabilityGap}`)
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'review.capability_gap',
          message: verdict.capabilityGap,
        })
        return { output: verdict, patch: { counters: reviewed } }
      }
      if (verdict.verdict === 'park') {
        return {
          output: verdict,
          to: 'parked',
          patch: { parkedFrom: 'in_progress', question: verdict.question ?? verdict.reason, error: 'review_parked' },
        }
      }
      if (verdict.verdict === 'continue') {
        // A session that finished its turn without `BOT-READY` or `BOT-BLOCKED`
        // would wait here forever, so a continuing verdict nudges it once per
        // finished turn; the counters are built on `reviewed` so the review
        // point and the nudge bookkeeping persist together.
        const nudge = decideStalledNudge(item, config, reviewed)
        await applyStalledNudge(bot, item, nudge, config)
        return { output: verdict, patch: { counters: nudge.kind === 'none' ? reviewed : nudge.counters } }
      }
      if (verdict.verdict === 'correct') {
        if (corrections + 1 > config.budgets.maxCorrections) {
          // An exhausted correction budget on a non-converging session is not a
          // user decision: report it once as a watchdog and leave the item
          // retryable instead of parking it on a question.
          await watchdog(bot, config, 'corrections', item.id, `item ${item.id} still needs correction after ${corrections} attempt(s), budget ${config.budgets.maxCorrections}: ${verdict.reason}`)
          store.appendLog({
            botId: bot.id,
            itemId: item.id,
            level: 'info',
            code: 'review.corrections_exhausted',
            message: verdict.reason,
          })
          return { output: verdict, patch: { counters: reviewed } }
        }
        await sendSessionFollowUp(bot, item, verdict.correction ?? verdict.reason, config)
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'review.correction',
          message: `correction ${corrections + 1}/${config.budgets.maxCorrections} sent: ${verdict.reason}`,
        })
        return { output: verdict, patch: { counters: { ...reviewed, corrections: corrections + 1 } } }
      }
      const gate = await checkReadyGate(item)
      if (gate.ok) {
        // Execution is finished: a native workspace todo reaches `done` here,
        // before acceptance later persists `accepted`. The guarded write runs
        // before the `ready` transition, so a refused or failed write keeps the
        // item out of acceptance and the step retries.
        await reflectNativeTodoStatus(bot, config, item.sourceId, 'done', dryRun)
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'review.ready',
          message: 'the ready gate passed; the item enters acceptance',
        })
        return { output: { ...verdict, gate: 'passed' }, to: 'ready', patch: { counters: reviewed } }
      }
      await sendSessionFollowUp(
        bot,
        item,
        `The work is not ready to accept yet: ${gate.failed}. Finish the change, commit in your worktree, and reply \`BOT-READY <head sha>\`.`,
        config,
      )
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'info',
        code: 'review.gate_failed',
        message: `ready gate failed: ${gate.failed}`,
      })
      return { output: { ...verdict, gate: 'failed', failed: gate.failed }, patch: { counters: reviewed } }
    },
  }

  /**
   * Acceptance for a lane-holding `accepting` item after its rebase: check the
   * operation components the plan requires, run the builtin `test` task bound to
   * the item's worktree, map its assessments back onto the plan's checks and
   * gate the item on them. A required component that is not ready parks the
   * item; a busy desktop component leaves the step pending for a later tick. The
   * run is detached, so an acceptance that takes minutes blocks no other item.
   */
  const acceptStep: BotStepHandler = {
    // The effect is a local task run, so a started-but-unfinished acceptance is
    // simply retried; recorded checks prove whether it already finished.
    async probe({ item }) {
      return item.acceptance !== undefined && item.acceptance.length > 0 ? 'done' : 'not-done'
    },
    // Component readiness and the desktop-busy deferral run before the task is
    // started, so a run that needs a busy single-owner component never starts.
    async prepareTask({ bot, item, config }) {
      if (config === undefined) throw new Error('bot config is unavailable for acceptance')
      if (!item.project || !item.worktreeId) throw new Error('item has no project worktree to accept')
      const plan = acceptancePlan(item)
      if (plan.length === 0) {
        return {
          result: {
            to: 'parked',
            patch: { parkedFrom: item.state, question: 'the item has no acceptance plan', error: 'no_acceptance_plan' },
          },
        }
      }
      const runtimeChecks = plan.filter(check => check.surface !== 'static')
      if (runtimeChecks.length === 0) {
        return {
          result: {
            to: 'parked',
            patch: {
              parkedFrom: item.state,
              question: 'the acceptance plan has no runtime check; a static check cannot verify the change',
              error: 'no_runtime_check',
            },
          },
        }
      }
      const notReady = await checkComponents(plannedSurfaceComponents(runtimeChecks))
      if (notReady !== undefined) {
        const detail = `${notReady.name} is ${notReady.state} on host ${notReady.host}`
        // A missing or non-ready acceptance component is a capability gap, not a
        // user decision: it is reported once as a watchdog/escalation naming the
        // exact component, and the step stays pending so a later tick retries
        // (for example after the component is installed) instead of parking the
        // item on a question for the user.
        await watchdog(bot, config, 'component', `${item.id}:${notReady.id}`, `item ${item.id} needs the ${notReady.id} operation component for acceptance but it is ${notReady.state} on host ${notReady.host}`)
        throw new BotStepPending('acceptance.component', `acceptance needs a ready operation component: ${detail}`, true)
      }
      const capability = runtimeChecks.some(check => check.surface === 'native')
        ? 'computer-use' as const
        : runtimeChecks.some(check => check.surface === 'renderer') ? 'browser-use' as const : undefined
      const routed = routedModelFor(config, 'acceptance')
      if (routed.target === undefined) noteAutomaticRouting(bot)
      return {
        input: {
          task: 'test',
          project: item.project,
          worktree: item.worktreeId,
          input: {
            acceptance_criteria: runtimeChecks.map(check => ({
              id: check.id,
              given: `the ${check.surface} surface of ${item.project}`,
              when: check.recipe,
              then: check.claim,
            })),
            ...(capability === undefined ? {} : { capability }),
          },
          model: routed,
          ...(routed.target === undefined ? {} : { target: routed.target }),
        },
      }
    },
    async applyTaskResult({ bot, item, config, dryRun }, output) {
      if (config === undefined) throw new Error('bot config is unavailable for acceptance')
      const checks = mapAcceptanceChecks(acceptancePlan(item), output)
      const acceptanceAttempts = (item.counters?.acceptanceAttempts ?? 0) + 1
      const maxAttempts = config.budgets.maxAcceptanceAttempts
      const failed = checks.filter(check => check.status === 'failed')
      if (failed.length > 0) {
        if (acceptanceAttempts > maxAttempts) {
          return {
            output,
            to: 'parked',
            patch: {
              parkedFrom: item.state,
              acceptance: checks,
              counters: { ...(item.counters ?? {}), acceptanceAttempts },
              question: `acceptance budget exhausted (${acceptanceAttempts}/${maxAttempts}); failing checks: ${failed.map(check => check.claim).join('; ')}`,
              error: 'acceptance_failed',
            },
          }
        }
        // Acceptance failed and the session resumes work: a native workspace todo
        // that still reads `done` (execution finished) goes back to
        // `in_progress`. The guarded write runs before the bot transition
        // commits, so a refused or failed write retries instead of advancing.
        await reflectNativeTodoStatus(bot, config, item.sourceId, 'in_progress', dryRun)
        store.transitionItem(item.id, 'rejected', {
          acceptance: checks,
          counters: { ...(item.counters ?? {}), acceptanceAttempts },
          error: 'acceptance_failed',
        })
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'warn',
          code: 'acceptance.failed',
          message: `${failed.length} check(s) failed; the session was asked to fix them`,
        })
        await sendSessionFollowUp(bot, item, buildAcceptanceFailureText(item, checks, output), config)
        return { output, to: 'in_progress' }
      }
      const unverified = checks.filter(check => check.status === 'not_verified')
      if (unverified.length > 0) {
        // A sensitive action the runner may not take on its own is the one gap
        // that is genuinely the user's decision: it carries the exact
        // `needs user confirmation: <action>` reason and keeps the park.
        const permission = unverified.find(check => isUserQuestion(check.note ?? ''))
        if (permission !== undefined) {
          return {
            output,
            to: 'parked',
            patch: {
              parkedFrom: item.state,
              acceptance: checks,
              counters: { ...(item.counters ?? {}), acceptanceAttempts },
              question: permission.note ?? `acceptance could not verify: ${permission.claim}`,
              error: 'acceptance_needs_user',
            },
          }
        }
        // Every other gap (a missing component or environment, an unobservable
        // surface, a blocked run) is not a user question: report it once by its
        // exact reason and retry acceptance on a later tick.
        const reasons = unverified.map(check => `${check.claim} (${check.note ?? 'not verified'})`).join('; ')
        await watchdog(bot, config, 'acceptance_gap', item.id, `item ${item.id} acceptance could not verify: ${reasons}`)
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'acceptance.not_a_question',
          message: reasons,
        })
        const { attempt } = latestStep(item, 'accept')
        enqueueStep(item, 'accept', { counters: { ...(item.counters ?? {}), acceptanceAttempts } }, attempt + 1)
        return { output }
      }
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'info',
        code: 'acceptance.passed',
        message: `all ${checks.length} check(s) verified`,
      })
      // Acceptance is a source status of its own. A native workspace todo moves
      // to `accepted`, which is independent of the later `complete` (execution
      // finished) write and is never downgraded by it; a dry run records the
      // would-be status instead of writing it.
      await reflectNativeTodoStatus(bot, config, item.sourceId, 'accepted', dryRun)
      return {
        output,
        to: 'accepted',
        patch: { acceptance: checks, counters: { ...(item.counters ?? {}), acceptanceAttempts } },
      }
    },
  }

  /**
   * Write the outcome back to the source item. The inbox adapter may not
   * implement `annotate`; an adapter error is logged and the step still
   * succeeds, because the annotation is a courtesy rather than a delivery
   * guarantee.
   */
  const annotateStep: BotStepHandler = {
    sideEffect: true,
    dryRun: ({ item }) => ({
      output: { dryRun: true, wouldAnnotate: { sourceId: item.sourceId, text: dismissReason(item) } },
    }),
    async run({ bot, item, config }) {
      if (config === undefined) throw new Error('bot config is unavailable for inbox.annotate')
      const text = dismissReason(item)
      try {
        const inbox = await openInbox(bot, config)
        const result = await inbox.annotate(item.sourceId, text)
        resetAdapterErrors(bot.id)
        // The annotation edits the source item itself; adopting the annotated
        // text as this generation's fingerprint keeps the bot's own note from
        // reopening the item as a user change on the next poll.
        const annotated = result.ok ? (await inbox.get(item.sourceId)).item : null
        return {
          output: { annotated: result.ok },
          ...(annotated === null ? {} : { patch: { fingerprint: itemFingerprint(annotated) } }),
        }
      } catch (error) {
        const code = error instanceof BotAdapterError ? error.code : 'adapter.error'
        store.appendLog({
          botId: bot.id,
          itemId: item.id,
          level: 'info',
          code: 'annotate.skipped',
          message: `inbox.annotate is not available (${code})`,
        })
        return { output: { annotated: false, reason: code } }
      }
    },
  }

  const handlers: Partial<Record<BotStepKind, BotStepHandler>> = {
    verify: verifyStep,
    review: reviewStep,
    accept: acceptStep,
    'lane.acquire': laneAcquire,
    'worktree.create': worktreeCreate,
    'session.create': sessionCreate,
    'session.send': sessionSend,
    rebase: rebaseStep,
    merge: mergeStep,
    push: pushStep,
    'inbox.complete': inboxCompleteStep,
    annotate: annotateStep,
    notify: notifyStep,
  }

  // ── inbox polling and source checks ──────────────────────────────────────

  function pollDue(bot: BotRecord, nowMs: number): boolean {
    if (bot.nextPollAt === undefined) return true
    const due = Date.parse(bot.nextPollAt)
    return Number.isNaN(due) ? true : due <= nowMs
  }

  /**
   * True when a `bot.tick` for this bot may force a poll now, and records the
   * attempt. Forced polls are spaced by {@link FORCED_POLL_MIN_INTERVAL_MS} so
   * repeated ticks fall back to the ordinary cadence instead of polling on
   * every call.
   */
  function forcedPollAllowed(botId: string, nowMs: number): boolean {
    const last = forcedPollAt.get(botId)
    if (last !== undefined && nowMs - last < FORCED_POLL_MIN_INTERVAL_MS) return false
    forcedPollAt.set(botId, nowMs)
    return true
  }

  /** How one successful poll's source set differs from the previous one. */
  function pollSnapshotDiff(
    previous: Map<string, string> | undefined,
    current: Map<string, string>,
  ): { first: boolean; added: number; removed: number; changed: number } {
    // The first poll after host start has no baseline: it always counts as a
    // change, so the log states what the inbox held when the bot started.
    if (previous === undefined) return { first: true, added: current.size, removed: 0, changed: 0 }
    let added = 0
    let changed = 0
    for (const [id, fingerprint] of current) {
      const before = previous.get(id)
      if (before === undefined) added += 1
      else if (before !== fingerprint) changed += 1
    }
    let removed = 0
    for (const id of previous.keys()) if (!current.has(id)) removed += 1
    return { first: false, added, removed, changed }
  }

  /**
   * Record one successful poll. A result that differs from the previous
   * successful poll (source id set or fingerprints) writes one info
   * `poll.changed` row with its counts. A routine repeat writes nothing at info
   * level: it is only reported by one debug `poll.unchanged` row per hour, so an
   * 8-hour run does not bury verify/session/review events under poll noise.
   */
  function recordPollOutcome(bot: BotRecord, listed: readonly InboxItem[]): void {
    const current = new Map(listed.map(item => [item.id, itemFingerprint(item)]))
    const diff = pollSnapshotDiff(pollSnapshots.get(bot.id), current)
    pollSnapshots.set(bot.id, current)
    if (diff.first || diff.added > 0 || diff.removed > 0 || diff.changed > 0) {
      unchangedPolls.delete(bot.id)
      store.appendLog({
        botId: bot.id,
        level: 'info',
        code: 'poll.changed',
        message: `inbox changed: ${listed.length} item(s), ${diff.added} new, ${diff.removed} removed, ${diff.changed} changed`,
      })
      return
    }
    const nowMs = Date.now()
    const run = unchangedPolls.get(bot.id) ?? { count: 0, since: nowIso() }
    run.count += 1
    if (run.loggedAt !== undefined && nowMs - run.loggedAt < UNCHANGED_POLL_LOG_INTERVAL_MS) {
      unchangedPolls.set(bot.id, run)
      return
    }
    run.loggedAt = nowMs
    unchangedPolls.set(bot.id, run)
    store.appendLog({
      botId: bot.id,
      level: 'debug',
      code: 'poll.unchanged',
      message: `inbox unchanged for ${run.count} polls since ${run.since}`,
    })
  }

  /**
   * Base poll interval for one bot: the bot config's `cadence.pollMinutes`, or
   * the host default when the bot has no usable config.
   */
  function pollBaseMs(config: BotConfig | undefined): number {
    const minutes = config?.cadence.pollMinutes
    if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return pollMs
    return minutes * 60_000
  }

  /**
   * Schedule the next poll from the bot's configured cadence: a failed poll or
   * an active load back-off doubles the interval up to the existing maximum,
   * and a healthy poll resets it. It never falls below the configured base.
   */
  function scheduleNextPoll(bot: BotRecord, config: BotConfig | undefined, failed: boolean): void {
    const base = pollBaseMs(config)
    const current = pollBackoff.get(bot.id) ?? base
    const next = failed || isBackedOff(bot.id)
      ? Math.max(Math.min(current * 2, MAX_POLL_BACKOFF_MS), base)
      : base
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
    // Items being worked on count against maxActiveItems; parked items wait on
    // a decision and do not. New sources wait until a slot frees up.
    let active = store.listItems(bot.id).filter(item =>
      item.state === 'discovered' || item.state === 'verifying' || IN_FLIGHT_ITEM_STATES.includes(item.state)).length
    let admitted = 0
    for (const source of listed) {
      const fingerprint = itemFingerprint(source)
      const existing = store.findItemBySource(bot.id, source.id)
      if (existing === undefined) {
        if (active >= config.concurrency.maxActiveItems) {
          store.appendLog({
            botId: bot.id,
            level: 'info',
            code: 'poll.capacity',
            message: `${active} active item(s) reach maxActiveItems ${config.concurrency.maxActiveItems}; new items wait`,
          })
          break
        }
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
        active += 1
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

      parkForSourceChange(bot, existing, source, fingerprint)
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
    const inbox = await openInbox(bot, config)
    let listed: InboxItem[]
    try {
      listed = (await inbox.list()).items
    } catch (error) {
      recordAdapterError(bot, config, config.inbox, 'list', error)
      scheduleNextPoll(bot, config, true)
      return true
    }
    resetAdapterErrors(bot.id)
    recordPollOutcome(bot, listed)
    applyInboxSnapshot(bot, config, listed)
    await confirmWithdrawals(bot, config, inbox, listed)
    scheduleNextPoll(bot, config, false)
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

  /**
   * Park an in-flight item whose source text changed since it was dispatched.
   * The new text and fingerprint are adopted now, so answering `continue`
   * resumes with them instead of re-parking on the same change at the next poll.
   */
  function parkForSourceChange(bot: BotRecord, item: BotItemRecord, source: { title: string; body?: string }, fingerprint: string): void {
    try {
      store.transitionItem(item.id, 'parked', {
        parkedFrom: item.state,
        question: `source changed: "${item.title ?? ''}" -> "${source.title}"; answer 'continue' to use the new text or 'dismiss'`,
        error: 'source_changed',
        fingerprint,
        title: source.title,
        body: source.body ?? null,
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
   * Park a `verified` item whose native workspace source is no longer open, so
   * it is not dispatched against a withdrawn source or an unfinished/cancelled
   * dependency. Mirrors {@link parkForSourceChange}: the reason is durable and a
   * user answer returns the item to `verified` for a fresh check.
   */
  function parkUndispatchableSource(bot: BotRecord, item: BotItemRecord): void {
    try {
      store.transitionItem(item.id, 'parked', {
        parkedFrom: 'verified',
        question: 'the source todo is no longer open (withdrawn, or a dependency is unfinished or cancelled); answer to retry once it is ready',
        error: 'source_not_dispatchable',
      })
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'warn',
        code: 'dispatch.blocked',
        message: `item ${item.id} not dispatched: the source todo is no longer open`,
      })
    } catch (error) {
      store.appendLog({
        botId: bot.id,
        itemId: item.id,
        level: 'error',
        code: 'dispatch.block_failed',
        message: `could not hold item ${item.id}: ${errorMessage(error)}`,
      })
    }
  }

  /**
   * Ask the inbox whether an item's source is still open and unchanged. Runs
   * immediately before merge and before inbox.complete; an adapter error is
   * retryable, never a withdrawal.
   *
   * The `open` flag of a workspace inbox means "dispatchable", so `done` and
   * `accepted` report it false even though the source is not withdrawn. A
   * workspace source is therefore read through the todo service: it is `gone`
   * only when the todo is missing or cancelled, `changed` when the inbox
   * fingerprint differs for any other state (including `done`/`accepted`), and
   * `retry` on any other read error. A command (Things) or MCP inbox keeps the
   * open-flag check.
   */
  async function gateSource(bot: BotRecord, config: BotConfig, item: BotItemRecord): Promise<SourceGate> {
    const inbox = await openInbox(bot, config)
    try {
      if (config.inbox.kind === 'workspace') {
        const todo = await workspaceTodoService.getTodo(item.sourceId)
        if (todo.status === 'cancelled') return 'gone'
        const fetched = (await inbox.get(item.sourceId)).item
        if (fetched === null) return 'gone'
        const fingerprint = itemFingerprint(fetched)
        if (item.fingerprint !== undefined && fingerprint !== item.fingerprint) return { changed: fetched, fingerprint }
        resetAdapterErrors(bot.id)
        return 'open'
      }
      const fetched = (await inbox.get(item.sourceId)).item
      if (fetched === null || fetched.open !== true) return 'gone'
      const fingerprint = itemFingerprint(fetched)
      if (item.fingerprint !== undefined && fingerprint !== item.fingerprint) return { changed: fetched, fingerprint }
      resetAdapterErrors(bot.id)
      return 'open'
    } catch (error) {
      if (error instanceof WorkspaceTodoError && error.code === 'missing') return 'gone'
      recordAdapterError(bot, config, config.inbox, 'get', error)
      return 'retry'
    }
  }

  // ── step scheduling ──────────────────────────────────────────────────────

  function idemKeyFor(item: BotItemRecord, kind: BotStepKind, attempt = 1): string {
    return `${item.id}:${item.generation}:${kind}:${attempt}`
  }

  /** Insert one pending step unless its idempotency key already exists. */
  function enqueueStep(item: BotItemRecord, kind: BotStepKind, patch?: BotItemPatch, attempt = 1, input?: unknown): BotStepRecord | undefined {
    const idemKey = idemKeyFor(item, kind, attempt)
    if (store.findStepByIdemKey(idemKey) !== undefined) return undefined
    const { step } = store.beginStep({
      itemId: item.id,
      kind,
      idemKey,
      ...(patch === undefined ? {} : { patch }),
      ...(input === undefined ? {} : { input }),
    })
    return step
  }

  /**
   * Enqueue one step unless a done attempt of the same kind already exists.
   * Returns true while the item must wait, because a new or unfinished step is
   * queued; false lets the caller move on to the next step of the chain.
   */
  function ensureStep(item: BotItemRecord, kind: BotStepKind): boolean {
    const existing = store.findStepByIdemKey(idemKeyFor(item, kind))
    if (existing === undefined) {
      enqueueStep(item, kind)
      return true
    }
    return existing.status !== 'done'
  }

  /**
   * Enqueue the next step of an item that is waiting for one: verify when it is
   * `discovered`, the dispatch chain (worktree, session, brief) when it is
   * `verified` or `dispatched`, a review when it is `in_progress`, the lane
   * acquire when it is `ready`, then rebase and acceptance in `accepting`, merge
   * after acceptance, push after merge, then inbox.complete and notify in
   * `completing`, so a pushed item always reaches `completed`.
   */
  async function advanceItem(bot: BotRecord, item: BotItemRecord, config?: BotConfig): Promise<void> {
    if (isTerminalItemState(item.state)) return
    if (item.state === 'discovered') {
      // The deterministic discovered -> verifying write happens with the step.
      enqueueStep(item, 'verify', { state: 'verifying' })
      return
    }
    if (item.state === 'verifying') {
      // A verify park resumed by a public answer returns the item here with the
      // answer stored. Its first attempt is already done, so one fresh attempt
      // above the last one is scheduled; the answer reaches the verifier through
      // the verify task input. Only a completed step schedules the retry: a
      // pending, failed, unknown, or missing step never queues a second run, and
      // a run id left on a done step is history, not an in-flight run.
      if (item.answer === undefined) return
      const { step, attempt } = latestStep(item, 'verify')
      if (step === undefined || step.status !== 'done') return
      enqueueStep(item, 'verify', undefined, attempt + 1)
      return
    }
    if (item.state === 'verified') {
      // Load back-off holds new dispatch: while the daemon is loaded, no
      // worktree is created for a newly verified item. Items already dispatched
      // are unaffected, and every other step still runs.
      if (isBackedOff(bot.id)) return
      // Native-only safeguard: a workspace todo whose source was withdrawn, or
      // whose dependency is no longer done/accepted, is held instead of being
      // dispatched against stale source state. A failed re-read leaves the item
      // `verified` (neither parked nor dispatched) so the check retries later.
      const sourceState = await nativeSourceDispatchable(bot, config, item.sourceId)
      if (sourceState === 'blocked') {
        parkUndispatchableSource(bot, item)
        return
      }
      if (sourceState === 'retry') return
      // Worktree, then session, then the brief; each waits for the previous.
      if (ensureStep(item, 'worktree.create')) return
      ensureStep(item, 'session.create')
      return
    }
    if (item.state === 'dispatched') {
      enqueueStep(item, 'session.send')
      return
    }
    if (item.state === 'in_progress') {
      // Review only on new ledger activity or after an idle timeout, and never
      // while the session is running a turn. Each review is a new attempt, so
      // the journal keeps every verdict.
      const { step, attempt } = latestStep(item, 'review')
      if (step?.status === 'pending') return
      if (item.sessionId === undefined || sessionRunning(item.sessionId)) return
      if (!reviewDue(item)) {
        // Nothing changed, so no review runs. A session that has been idle past
        // the idle window and still carries no closing marker will never move on
        // its own, so it is nudged once per finished turn.
        const idle = sessionIdleMs(item)
        if (idle !== undefined && idle > REVIEW_IDLE_MS && !answerBarrierPending(item)) {
          await applyStalledNudge(bot, item, decideStalledNudge(item, config), config)
        }
        return
      }
      // The ledger point is stored on the review step itself, so the later
      // verdict can tell whether the session was answered while the review ran.
      enqueueStep(item, 'review', undefined, attempt + 1, { sampledSeq: latestEventSeq(item.sessionId) })
      return
    }
    if (item.state === 'ready') {
      // Deterministic ready -> accepting: the store takes the project's lane
      // inside the state write, and a busy lane leaves the item in `ready` to
      // retry on a later tick.
      enqueueStep(item, 'lane.acquire')
      return
    }
    if (item.state === 'accepting') {
      // Rebase runs first; acceptance follows once it is done. A failed or
      // unproven acceptance runs again as a new attempt while no checks are
      // recorded yet.
      if (ensureStep(item, 'rebase')) return
      const { step, attempt } = latestStep(item, 'accept')
      if (step === undefined) {
        enqueueStep(item, 'accept')
        return
      }
      if (step.status === 'pending') return
      if ((item.acceptance?.length ?? 0) === 0) enqueueStep(item, 'accept', undefined, attempt + 1)
      return
    }
    if (item.state === 'accepted') {
      // The deterministic accepted -> merging write happens with the step, and
      // the item keeps the project lane across both states.
      enqueueStep(item, 'merge', { state: 'merging' })
      return
    }
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
    const run = handler.run
    if (run === undefined) throw new Error(`step ${step.kind} has no run handler`)
    store.markStepStarted(step.id)
    return await run(context)
  }

  async function runStep(bot: BotRecord, step: BotStepRecord, config: BotConfig | undefined): Promise<void> {
    const item = store.getItem(bot.id, step.itemId)
    if (isTerminalItemState(item.state) && !RESOLVED_ITEM_STEPS.has(step.kind)) {
      // A step of a resolved item (for example after a withdrawal cancelled its
      // siblings) is never re-run. The closing effects of a resolved item — its
      // notification and its inbox annotation — still run exactly once.
      store.markStepStatus(step.id, 'unknown')
      return
    }
    const handler = handlers[step.kind]
    if (handler === undefined) {
      reportUnavailable(bot, item, step)
      return
    }
    if (canRun?.() === false) return
    // Load back-off: while the daemon is loaded, no new dispatch worktree is
    // created and no new verify/review/accept task run is started. A task run
    // that already started keeps being polled, and merge, push, completion and
    // notification are never held back.
    if (isBackedOff(bot.id)) {
      const startsDispatch = step.kind === 'worktree.create'
      const startsTaskRun = DETACHED_TASK_KIND[step.kind] !== undefined && detachedRunId(step) === undefined
      if (startsDispatch || startsTaskRun) return
    }
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
        if (typeof gate === 'object') {
          parkForSourceChange(bot, item, gate.changed, gate.fingerprint)
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
      const result = await (handler.prepareTask !== undefined
        ? runDetachedTask(step, context, handler)
        : handler.sideEffect === true && context.dryRun
          ? (handler.dryRun?.(context) ?? { output: { dryRun: true, wouldRun: step.kind } })
          : runEffect(step, context, handler))
      if (result.pendingRun !== undefined) {
        // Only the run was started: record its id on the still-pending step so
        // the next tick polls it instead of starting a second run.
        store.recordStepOutput(step.id, result.pendingRun)
        return
      }
      commitStep(item, step, result)
    } catch (error) {
      if (error instanceof BotStepRunning) {
        // The detached run is still in flight; the step stays pending and is
        // polled again on a later tick, with no tick blocked on the model.
        return
      }
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
      if (error instanceof BotStepPending) {
        // The step must wait for a later tick (a single-owner component is busy,
        // for example); it stays pending and is retried, not failed. A pending
        // cause already reported once (for example by a watchdog) is not logged
        // again on every tick.
        if (!error.reported) store.appendLog({ botId: bot.id, itemId: item.id, level: 'info', code: error.code, message: error.message })
        return
      }
      if (error instanceof BotStepRunFailed) {
        // The task run itself failed: count it and retry as a fresh attempt
        // while the item keeps its state (and its lane) instead of parking on
        // the first flaky run.
        await handleDetachedRunFailure(context, error.runId, error.message)
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
      if (isTerminalItemState(item.state) && !RESOLVED_ITEM_STEPS.has(step.kind)) {
        store.markStepStatus(step.id, 'unknown')
        continue
      }
      const context: BotStepContext = { bot, item, step, dryRun: bot.mode === 'dryRun' || item.dryRun }
      // A detached task step that already started keeps being polled: its run is
      // durable, so a restart never marks it unknown mid-flight, and a run that
      // cannot be found any more is counted and retried (`task run missing`)
      // instead of parking on the first occurrence. These steps have no outward
      // effect.
      const runId = detachedRunId(step)
      if (runId !== undefined) {
        const outcome = await pollDetachedRun(runId, DETACHED_TASK_KIND[step.kind] ?? step.kind)
        if (outcome.kind === 'failed') {
          // The run ended badly while the daemon was down: apply the same
          // counted retry rule as a live tick, using the bot's own budget.
          const load = await loadConfigForBot(bot)
          await handleDetachedRunFailure(
            {
              bot,
              item,
              step,
              ...(load.status === 'ready' ? { config: load.config } : {}),
              dryRun: bot.mode === 'dryRun' || item.dryRun,
            },
            runId,
            outcome.message,
          )
        }
        // `running` keeps polling; a finished run is applied by the next tick.
        continue
      }
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
      // An answer follow-up send never moves the item: the answer resumes the
      // state it parked from, so a proven answer send must not force it to
      // `in_progress` (which would also drop the project lane).
      if (handler.doneState !== undefined && handler.doneState !== item.state && answerTextFromStep(step) === undefined) {
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

  /** This bot's cadence counters, created on first use. */
  function tickStats(botId: string): BotTickStats {
    const existing = botTickStats.get(botId)
    if (existing !== undefined) return existing
    const fresh: BotTickStats = { ticks: 0, forcedTicks: 0, lastLagMs: 0, maxLagMs: 0 }
    botTickStats.set(botId, fresh)
    return fresh
  }

  /**
   * The tick cadence one bot asks for: its config's `cadence.tickSeconds`
   * (minimum {@link MIN_TICK_MS}), or the default when it has no usable config.
   */
  function botCadenceMs(config: BotConfig | undefined): number {
    const seconds = config?.cadence.tickSeconds
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TICK_MS
    return Math.max(seconds * 1_000, MIN_TICK_MS)
  }

  /**
   * One tick pass: poll due inboxes, watch the sources already admitted, advance
   * items whose next step is due, then run the pending steps. Every tick path
   * (timer, start, public `bot.tick`) runs through {@link scheduleTick}, so two
   * passes are never in flight at once and each pass re-checks `stopped` and the
   * admission gate.
   *
   * The single host timer runs at the smallest cadence any config may ask for,
   * so a pass only advances a bot whose own `cadence.tickSeconds` has elapsed
   * since that bot's last cadence pass; the first pass after start always runs.
   * A pass a client asked for with `bot.tick` is forced: it advances its bot
   * immediately without disturbing the bot's cadence. `scheduledAt` marks a
   * cadence timer pass, so health can report timed and forced passes separately.
   */
  async function tickPass(scheduledAt?: number, botId?: string, forced = false): Promise<void> {
    if (stopped || canRun?.() === false) return
    // An untargeted pass with no bots has nothing to advance: return before
    // the load probe and the bot listing so an idle daemon runs no SQL per tick.
    if (botId === undefined && !store.hasBots()) return
    const tickStartedAt = clock()
    // Read the daemon load once per pass: it gates new work for every bot.
    const probe = await probeLoad()
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
      await checkLowDisk(bot, config)
      // The bot's own cadence gates a timer pass; a forced pass is never gated.
      const cadenceMs = botCadenceMs(config)
      const lastCadence = lastBotCadenceAt.get(bot.id)
      const dueAt = lastCadence === undefined ? tickStartedAt : lastCadence + cadenceMs
      if (!forced && lastCadence !== undefined && tickStartedAt < dueAt) continue
      const stats = tickStats(bot.id)
      if (scheduledAt !== undefined) {
        // Lag is this bot's own due time, not the host timer's.
        stats.lastLagMs = Math.max(0, tickStartedAt - dueAt)
        stats.maxLagMs = Math.max(stats.maxLagMs, stats.lastLagMs)
      }
      applyLoadBackoff(bot, probe.load, watchdogsFor(config))
      // A `bot.tick` forces a poll, but at most once per
      // FORCED_POLL_MIN_INTERVAL_MS; every other pass polls only when due.
      const force = forced && forcedPollAllowed(bot.id, tickStartedAt)
      const polled = config === undefined ? false : await pollBot(bot, config, force)
      if (stopped) return
      for (const item of store.listItems(bot.id)) {
        if (stopped) return
        await advanceItem(bot, item, config)
      }
      // Watchdogs run before the steps: a stuck run cancelled or an item parked
      // here is reflected in this same pass instead of the next one.
      await runWatchdogs(bot, config, probe.load, probe.error)
      if (stopped) return
      for (const step of store.listPendingSteps(bot.id)) {
        if (stopped) return
        await runStep(bot, step, config)
      }
      const fresh = store.getBot(bot.id)
      store.updateBot(bot.id, {
        lastTickAt: nowIso(),
        ...(polled || fresh.nextPollAt !== undefined
          ? {}
          : { nextPollAt: new Date(tickStartedAt + pollBaseMs(config)).toISOString() }),
      })
      // Only a non-forced pass moves the bot's cadence clock, and only a timer
      // pass counts as a cadence tick; a `bot.tick` pass is counted separately
      // so an eager client cannot distort the endurance numbers.
      if (forced) stats.forcedTicks += 1
      else lastBotCadenceAt.set(bot.id, tickStartedAt)
      if (scheduledAt !== undefined) stats.ticks += 1
    }
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
    nextTickAt = Date.now() + timerMs
    timer = setInterval(() => {
      const scheduled = nextTickAt
      nextTickAt += timerMs
      void scheduleTick(() => tickPass(scheduled))
    }, timerMs)
    timer.unref()
    await scheduleTick(() => tickPass())
    log?.('info', `bot host started for ${workspaceRoot} (timer every ${timerMs} ms)`)
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
      unavailableLogged.clear()
      deferredNotifyLogged.clear()
      sourceChangedLogged.clear()
      routingAutoLogged.clear()
      watchdogLogged.clear()
    },
    // The store persists synchronously through better-sqlite3, so there is no
    // queued write to await; the method exists so the host mirrors the
    // scheduler's lifecycle exactly.
    async flush(): Promise<void> {},
    reconcile: reconcileAll,
    tick(botId?: string): Promise<void> {
      if (stopped) return Promise.resolve()
      return scheduleTick(() => tickPass(undefined, botId, true))
    },
    async health(botId: string): Promise<BotHealth> {
      const bot = store.getBot(botId)
      const counters = store.healthCounters(botId)
      const stats = botTickStats.get(botId)
      return {
        uptimeSince: startedAt,
        ticks: stats?.ticks ?? 0,
        forcedTicks: stats?.forcedTicks ?? 0,
        ...(bot.lastTickAt === undefined ? {} : { lastTickAt: bot.lastTickAt }),
        tickLagMs: { last: stats?.lastLagMs ?? 0, max: stats?.maxLagMs ?? 0 },
        itemsByState: counters.itemsByState,
        stepsFailed24h: counters.stepsFailed24h,
        adapterErrors24h: counters.adapterErrors24h,
        escalations24h: counters.escalations24h,
        ...(counters.lastError === undefined ? {} : { lastError: counters.lastError }),
        host: resolveHostIdentity(),
        components: await listComponents(),
        load: {
          activeExecutions: lastLoad?.activeExecutions ?? 0,
          maxExecutions: lastLoad?.maxExecutions ?? 0,
          queuedExecutions: lastLoad?.queuedExecutions ?? 0,
          ...(lastLoad?.oldestQueuedMs === undefined ? {} : { oldestQueuedMs: lastLoad.oldestQueuedMs }),
          backedOff: isBackedOff(botId),
        },
        lowDisk: options.lowDiskState?.() ?? { status: 'unavailable', availableBytes: null, minimumBytes: 3 * 1024 ** 3, error: 'Low-disk monitor unavailable' },
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
        const text = answer.trim()
        // An item with no bound session is an intake item: the answer is kept on
        // the row and the item resumes exactly as before, with no follow-up step.
        if (item.sessionId === undefined) {
          const resumed = store.transitionItem(itemId, item.parkedFrom, { answer: text, question: null })
          store.appendLog({
            botId,
            itemId,
            level: 'info',
            code: 'item.answered',
            message: `item ${itemId} resumed into ${resumed.state}`,
          })
          return resumed
        }
        // A bound session must actually receive the answer. The resume, the
        // delivery barrier and the answer's durable `session.send` step are one
        // `beginStep` transaction, so no crash can leave the item resumed without
        // its answer queued (or the answer queued without the barrier). Its stable
        // idempotency key and marker make a retry or restart deliver exactly one
        // follow-up turn.
        // Answering an item parked for an exhausted correction budget is the
        // explicit decision to continue, so it grants a fresh budget.
        const counters = {
          ...(item.counters ?? {}),
          ...(item.error === STALLED_REASON ? { corrections: 0 } : {}),
          // An answer is an explicit decision to continue: the age budget restarts.
          dispatchedAtMs: Date.now(),
          answerPending: 1,
          answerSeq: latestEventSeq(item.sessionId),
        }
        const { attempt } = latestStep(item, 'session.send')
        // An answer that resumes an item into acceptance clears the previous
        // run's checks so acceptance runs again with the answer instead of
        // waiting forever on recorded results.
        const rerunAcceptance = item.parkedFrom === 'accepting' ? { acceptance: null, error: null } : {}
        enqueueStep(item, 'session.send', { state: item.parkedFrom, answer: text, question: null, counters, ...rerunAcceptance }, attempt + 1, { botAnswer: text })
        const resumed = store.getItem(botId, itemId)
        store.appendLog({
          botId,
          itemId,
          level: 'info',
          code: 'item.answered',
          message: `item ${itemId} resumed into ${resumed.state}; the answer is queued as a session follow-up`,
        })
        return resumed
      }
      // cleanup: an explicit request to remove the worktree and the item rows.
      if (!['completed', 'dismissed', 'failed', 'withdrawn'].includes(item.state)) {
        throw new Error(`item ${itemId} must be terminal before cleanup (it is ${item.state})`)
      }
      if (item.worktreeId !== undefined) {
        const removed = await projectManager.removeWorktree(item.worktreeId)
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
  // A dismissed request was never dispatched, and a withdrawn source was never
  // merged: each has its own one-line message.
  if (item.state === 'dismissed') {
    return `Not dispatched: ${item.title ?? item.sourceId} — ${item.error ?? 'the request is not real'}`
  }
  if (item.state === 'withdrawn') {
    return `Withdrawn: ${item.title ?? item.sourceId} — not merged`
  }
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

/** The reason recorded on a dismissed item, for its notification and annotation. */
function dismissReason(item: BotItemRecord): string {
  return item.error ?? 'the request is not real'
}

/** The rebase-conflict follow-up: the offending paths, the target commits and the ask. */
function buildRebaseConflictText(item: BotItemRecord, conflict: ReturnType<ProjectManager['rebaseWorktree']>): string {
  const lines: string[] = []
  lines.push(`Bot item ${item.id}: rebasing your worktree onto ${conflict.target_branch ?? 'the target branch'} hit conflicts.`)
  const paths = conflict.conflicts ?? []
  lines.push(paths.length === 0
    ? 'Conflicting paths: (none reported)'
    : `Conflicting paths:\n${paths.map(path => `- ${path}`).join('\n')}`)
  const commits = conflict.target_commits ?? []
  if (commits.length > 0) {
    const rendered = commits.map((commit) => {
      const files = commit.files.length === 0 ? '' : `\n  files: ${commit.files.join(', ')}`
      return `- ${commit.sha.slice(0, 7)} ${commit.subject}${files}`
    })
    lines.push(`Target commits that touched those paths:\n${rendered.join('\n')}`)
  }
  lines.push('Rebase onto the target branch, resolve the conflicts and commit in your worktree, then reply `BOT-READY <head sha>`.')
  return lines.join('\n')
}

// ─── task output shapes the host acts on ──────────────────────────────────

/** One acceptance check of a `bot-verify` plan. */
interface BotVerifyCheck {
  id: string
  claim: string
  surface: 'daemon' | 'renderer' | 'native' | 'static'
  recipe: string
}

/** The subset of a `bot-verify` result the host acts on. */
interface BotVerifyEnvelope {
  decision: 'real' | 'not_real' | 'park'
  reason: string
  project?: string
  class?: string
  brief?: string
  acceptance?: { checks: BotVerifyCheck[] }
  touchedPaths?: string[]
  question?: string
  /** The exact tool or environment missing, when one blocks verification. */
  capabilityGap?: string
}

/** The subset of a `bot-review` result the host acts on. */
interface BotReviewEnvelope {
  verdict: 'continue' | 'correct' | 'ready' | 'park'
  reason: string
  correction?: string
  question?: string
  /** The exact tool or environment missing, when one blocks the work. */
  capabilityGap?: string
}

/** The subset of a builtin `test` result the host acts on. */
interface BotTestOutput {
  assessments?: { criterion_id: string; status: string; reason?: string }[]
  artifacts?: { path: string; kind?: string }[]
}

function isVerifyCheck(value: unknown): value is BotVerifyCheck {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.claim === 'string'
    && typeof record.recipe === 'string'
    && (record.surface === 'daemon' || record.surface === 'renderer'
      || record.surface === 'native' || record.surface === 'static')
}

/** Validate the parts of a `bot-verify` result the host relies on. */
function asVerifyEnvelope(value: unknown): BotVerifyEnvelope | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const decision = record.decision
  if (decision !== 'real' && decision !== 'not_real' && decision !== 'park') return undefined
  const reason = typeof record.reason === 'string' ? record.reason : ''
  if (reason.trim() === '') return undefined
  const acceptance = record.acceptance as { checks?: unknown } | undefined
  const checks = Array.isArray(acceptance?.checks) ? acceptance.checks.filter(isVerifyCheck) : []
  return {
    decision,
    reason,
    ...(typeof record.project === 'string' && record.project !== '' ? { project: record.project } : {}),
    ...(typeof record.class === 'string' && record.class !== '' ? { class: record.class } : {}),
    ...(typeof record.brief === 'string' && record.brief !== '' ? { brief: record.brief } : {}),
    ...(checks.length === 0 ? {} : { acceptance: { checks } }),
    ...(Array.isArray(record.touchedPaths)
      ? { touchedPaths: record.touchedPaths.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
    ...(typeof record.question === 'string' && record.question !== '' ? { question: record.question } : {}),
    ...(typeof record.capabilityGap === 'string' && record.capabilityGap !== '' ? { capabilityGap: record.capabilityGap } : {}),
  }
}

/** Validate the parts of a `bot-review` result the host relies on. */
function asReviewEnvelope(value: unknown): BotReviewEnvelope | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const verdict = record.verdict
  if (verdict !== 'continue' && verdict !== 'correct' && verdict !== 'ready' && verdict !== 'park') return undefined
  const reason = typeof record.reason === 'string' ? record.reason : ''
  if (reason.trim() === '') return undefined
  return {
    verdict,
    reason,
    ...(typeof record.correction === 'string' && record.correction !== '' ? { correction: record.correction } : {}),
    ...(typeof record.question === 'string' && record.question !== '' ? { question: record.question } : {}),
    ...(typeof record.capabilityGap === 'string' && record.capabilityGap !== '' ? { capabilityGap: record.capabilityGap } : {}),
  }
}

/** True only for a park that asks the user to confirm or grant an action. */
function isUserQuestion(text: string): boolean {
  return /needs user confirmation:/iu.test(text)
}

/** Read the parts of a builtin `test` result the host maps onto its checks. */
function asTestOutput(value: unknown): BotTestOutput | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const assessments = Array.isArray(record.assessments)
    ? record.assessments.filter((entry): entry is { criterion_id: string; status: string; reason?: string } => {
        if (entry === null || typeof entry !== 'object') return false
        const item = entry as Record<string, unknown>
        return typeof item.criterion_id === 'string' && typeof item.status === 'string'
      })
    : []
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts.filter((entry): entry is { path: string; kind?: string } => {
        if (entry === null || typeof entry !== 'object') return false
        return typeof (entry as Record<string, unknown>).path === 'string'
      })
    : []
  return { assessments, artifacts }
}

/**
 * Thrown by a step handler that must leave its step pending for a later tick,
 * for example while a single-owner operation component is busy. The step is not
 * failed and not finished: the next tick retries it.
 */
class BotStepPending extends Error {
  constructor(readonly code: string, message: string, readonly reported = false) {
    super(message)
    this.name = 'BotStepPending'
  }
}

/**
 * Thrown while a detached task run is still in flight: the step keeps its
 * pending status and a later tick polls the run again. It is never a failure and
 * is never logged per tick.
 */
class BotStepRunning extends Error {
  constructor() {
    super('the task run is still in flight')
    this.name = 'BotStepRunning'
  }
}

/**
 * Thrown when a detached task run itself ended without a result (failed,
 * cancelled, timeout, or a run that no longer exists). It is not an assessment
 * failure: the host counts it and retries with a fresh attempt while the item
 * keeps its state, and only parks once the budget is exhausted.
 */
class BotStepRunFailed extends Error {
  constructor(readonly runId: string, message: string) {
    super(message)
    this.name = 'BotStepRunFailed'
  }
}

/**
 * The closing effects of a resolved item. Every other step of a terminal item
 * is never re-run, so a withdrawal or dismissal that raced a queued step can
 * never execute it; the notification and its inbox annotation still run once.
 */
const RESOLVED_ITEM_STEPS: ReadonlySet<BotStepKind> = new Set<BotStepKind>(['notify', 'annotate'])
