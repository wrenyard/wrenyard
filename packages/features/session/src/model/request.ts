/**
 * session model calls.
 *
 * One call is one stateless request: pick the role's model, resolve its model
 * metadata, estimate the input with `o200k_base`, enforce the context budget,
 * run it through the {@link ModelTransport}, and write
 * exactly one `span.started` and one `span.finished` ledger event for the
 * invocation. The runner keeps no session state, never parses JSON output and
 * never repairs schemas — those belong to `actions.ts` / `engine.ts`.
 *
 * Every transport call sends one request on one route: the transport never
 * retries. The main reasoning call owns its own retry: it repeats a failure
 * whose meaning is unclear (overload, another server error, a connection
 * failure or a rate limit without a stated reset) with a jittered 2/4/8/16 s
 * backoff, up to four times, and never replays output that already started. A
 * bot turn — an automatically selected one — may also move to the next
 * automatic candidate after two consecutive failures on the same model. An
 * auxiliary call uses the route the selector ranked first.
 */
import type { GatewayModel } from '@wrenyard/ai-protocol';
import { PROVIDER_DEFAULT_REASONING, type ReasoningEffort } from '@wrenyard/models';
import {
  abortError,
  isContextOverflowError,
  isModelError,
  type ModelContentPart,
  type ModelErrorKind,
  type ModelAttempt,
  type ModelEvent,
  type ModelMetrics,
  type ModelResult,
  type ModelTransport,
  type ModelWaitReason,
  type ToolCall,
  type ToolSpec,
  type ToolChoice,
  type Usage,
} from '@wrenyard/model-call/transport';
import {
  callModelAttempt,
  settleWithAbort,
  checkContextBudget,
  contextBudgetOf as sharedContextBudgetOf,
  estimateInputTokens,
  hasSelectableReasoningEfforts,
  isReasoningEffortSupported,
  type ContextBudgetFacts,
} from '@wrenyard/model-call';
import type { ModelSpanFinishedEvent, ModelSpanStartedEvent } from '../ledger/events.ts';
import type { AuxiliaryCallRole } from './roles.ts';
import type { ModelMetadata } from '@wrenyard/model-call/metadata';

/** Every role that may issue a call. `reason` is the one expensive role. */
export const CALL_ROLES = ['reason', 'memory-search', 'search', 'dispatch', 'reply', 'title', 'document', 'todo', 'vcs', 'project', 'status', 'suggestion', 'task-output'] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/**
 * Local first-response timeout auxiliary roles use (seconds). Main reasoning
 * uses the transport default (120 s).
 */
export const AUXILIARY_FIRST_RESPONSE_TIMEOUT_SEC = 30;

/** Backoff steps of one main reasoning call (milliseconds), before jitter. */
const REASONING_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;
/** Retries after the first attempt; at most five upstream tries per call. */
const REASONING_MAX_RETRIES = 4;
/** Upper bound of one timer, so an extreme delay can never overflow it. */
const MAX_WAIT_MS = 2_147_483_647;

/**
 * Live retry switches for main reasoning, read at call time. An absent policy
 * or an absent getter means retries are on.
 */
export interface ReasoningRetryPolicy {
  retrySessions?: () => boolean;
  retryBots?: () => boolean;
}

/** Output-token allowance for the one next-input suggestion call (384 tokens). */
export const SUGGESTION_MAX_TOKENS = 384;
/** Fixed cap for the compaction input threshold (spec: about 120k tokens). */
export const COMPACTION_THRESHOLD_CAP = 120_000;

/** Caller-supplied expensive model for the `reason` role. */
export interface ReasonSelection {
  provider: string;
  model: string;
  /** Explicit public reasoning level; required for the `reason` role. */
  reasoningEffort: ReasoningEffort;
  /** Explicit Fast preference: true on, false off, absent no preference. */
  fast?: boolean;
  /** True when automatic routing selected this model; recorded, not used for failover. */
  automatic?: boolean;
}

/** Structured failure fact recorded on a failed span and handed to reply. */
export interface CallErrorFact {
  kind: ModelErrorKind;
  status?: number;
  /**
   * The earliest instant the failed call may be retried, when the upstream
   * supplied one. It is not an attempt record.
   */
  retryAt?: string;
  /** Supplier's original message. */
  message: string;
}

/**
 * Every span event draft the runner writes for one invocation. `seq` and `at`
 * are assigned by the ledger on append, so the runner hands over everything
 * else through a structural callback and never imports the ledger store.
 */
export type SpanEventDraft =
  | Omit<ModelSpanStartedEvent, 'seq' | 'at'>
  | Omit<ModelSpanFinishedEvent, 'seq' | 'at'>;

export interface ModelCallInput {
  spanId: string;
  /** The owning step for a reasoning span, or the owning action for an auxiliary span. */
  parent: string;
  role: CallRole;
  turn?: number;
  step?: number;
  /** Fully assembled request messages, supplied by the caller's view. */
  messages: readonly import('@wrenyard/model-call/transport').Message[];
  /** Character count per assembled prompt layer. */
  layers: Record<string, number>;
  /** Required for `reason`; ignored for every other role. */
  reason?: ReasonSelection;
  /** Output-token cap forwarded as the protocol's own token field when set. */
  maxTokens?: number;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Forwarded to the driver for every role. */
  onToolCall?: (call: ToolCall) => void;
  /**
   * The recovery wait lifecycle for the `reason` role: the wait reason, and the
   * absolute next probe/recovery instant when one is really known, reported when
   * a wait begins or its real retry time changes; `null` when the wait is
   * cleared — on the next actual upstream attempt, on completion and on cancel.
   * A wait whose real instant is missing, invalid or already past reports no
   * `retryAt`, which is distinct from `null`: the wait is still running, only
   * its recovery time is unknown. Ignored for every other role.
   */
  onWait?: (state: { reason: ModelWaitReason; retryAt?: string } | null) => void;
  /** Tools declared on this call; forwarded to the driver for every role. */
  tools?: readonly ToolSpec[];
  toolChoice?: ToolChoice;
}

export interface ModelCallOutput {
  model: string;
  /** Visible text. */
  text: string;
  reasoning?: string;
  usage?: Usage;
  /** Native tool calls the model returned, in call order; empty when it returned none. */
  toolCalls: ToolCall[];
  finishReason?: import('@wrenyard/model-call/transport').FinishReason;
  /** Measured facts of the call, produced by the transport. */
  metrics: ModelMetrics;
  /**
   * The route the last completed request actually served: the provider,
   * provider-qualified model and reasoning effort of the route candidate that
   * succeeded. Absent only when no route identity is known.
   */
  route?: { provider?: string; model?: string; effort?: string };
}

/** One ranked auxiliary route and the level it is called at. */
export interface AuxiliaryRoute { model: string; reasoningEffort: ReasoningEffort; }

/**
 * Internal provider-scoped route key of one model selection. The model is the
 * bare registered id and the provider is a separate dimension; a qualified
 * public id is never accepted as a model, because a registered id never
 * contains `/` and a provider name is not part of the model identity.
 */
function routeKeyOf(provider: string, model: string): string {
  const providerID = provider.trim();
  const modelID = model.trim();
  if (providerID === '') throw new Error('A model selection requires a resolved provider');
  if (modelID === '') throw new Error('A model selection requires a registered model id');
  if (modelID.includes('/')) {
    throw new Error(`Model selection must use the registered model id, not a provider-qualified id: ${modelID}`);
  }
  return `${providerID}/${modelID}`;
}

export interface CallRunnerOptions {
  /** The endpoint model list that is the only source of model metadata. */
  models: () => Promise<readonly GatewayModel[]>;
  /** The one unified transport every role calls. */
  transport: ModelTransport;
  /**
   * The one model an auxiliary invocation uses. The request's `tool_choice` is
   * forwarded so a forced choice never selects a provider that cannot honour
   * it. An endpoint-configured daemon names that model directly; otherwise the
   * gateway's route ranking picks its first route.
   */
  resolveAuxiliaryModel: (
    role: AuxiliaryCallRole,
    input?: { toolChoice?: ToolChoice },
  ) => AuxiliaryRoute | Promise<AuxiliaryRoute>;
  /**
   * Fresh ranked routes for a main reasoning turn whose model was chosen
   * automatically, read only when such a turn switches model. Absent means an
   * automatic turn keeps the model it started with.
   */
  selectAutomaticRoutes?: () => readonly ReasonSelection[] | Promise<readonly ReasonSelection[]>;
  /**
   * Live global retry switches for main reasoning, read at call time; absent or
   * absent getters default to enabled.
   */
  retryPolicy?: ReasoningRetryPolicy;
  /** Structural sink: the span events of every attempted invocation, in order. */
  append: (event: SpanEventDraft) => void | Promise<void>;
  /** Forwarded as the request cache key on every call of this runner. */
  cacheKey?: string;
  now?: () => Date;
}

export interface CallRunner {
  run(input: ModelCallInput): Promise<ModelCallOutput>;
}

/** Raised after the failure span has been written; carries the failure facts. */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly detail: {
      spanId: string;
      role: CallRole;
      model: string;
      status: 'failed' | 'aborted';
      /** Structured failure fact for the reply view. */
      failure?: CallErrorFact;
      /** Measured facts of the failed call, produced by the transport. */
      metrics?: ModelMetrics;
    },
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

/**
 * Session's budget facts. The compaction threshold cap is session policy, so
 * this wrapper keeps applying the fixed {@link COMPACTION_THRESHOLD_CAP} over
 * the shared calculation instead of moving the policy into `@wrenyard/model-call`.
 */
export function contextBudgetOf(
  publicId: string,
  messages: readonly import('@wrenyard/model-call/transport').Message[],
  models: readonly GatewayModel[],
  requestedMaxOutputTokens?: number,
): ContextBudgetFacts {
  return sharedContextBudgetOf(publicId, messages, models, requestedMaxOutputTokens, COMPACTION_THRESHOLD_CAP);
}

/**
 * Defense in depth: only the main reasoning role may carry image bytes. For any
 * other role every `image_url` part is replaced by a textual omitted descriptor
 * before the budget check and the driver, so a auxiliary request can never transmit
 * image content.
 */
export function sanitizeMessagesForRole(
  role: CallRole,
  messages: readonly import('@wrenyard/model-call/transport').Message[],
): readonly import('@wrenyard/model-call/transport').Message[] {
  if (role === 'reason') return messages;
  let replaced = false;
  const next = messages.map((message) => {
    if (typeof message.content === 'string') return message;
    replaced = true;
    const parts: ModelContentPart[] = message.content.map((part) =>
      part.type === 'text' ? part : { type: 'text', text: '[image omitted: not delivered to a non-reasoning call]' });
    return { ...message, content: parts };
  });
  return replaced ? next : messages;
}

// The shared settleWithAbort helper is imported from '@wrenyard/model-call'
// above; the attempt calls below no longer wrap it themselves because
// callModelAttempt settles internally against the same signal.

/**
 * Wait one backoff step. The wait ends at once, as an abort, when the call's
 * signal fires, so a cancelled turn never keeps waiting for a retry.
 */
function delayWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(Math.max(delayMs, 0), MAX_WAIT_MS));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The switch that governs one main reasoning call: bots for a bot-owned turn. */
function reasoningRetriesEnabled(automatic: boolean, policy?: ReasoningRetryPolicy): boolean {
  const getter = automatic ? policy?.retryBots : policy?.retrySessions;
  return getter?.() ?? true;
}

/**
 * True for a main reasoning failure the caller may retry: a failure whose
 * meaning is unclear — overload or another server error, a connection failure
 * or a first-response timeout, or a rate limit without a stated reset — that
 * happened before any output. An explicit answer (an exhausted quota, a rate
 * limit with a reset, authentication, an unknown model or a caller error) and
 * anything observed after output started fail at once.
 */
function isReasoningCallerRetryable(error: unknown, outputStarted: boolean): boolean {
  if (outputStarted || !isModelError(error)) return false;
  if (error.outputStarted === true) return false;
  if (error.kind === 'server' || error.kind === 'network') return true;
  if (error.kind === 'rate_limited') return error.retryAt === undefined && error.retryAfterMs === undefined;
  return false;
}

/** One jittered backoff step: the ordinal step times a fresh 0.75–1.0 jitter. */
function reasoningRetryDelayMs(retryOrdinal: number): number {
  const base = REASONING_RETRY_DELAYS_MS[Math.min(Math.max(retryOrdinal, 1) - 1, REASONING_RETRY_DELAYS_MS.length - 1)]!;
  const jitter = 0.75 + Math.random() * 0.25;
  return Math.round(base * jitter);
}

/** Human-readable failure message for one abort cause. */
function abortMessage(kind: 'signal' | undefined): string {
  if (kind === 'signal') return 'Model call was aborted';
  return 'Model call failed';
}

function auxiliaryFirstResponseTimeoutSec(role: CallRole): number {
  return AUXILIARY_FIRST_RESPONSE_TIMEOUT_SEC;
}

/**
 * Prefix a failure message with the fixed `context_overflow:` code when it is a
 * context-window overflow, whether it came from the local budget check or an
 * upstream context-too-long error. Desktop matches this prefix and never parses
 * the provider wording.
 */
function withOverflowPrefix(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('context_overflow:')) return message;
  return isContextOverflowError(error) ? `context_overflow: ${message}` : message;
}

/** Build the structured failure fact of a thrown transport error. */
function errorFactOf(error: unknown): CallErrorFact {
  if (error instanceof Error && 'kind' in error && typeof (error as { kind?: unknown }).kind === 'string') {
    const typed = error as { kind: ModelErrorKind; status?: number; retryAt?: string; message: string };
    return {
      kind: typed.kind,
      ...(typed.status === undefined ? {} : { status: typed.status }),
      // A failure that still carries the absolute instant its route may recover
      // reports it, so the ledger and the reply view report `retryAt` for main
      // reasoning exactly as an auxiliary exhaustion already does.
      ...(typed.retryAt === undefined ? {} : { retryAt: typed.retryAt }),
      message: typed.message,
    };
  }
  return { kind: 'protocol', message: error instanceof Error ? error.message : String(error) };
}

/** Measured facts of a thrown transport error, when it carries them. */
function metricsOf(error: unknown): ModelMetrics | undefined {
  return error instanceof Error && 'metrics' in error
    ? (error as { metrics?: ModelMetrics }).metrics
    : undefined;
}

/** Create the role-aware call runner. */
export function createCallRunner(options: CallRunnerOptions): CallRunner {
  return {
    async run(input: ModelCallInput): Promise<ModelCallOutput> {
      // Non-reasoning roles never transmit image bytes: image parts become a
      // textual omitted descriptor before the budget check and the driver.
      const messages = sanitizeMessagesForRole(input.role, input.messages);
      const models = await options.models().catch(() => []);
      // The suggestion role always carries its own tiny output allowance, so a
      // caller cannot spend more than a short hint's worth of tokens on it.
      const maxTokens = input.role === 'suggestion' ? SUGGESTION_MAX_TOKENS : input.maxTokens;
      const spanKind: 'reasoning' | 'auxiliary' = input.role === 'reason' ? 'reasoning' : 'auxiliary';
      let model = '';
      let estimatedInputTokens = 0;
      let actualReasoningEffort: ReasoningEffort | undefined;
      let requestedReasoningEffort: string | undefined;
      let auxiliaryRole: AuxiliaryCallRole | undefined;
      let auxiliaryRoute: AuxiliaryRoute | undefined;
      let selectedRank: number | undefined;
      let partialUsage: Usage | undefined;
      let emitted = false;

      /** Append the single `span.finished` event of this invocation. */
      const finish = async (
        status: 'ok' | 'failed' | 'aborted',
        fields: { output?: string; reasoning?: string; error?: CallErrorFact; metrics?: ModelMetrics },
      ): Promise<void> => {
        if (emitted) return;
        emitted = true;
        await options.append({
          type: 'span.finished',
          id: input.spanId,
          kind: spanKind,
          ...(input.turn === undefined ? {} : { turn: input.turn }),
          ...(input.step === undefined ? {} : { step: input.step }),
          status,
          ...(fields.output === undefined ? {} : { output: fields.output }),
          ...(fields.reasoning === undefined ? {} : { reasoning: fields.reasoning }),
          ...(fields.error === undefined ? {} : { error: fields.error }),
          // The model this request actually selected, independent of the
          // provider's measured facts: after an auxiliary route failover the
          // started span names the primary route but the answer came from a
          // later candidate. Kept out of `metrics` so the provider's own metrics
          // stay untouched, and added even without metrics so the serving
          // identity survives a missing usage or a failed request.
          ...(model === '' ? {} : { requestModel: model }),
          ...(fields.metrics === undefined ? {} : { metrics: fields.metrics }),
        });
      };
      /** Write the failure span event for this invocation, then throw. */
      const fail = async (
        message: string,
        detail: { status?: 'failed' | 'aborted'; error?: CallErrorFact; metrics?: ModelMetrics } = {},
      ): Promise<never> => {
        const status = detail.status ?? 'failed';
        const failure = detail.error ?? { kind: 'protocol' as ModelErrorKind, message };
        await finish(status, {
          error: failure,
          ...(detail.metrics === undefined ? {} : { metrics: detail.metrics }),
        });
        throw new ModelCallError(message, {
          spanId: input.spanId,
          role: input.role,
          model,
          status,
          failure,
          ...(detail.metrics === undefined ? {} : { metrics: detail.metrics }),
        });
      };

      const controller = new AbortController();
      let abortKind: 'signal' | undefined;
      const abort = (kind: 'signal'): void => {
        abortKind ??= kind;
        controller.abort();
      };
      const onExternalAbort = (): void => abort('signal');
      if (input.signal.aborted) abort('signal');
      else input.signal.addEventListener('abort', onExternalAbort, { once: true });

      let outputStarted = false;
      const onOutput = (): void => { outputStarted = true; };
      const onText = (delta: string): void => {
        if (delta !== '') onOutput();
        input.onText?.(delta);
      };
      const onReasoning = (delta: string): void => {
        if (delta !== '') onOutput();
        input.onReasoning?.(delta);
      };
      /**
       * The main reasoning call's recovery-wait lifecycle. A wait start or a
       * changed real retry instant reports the reason and, when one is really
       * known, the absolute next probe/recovery time; an identical reason and
       * instant is dropped, while a known instant that becomes unknown is an
       * update so a stale ETA is never silently retained. A running wait with
       * no known instant is not the same as no wait: it reports no `retryAt`
       * and is only cleared by `null`. Every other event — including the
       * transport's attempt-start `activity` — ends the wait, so the live
       * waiting state is cleared right before the next actual upstream attempt,
       * and the call's own settle clears it on completion or cancel. No timer
       * approximates the clear.
       */
      let waiting: { reason: ModelWaitReason; retryAt?: string } | null = null;
      const reportWait = (state: { reason: ModelWaitReason; retryAt?: string } | null): void => {
        if (input.role !== 'reason') return;
        if (state === null) {
          if (waiting === null) return;
          waiting = null;
        } else {
          if (waiting !== null && waiting.reason === state.reason && waiting.retryAt === state.retryAt) return;
          waiting = { reason: state.reason, ...(state.retryAt === undefined ? {} : { retryAt: state.retryAt }) };
        }
        input.onWait?.(state);
      };
      /** Map one transport event onto the runner's activity tracking. */
      const onEvent = (event: ModelEvent): void => {
        switch (event.type) {
          case 'text': reportWait(null); onText(event.delta); return;
          case 'reasoning': reportWait(null); onReasoning(event.delta); return;
          case 'tool_call': reportWait(null); onOutput(); input.onToolCall?.(event.call); return;
          case 'usage': reportWait(null); partialUsage = event.usage; return;
          // The transport emits `activity` at the start of an attempt that
          // follows a wait, so this is the precise pre-attempt clear.
          case 'activity': reportWait(null); return;
          case 'retry':
            reportWait(null);
            return;
          case 'wait':
            reportWait({
              reason: event.reason,
              ...(event.retryAt === undefined ? {} : { retryAt: event.retryAt }),
            });
            return;
        }
      };

      let result: ModelResult | undefined;
      // Per-attempt evidence in order: a bounded failover merges every route's
      // attempts so the ledger records exactly what was tried.
      const routeAttempts: ModelAttempt[] = [];
      /** Merge one route's own attempt records in order. */
      const collectAttempts = (metrics: ModelMetrics | undefined): number => {
        let added = 0;
        for (const attempt of metrics?.attempts ?? []) {
          routeAttempts.push(attempt);
          added += 1;
        }
        return added;
      };
      /**
       * The failure detail of one auxiliary exhaustion: every attempt tried so
       * far, the upstream retry instant, and the kind of the last real failure.
       * A user cancellation is neutral — it is `aborted` and carries no retry
       * time.
       */
      const auxiliaryFailure = (
        message: string,
        retryAt: string | undefined,
        kind: ModelErrorKind,
      ): { status: 'failed' | 'aborted'; error: CallErrorFact; metrics?: ModelMetrics } => {
        const cancelled = abortKind === 'signal';
        return {
          status: cancelled ? 'aborted' : 'failed',
          error: {
            kind: cancelled ? 'aborted' : kind,
            ...(cancelled || retryAt === undefined ? {} : { retryAt }),
            message,
          },
          ...(routeAttempts.length === 0 ? {} : { metrics: { attempts: routeAttempts } }),
        };
      };

      /**
       * One auxiliary invocation on the one model the selector resolved.
       * Supported reasoning effort is decided before selection; this path keeps
       * context-budget safety, classified failures, and per-attempt ledger
       * accounting.
       */
      const runAuxiliary = async (): Promise<ModelResult> => {
        const route = auxiliaryRoute!;
        const firstResponseTimeoutSec = auxiliaryFirstResponseTimeoutSec(input.role);
        const budget = checkContextBudget(route.model, messages, models, maxTokens);
        estimatedInputTokens = budget.estimatedInputTokens;
        model = route.model;
        selectedRank = 1;
        if (!budget.ok) {
          const message = `context_overflow: ${budget.reason}`;
          return await fail(message, auxiliaryFailure(message, undefined, 'context_overflow'));
        }
        const selectableEffort = hasSelectableReasoningEfforts(budget.metadata);
        actualReasoningEffort = selectableEffort ? route.reasoningEffort : PROVIDER_DEFAULT_REASONING;
        await options.append({
          type: 'span.started',
          id: input.spanId,
          parent: input.parent,
          kind: spanKind,
          ...(input.turn === undefined ? {} : { turn: input.turn }),
          ...(input.step === undefined ? {} : { step: input.step }),
          request: {
            ...(auxiliaryRole === undefined ? {} : { role: auxiliaryRole }),
            model,
            effort: {
              ...(requestedReasoningEffort === undefined ? {} : { requested: requestedReasoningEffort }),
              ...(actualReasoningEffort === undefined ? {} : { sent: actualReasoningEffort }),
            },
            inputEstimate: estimatedInputTokens,
            layers: input.layers,
            route: { candidates: [route], rank: selectedRank },
          },
        });

        if (controller.signal.aborted) {
          const message = abortMessage(abortKind);
          return await fail(message, { status: 'aborted' });
        }

        const requestMaxOutputTokens = budget.requestMaxOutputTokens ?? maxTokens;
        try {
          const completed = await callModelAttempt({
            transport: options.transport,
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            messages,
            budget,
            firstResponseTimeoutSec,
            signal: controller.signal,
            onEvent,
            cacheKey: options.cacheKey,
            maxOutputTokens: requestMaxOutputTokens,
            ...(input.tools === undefined ? {} : { tools: input.tools }),
            ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
          });
          collectAttempts(completed.result.metrics);
          return completed.result;
        } catch (error) {
          if (error instanceof ModelCallError) throw error;
          const fact = errorFactOf(error);
          const cancelled = abortKind === 'signal';
          collectAttempts(metricsOf(error));
          if (cancelled || outputStarted) throw error;
          if (fact.kind === 'invalid_request' || fact.kind === 'context_overflow' || fact.kind === 'protocol' || fact.kind === 'aborted') throw error;
          const message = withOverflowPrefix(error);
          return await fail(message, auxiliaryFailure(message, fact.retryAt, fact.kind));
        }
      };

      /** One main reasoning turn on the route chosen for this step. */
      const runReasoning = async (): Promise<ModelResult> => {
        const first = input.reason!;
        const automatic = first.automatic === true;
        // The automatic ladder is read only when a switch really happens, so an
        // ordinary step never pays for a routing query.
        const candidates: ReasonSelection[] = [first];
        let ladderLoaded = false;
        const addLadder = async (): Promise<void> => {
          if (ladderLoaded || !automatic || options.selectAutomaticRoutes === undefined) return;
          ladderLoaded = true;
          let ladder: readonly ReasonSelection[];
          try {
            ladder = await settleWithAbort(options.selectAutomaticRoutes(), controller.signal);
          } catch (error) {
            // A cancellation still wins; a routing failure just leaves the turn
            // with the candidates it already has.
            if (controller.signal.aborted) throw error;
            return;
          }
          for (const candidate of ladder) {
            const key = routeKeyOf(candidate.provider, candidate.model);
            if (candidates.some((known) => routeKeyOf(known.provider, known.model) === key)) continue;
            candidates.push(candidate);
          }
        };

        let started = false;
        const excludedModels = new Set<string>();
        const consecutiveFailures = new Map<string, number>();
        let retriesUsed = 0;
        const retriesEnabled = reasoningRetriesEnabled(automatic, options.retryPolicy);
        let lastError: unknown;
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          const candidateModel = routeKeyOf(candidate.provider, candidate.model);
          if (excludedModels.has(candidateModel)) continue;
          const budget = checkContextBudget(candidateModel, messages, models, maxTokens);
          // A route with no selectable level accepts any requested effort and is
          // sent at its own default. A route that declares real levels keeps the
          // exact support check.
          const selectableEffort = hasSelectableReasoningEfforts(budget.metadata);
          if (selectableEffort && !isReasoningEffortSupported(budget.metadata, candidate.reasoningEffort)) {
            if (candidate === first) {
              return await fail(`Model ${candidateModel} does not support reasoning effort "${candidate.reasoningEffort ?? ''}"`);
            }
            continue;
          }
          if (!budget.ok) {
            if (candidate === first) return await fail(`context_overflow: ${budget.reason}`);
            continue;
          }
          model = candidateModel;
          estimatedInputTokens = budget.estimatedInputTokens;
          actualReasoningEffort = selectableEffort ? candidate.reasoningEffort : PROVIDER_DEFAULT_REASONING;
          const requestMaxOutputTokens = budget.requestMaxOutputTokens ?? maxTokens;
          // One invocation writes exactly one started span, whichever route
          // ends up answering it.
          if (!started) {
            started = true;
            requestedReasoningEffort = candidate.reasoningEffort;
            await options.append({
              type: 'span.started',
              id: input.spanId,
              parent: input.parent,
              kind: spanKind,
              ...(input.turn === undefined ? {} : { turn: input.turn }),
              ...(input.step === undefined ? {} : { step: input.step }),
              request: {
                model,
                effort: {
                  ...(requestedReasoningEffort === undefined ? {} : { requested: requestedReasoningEffort }),
                  ...(actualReasoningEffort === undefined ? {} : { sent: actualReasoningEffort }),
                },
                inputEstimate: estimatedInputTokens,
                layers: input.layers,
              },
            });
          }
          for (;;) {
            try {
              const completed = await callModelAttempt({
                transport: options.transport,
                model: candidateModel,
                reasoningEffort: candidate.reasoningEffort,
                messages,
                budget,
                // The main reasoning path carries the user's explicit Fast
                // preference, including an explicit false; an absent preference
                // sends no field at all. Auxiliary requests never set it.
                ...(candidate.fast === undefined ? {} : { fast: candidate.fast }),
                ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
                maxOutputTokens: requestMaxOutputTokens,
                ...(input.tools === undefined ? {} : { tools: input.tools }),
                ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
                signal: controller.signal,
                onEvent,
              });
              collectAttempts(completed.result.metrics);
              return completed.result;
            } catch (error) {
              lastError = error;
              collectAttempts(metricsOf(error));
              const capacityFailure = isModelError(error) && (error.kind === 'quota_exhausted'
                || (error.kind === 'rate_limited' && (error.retryAt !== undefined || error.retryAfterMs !== undefined)));
              if (!retriesEnabled || controller.signal.aborted || outputStarted
                || (isModelError(error) && error.outputStarted)
                || retriesUsed >= REASONING_MAX_RETRIES
                || (!isReasoningCallerRetryable(error, outputStarted) && !(automatic && capacityFailure))) {
                throw error;
              }
              const failures = (consecutiveFailures.get(candidateModel) ?? 0) + 1;
              consecutiveFailures.set(candidateModel, failures);
              const switchRoute = automatic && (capacityFailure || failures >= 2);
              if (switchRoute) {
                excludedModels.add(candidateModel);
                await addLadder();
              }
              retriesUsed += 1;
              if (capacityFailure) break;
              const delayMs = reasoningRetryDelayMs(retriesUsed);
              // The waiting line carries the real time the next attempt starts.
              reportWait({ reason: 'recovery', retryAt: new Date(Date.now() + delayMs).toISOString() });
              try {
                await delayWithAbort(delayMs, controller.signal);
              } finally {
                reportWait(null);
              }
              if (switchRoute) break;
            }
          }
        }
        // No candidate is left: the turn fails with what it last saw.
        throw lastError ?? new Error('Main reasoning: no candidate qualified');
      };

      try {
        if (input.role === 'reason') {
          const selection = input.reason;
          if (!selection) return await fail('The reason role requires a model selection');
          model = routeKeyOf(selection.provider, selection.model);
          requestedReasoningEffort = selection.reasoningEffort;
        } else {
          auxiliaryRole = input.role;
          auxiliaryRoute = await settleWithAbort(
            options.resolveAuxiliaryModel(input.role, { toolChoice: input.toolChoice }),
            controller.signal,
          );
        }
        if (controller.signal.aborted) {
          return await fail(abortMessage(abortKind), { status: 'aborted' });
        }

        if (input.role === 'reason') {
          result = await runReasoning();
        } else {
          result = await runAuxiliary();
        }
      } catch (error) {
        if (error instanceof ModelCallError) throw error;
        const status: 'failed' | 'aborted' = abortKind === 'signal' ? 'aborted' : 'failed';
        const message = abortKind === undefined
          ? withOverflowPrefix(error)
          : abortMessage(abortKind);
        const failure = abortKind === undefined ? errorFactOf(error) : { kind: 'aborted' as ModelErrorKind, message };
        const baseMetrics = metricsOf(error);
        const metrics: ModelMetrics | undefined = routeAttempts.length === 0
          ? baseMetrics
          : { ...(baseMetrics ?? { attempts: [] }), attempts: routeAttempts };
        return await fail(message, {
          status,
          error: failure,
          ...(metrics === undefined ? {} : { metrics }),
        });
      } finally {
        // Completion or cancel ends any recovery wait.
        reportWait(null);
        input.signal.removeEventListener('abort', onExternalAbort);
      }

      const completed = result!;
      // Visible text only; native tool calls are returned separately.
      const finalText = completed.text;
      const finalReasoning = completed.reasoning;
      const usage = completed.usage ?? partialUsage;
      const metrics: ModelMetrics = routeAttempts.length === 0
        ? completed.metrics
        : { ...completed.metrics, attempts: routeAttempts };

      await finish('ok', {
        output: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        metrics,
      });

      // The serving candidate's public id is `provider/model`; the provider is
      // the segment before the first separator and stays absent when the id is
      // not provider-qualified.
      const providerOfServing = model.includes('/') ? model.slice(0, model.indexOf('/')) : undefined;

      return {
        model,
        text: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        ...(usage === undefined ? {} : { usage }),
        toolCalls: completed.toolCalls,
        ...(completed.finishReason === undefined ? {} : { finishReason: completed.finishReason }),
        metrics,
        route: {
          ...(providerOfServing === undefined ? {} : { provider: providerOfServing }),
          model,
          ...(actualReasoningEffort === undefined ? {} : { effort: actualReasoningEffort }),
        },
      };
    },
  };
}
