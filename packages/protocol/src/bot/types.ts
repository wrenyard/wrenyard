import type { ReasoningEffort } from '@wrenyard/models'

/** Lifecycle of one bot. */
export type BotState = 'running' | 'paused' | 'stopped'

/** `live` performs merge/push/complete/notify; `dryRun` only records them. */
export type BotMode = 'live' | 'dryRun'

/**
 * One item's lifecycle state. Mirrors `BOT_ITEM_STATES` in
 * `daemon/services/bot/machine.mts`, which owns the authoritative transition
 * rules.
 */
export type BotItemState =
  | 'discovered'
  | 'verifying'
  | 'verified'
  | 'dispatched'
  | 'in_progress'
  | 'ready'
  | 'accepting'
  | 'accepted'
  | 'rejected'
  | 'merging'
  | 'merged'
  | 'completing'
  | 'completed'
  | 'dismissed'
  | 'parked'
  | 'failed'
  | 'withdrawn'

/** The model a bot dispatches with, taken from the routing policy. */
export interface BotModel {
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
}

export interface BotRecord {
  /** 8 lowercase hex characters; unique among every stored bot. */
  id: string
  /** Workspace root that owns this bot; another workspace never lists it. */
  workspaceRoot: string
  name: string
  /** Path of the bot's user-local config file, when one is bound. */
  configPath?: string
  /** Content hash of the config file observed at the last load. */
  configHash?: string
  state: BotState
  mode: BotMode
  /** ISO timestamp of the last completed tick. */
  lastTickAt?: string
  /** ISO timestamp of the next due inbox poll. */
  nextPollAt?: string
  createdAt: string
  updatedAt: string
}

/** One acceptance check recorded for an item. */
export interface BotAcceptanceCheck {
  claim: string
  method: string
  status: 'verified' | 'failed' | 'not_verified'
  evidence?: string[]
  note?: string
}

export interface BotItemRecord {
  id: string
  botId: string
  /** Id of the source item in the user's inbox adapter. */
  sourceId: string
  /** Bumped when a terminal source item is seen again with a new fingerprint. */
  generation: number
  /** Hash of the source title + notes, used to detect a changed request. */
  fingerprint?: string
  title?: string
  body?: string
  project?: string
  class?: string
  state: BotItemState
  /** The state a parked item resumes into. */
  parkedFrom?: BotItemState
  /** The precise question an item is parked on. */
  question?: string
  /** The user's answer, appended to the item context on resume. */
  answer?: string
  sessionId?: string
  sessionModel?: BotModel
  worktreeId?: string
  branch?: string
  headSha?: string
  mergedSha?: string
  acceptance?: BotAcceptanceCheck[]
  counters?: Record<string, number>
  error?: string
  dryRun: boolean
  createdAt: string
  updatedAt: string
}

export interface BotLogRecord {
  seq: number
  botId: string
  itemId?: string
  /** ISO timestamp of the entry. */
  at: string
  level: string
  code?: string
  message: string
}

/** Last and worst delay between a scheduled tick and its actual start. */
export interface BotTickLag {
  last: number
  max: number
}

export interface BotHealthError {
  at: string
  code: string
  message: string
}

/** `installed` when the daemon runs from the bundled suite; `source` otherwise. */
export type BotHostMode = 'installed' | 'source'

/**
 * The device and daemon a bot runs on. `daemonVersion`/`mode` come from the same
 * identity `health.ping` reports; the Bot page shows this so a user can tell
 * which daemon/device owns the bot.
 */
export interface BotHealthHost {
  hostname: string
  platform: string
  arch: string
  daemonVersion?: string
  mode: BotHostMode
}

/** The managed operation components a bot's acceptance may require. */
export type BotComponentId = 'browser' | 'desktop'

export type BotComponentState =
  | 'not-installed'
  | 'installing'
  | 'needs-authorization'
  | 'ready'
  | 'failed'
  | 'unsupported'
  | 'disabled'

/** One operation component's current state, mirrored from `components.list`. */
export interface BotHealthComponent {
  id: BotComponentId
  state: BotComponentState
}

/**
 * Live daemon execution load observed at the last tick. `backedOff` is the
 * current dispatch state, so the Bot page can show whether the bot is holding
 * new work because the daemon is loaded.
 */
export interface BotLoad {
  activeExecutions: number
  maxExecutions: number
  queuedExecutions: number
  /** How long the oldest queued execution has waited, when any is queued. */
  oldestQueuedMs?: number
  backedOff: boolean
}

/**
 * Durable endurance numbers for one bot. The 24h counters are computed from
 * `bot_step` and `bot_log`, so they stay correct across daemon restarts.
 */
export interface BotHealth {
  lowDisk: { status: 'ok' | 'low' | 'unavailable'; availableBytes: number | null; minimumBytes: number; error: string | null }
  /** ISO timestamp the host started serving this bot. */
  uptimeSince: string
  /** Cadence (timer) passes only, so the number tracks the configured cadence. */
  ticks: number
  /** Passes an explicit `bot.tick` asked for; never counted as cadence ticks. */
  forcedTicks: number
  lastTickAt?: string
  tickLagMs: BotTickLag
  itemsByState: Record<string, number>
  stepsFailed24h: number
  adapterErrors24h: number
  escalations24h: number
  lastError?: BotHealthError
  /** Device and daemon the bot runs on. */
  host: BotHealthHost
  /** Operation component states; empty when the service is absent or fails. */
  components: BotHealthComponent[]
  /** Live daemon load from the last tick, and whether new work is backed off. */
  load: BotLoad
}

export type BotControlAction = 'start' | 'pause' | 'resume' | 'stop'
export type BotItemAction = 'retry' | 'dismiss' | 'answer' | 'cleanup'

export type BotListParams = Record<string, never>
export interface BotListResult { bots: BotRecord[] }

export interface BotCreateParams {
  name: string
  configPath: string
  mode?: BotMode
}
export interface BotCreateResult { bot: BotRecord }

export interface BotUpdateParams {
  botId: string
  name?: string
  configPath?: string
  mode?: BotMode
}
export interface BotUpdateResult { bot: BotRecord }

export interface BotControlParams { botId: string; action: BotControlAction }
export interface BotControlResult { bot: BotRecord }

export interface BotDeleteParams { botId: string }
export interface BotDeleteResult { deleted: true }

export interface BotTickParams { botId: string }
export interface BotTickResult { ticked: true }

export interface BotConfigValidateParams { configPath: string }
export interface BotConfigValidateResult {
  valid: boolean
  name?: string
  error?: string
}

export interface BotItemsParams { botId: string; state?: BotItemState }
export interface BotItemsResult { items: BotItemRecord[] }

export interface BotItemGetParams { botId: string; itemId: string }
export interface BotItemGetResult { item: BotItemRecord }

export interface BotItemActionParams {
  botId: string
  itemId: string
  action: BotItemAction
  answer?: string
}
export interface BotItemActionResult { item: BotItemRecord }

export interface BotLogParams { botId: string; afterSeq: number; limit?: number }
export interface BotLogResult { entries: BotLogRecord[] }

export interface BotHealthParams { botId: string }
export type BotHealthResult = BotHealth
