/**
 * Session product DTOs.
 *
 * These are the exact shapes the Desktop conversation surface consumes: the
 * `ConversationSnapshot` and every product type it transitively carries were
 * moved here verbatim from the Desktop shell contract when the session feature
 * became a first-class protocol surface. Field names, optionality, and unions
 * are frozen product wire shapes — the protocol only describes them, it never
 * validates a payload.
 *
 * Design rules, enforced by convention rather than by runtime validation:
 *
 * - Ids are OPAQUE non-empty strings. Never parse, order, or assume a format.
 * - Timestamps are epoch MILLISECONDS as plain numbers.
 * - Only JSON-safe concrete shapes are used. No `Date`, `Error`, `Map`, `Set`,
 *   function, or class instance appears anywhere in this file.
 *
 * These are TYPES ONLY and they DO NOT VALIDATE incoming JSON. See README.md.
 */

/**
 * Whether a workspace is usable, plus where the configuration came from. A
 * snapshot never carries a credential; `readOnly` marks a configuration the
 * product itself may not rewrite.
 */
export interface WorkspaceConfigurationSnapshot {
  status: 'configured' | 'missing' | 'invalid'
  source: 'environment' | 'user-config' | 'none'
  configPath: string
  path?: string
  message?: string
  readOnly: boolean
}

/**
 * Selection-time speed evidence from the resolved speed contract. This is the
 * estimate chosen before the run started; it is distinct from the actual
 * measured `usage.outputTps` captured after the run completed.
 */
export interface TaskRunSpeedEvidence {
  /** Selection-time expected throughput (tokens per second). */
  effectiveTps: number
  /** Where the selection estimate came from. Invalid evidence is omitted as a whole. */
  source: 'local_31d' | 'provider_override' | 'catalog_default'
  /** Number of local samples behind the selection estimate, when known. */
  sampleCount: number | null
  /** Whether actual throughput is expected to meet the selection estimate, when known. */
  expectedTpsMet: boolean | null
  /** Reason the selection estimate is considered degraded, when known. */
  degradationReason?: string
}

/**
 * Per-run usage projection. Completeness reflects the CORE `reference_cost_complete`
 * flag: only `true` marks a run fully costed. Partial runs keep unknown optional
 * numbers absent rather than substituting zero; `unavailable` runs carry identity
 * only. `referenceCostUsd` is an estimate, never a billed amount.
 */
export interface TaskRunUsage {
  completeness: 'complete' | 'partial' | 'unavailable'
  attemptCount: number
  usageEventCount: number
  inputTokens?: number
  cachedInputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  outputTokens?: number
  totalTokens?: number
  generationMs?: number
  outputTps?: number
  tpsContract?: 'tokenizer_v1'
  /** Estimated reference cost in USD. Absent (`undefined`) when CORE omits the numeric; never a fabricated value. */
  referenceCostUsd?: number
  /** True when CORE fully costed this run; partial runs omit the cost. */
  referenceCostComplete: boolean
  referenceCostBasis?: string
}

/** A single recent Task run, projected from CORE's frozen TaskRunOutputResult metadata. */
export interface TaskRunSnapshot {
  taskRunId: string
  taskId: string
  taskName?: string
  source?: 'builtin' | 'project' | 'unknown'
  /** Exact persisted execution project; present only when nonblank. */
  project?: string
  status?: 'done' | 'failed' | 'cancelled' | 'interrupted' | 'running' | 'queued'
  startedAt?: string
  finishedAt?: string
  resolvedClient?: string
  resolvedProvider?: string
  resolvedProfile?: string
  resolvedModel?: string
  resolvedModelId?: string
  /** Paired Catalog provider display label; present only when the run row carries both labels. */
  resolvedProviderDisplayName?: string
  /** Paired Catalog model display label; present only when the run row carries both labels. */
  resolvedModelDisplayName?: string
  speed?: TaskRunSpeedEvidence
  usage: TaskRunUsage
}

/** One conversation listed in the session sidebar. */
export interface ConversationSessionSnapshot {
  id: string
  title: string
  updatedAt: number
  running: boolean
  blank: boolean
  agentPreset?: string
}

/**
 * Stable per-turn timing/usage metadata projected from the retained DSH event
 * stream. Every optional number is observation-only: when DSH never supplied the
 * datum it stays absent rather than being filled with a substitute.
 */
export interface ConversationTurnSnapshot {
  id: string
  /** Exact `turn/start` event time, or the earliest observed event for the turn. */
  startedAt: number
  /** Exact `turn/end` event time; absent while the turn is still running. */
  endedAt?: number
  running: boolean
  /** Last assistant message body projected for a completed turn. */
  finalItemId?: string
  /**
   * Latest progress note of a work turn that is still running because it owns
   * dispatched task runs. Replaced by `finalItemId` once the turn completes, so
   * a progress note never survives next to the final answer.
   */
  progressItemId?: string
  /**
   * Dispatched task runs this work turn still waits on. Present only while the
   * turn runs and owns at least one unresolved run, so a settled turn never
   * claims outstanding work.
   */
  pendingTaskCount?: number
  /** Count of `run_task`/`task_run` tool calls observed inside this turn. */
  dispatchCount: number
  inputTokens?: number
  outputTokens?: number
  outputTps?: number
}

/** One rendered transcript item of the selected conversation. */
export interface ConversationItemSnapshot {
  id: string
  kind: 'user' | 'assistant' | 'tool'
  text: string
  time: number
  /** Stable DSH turn identity used to render one assistant message per turn. */
  turnId?: string
  running?: boolean
  toolName?: string
  toolState?: 'running' | 'done' | 'failed'
  /** Bounded raw result text for the tool call, when CORE supplies one. */
  toolResultText?: string
  /**
   * Observed run_task metadata. A dispatch that is still executing carries its
   * launch identity with a nonterminal `status` and identity-only usage; the
   * authoritative terminal projection replaces it once the run resolves.
   */
  taskRun?: TaskRunSnapshot
  /** Exact DSH step number that produced this item, when the event carried one. */
  step?: number
  /** Concise Chinese summary of the tool call derived from its observed arguments. */
  toolSummary?: string
  /** Bounded document references observed for a workspace doc tool result. */
  documentLinks?: Array<{ title: string; path: string }>
}

/** The model choice currently applied to the selected conversation. */
export interface ConversationModelSelectionSnapshot {
  provider: string
  /** Catalog Provider behind the DSH transport route. */
  catalogProvider: string
  model: string
  label: string
  providerLabel: string
  advertised: boolean
  /** True when the current model's provider credentials were passed to DSH. */
  configured: boolean
  reasoningEffort?: string
}

/** One selectable model of the advertised directory. */
export interface ConversationModelOptionSnapshot {
  provider: string
  /** Catalog Provider behind the DSH transport route. */
  catalogProvider: string
  providerLabel: string
  model: string
  label: string
  description?: string
  defaultReasoningEffort?: string
  reasoningEfforts?: string[]
  /**
   * Exact built-in Catalog input capabilities (`text`/`image`) projected for
   * this option. Derived from the authoritative Catalog model, never from DSH
   * claims or the model name. `undefined` means the capability is unknown —
   * the UI must not assume text-only for an unmatched model.
   */
  inputTypes?: readonly ('text' | 'image')[]
}

export interface ConversationModelGroupSnapshot {
  provider: string
  label: string
  models: ConversationModelOptionSnapshot[]
}

export interface ConversationModelsSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  groups: ConversationModelGroupSnapshot[]
  current?: ConversationModelSelectionSnapshot
  routable?: boolean
  message?: string
}

/** The whole selectable conversation projection, as one versioned snapshot. */
export interface ConversationSnapshot {
  status: 'ready' | 'workspace-required' | 'unavailable'
  workspace: WorkspaceConfigurationSnapshot
  sessions: ConversationSessionSnapshot[]
  selectedSessionId?: string
  selectedTitle?: string
  selectedRunning: boolean
  models: ConversationModelsSnapshot
  hasMore: boolean
  items: ConversationItemSnapshot[]
  /** Observed turn boundaries/usage for the retained history; absent when none exist. */
  turns?: ConversationTurnSnapshot[]
  message?: string
}

/**
 * One canonical summary-model choice projected from the live local Gateway
 * connection. `available` is credential evidence from the daemon gateway
 * projection — a provider directory entry alone is never treated as usable.
 */
export interface SummaryModelOptionSnapshot {
  /** Canonical (provider-independent) model id persisted by the preference. */
  canonicalModel: string
  /** Exact `provider/model` public id the local Gateway expects, when usable. */
  publicId?: string
  displayName: string
  /** Provider display label backing this option, when resolved. */
  providerLabel?: string
  available: boolean
}

export interface SummarySettingsSnapshot {
  /** Exact canonical model id currently persisted (default DeepSeek V4.1 Flash). */
  selectedCanonicalModel: string
  options: SummaryModelOptionSnapshot[]
  /** True when the selected canonical model has no usable ordinary-LLM provider. */
  unresolved: boolean
  message?: string
}
