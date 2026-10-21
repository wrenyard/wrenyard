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
import { randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import type { GatewayRouteStatus, ProviderDefinition } from '@wrenyard/providers/base';
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
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  type ModelPreflightResult,
  type ModelWaitReason,
  type ToolCall,
  type ToolSpec,
  type ToolChoice,
  type Usage,
} from '../transport/index.ts';
import type { ModelSpanFinishedEvent, ModelSpanStartedEvent } from '../ledger/events.ts';
import type { AuxiliaryCallRole } from './roles.ts';
import { boundedOutputReservation, resolveModelMetadata, type ModelMetadata } from './metadata.ts';

// The pure metadata helper now lives in the browser-safe model-metadata entry;
// the call runner re-exports it so existing `./calls.ts` consumers are unchanged.
export { resolveModelMetadata } from './metadata.ts';
export type { ModelMetadata } from './metadata.ts';

export type { Message, ModelContentPart, ToolCall, ToolSpec, Usage } from '../transport/index.ts';

/** Every role that may issue a call. `reason` is the one expensive role. */
export const CALL_ROLES = ['reason', 'memory-search', 'search', 'dispatch', 'reply', 'title', 'document', 'todo', 'vcs', 'project', 'status', 'suggestion', 'task-output'] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/**
 * First-response timeout auxiliary roles pass to the Gateway (seconds). Main
 * reasoning omits the header and uses the Gateway default (120 s).
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

/**
 * Route health the runner reads: the Gateway's typed route status. A present
 * open status means the route is blocked until `until`.
 */
export type RouteHealth = GatewayRouteStatus;

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
   * The earliest instant the failed call may be retried, when the route health
   * a bounded failover read gives one. It is not an attempt record: a route
   * that was never called still reports its own retry instant here.
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
  messages: readonly import('../transport/index.ts').Message[];
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
  finishReason?: import('../transport/index.ts').FinishReason;
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
  resolveProvider?: (providerId: string) => ProviderDefinition | undefined;
  /** The one unified transport every role calls. */
  transport: ModelTransport;
  /** Current Gateway state of a route; a provider or pool failure can block sibling routes. */
  routeStatus?: (model: string) => RouteHealth | undefined;
  /** Session id, sent to the Gateway for request attribution. */
  sessionId?: string;
  /**
   * Fresh non-empty ranked routes for each auxiliary invocation. The request's
   * `tool_choice` is forwarded so a forced choice never selects a provider that
   * cannot honour it.
   */
  selectAuxiliary: (
    role: AuxiliaryCallRole,
    input?: { toolChoice?: ToolChoice },
  ) => readonly AuxiliaryRoute[] | Promise<readonly AuxiliaryRoute[]>;
  /** Whether routing.exclude currently names a `provider/model` route. */
  isRouteExcluded?: (model: string) => boolean;
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

let tokenizer: ReturnType<typeof getEncoding> | undefined;

/** Fallback per-image input-token estimate when only a data URL is available. */
export const IMAGE_INPUT_TOKEN_ESTIMATE = 1_200;

/** `o200k_base` token count estimate of one text. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  tokenizer ??= getEncoding('o200k_base');
  return tokenizer.encode(text).length;
}

/**
 * Token estimate of one message content. Text parts are counted with the same
 * tokenizer; an image part contributes a fixed processed-image estimate, never
 * the base64 payload length.
 */
export function estimateContentTokens(content: string | readonly ModelContentPart[]): number {
  if (typeof content === 'string') return estimateTokens(content);
  let total = 0;
  for (const part of content) {
    total += part.type === 'text' ? estimateTokens(part.text) : IMAGE_INPUT_TOKEN_ESTIMATE;
  }
  return total;
}

/** `o200k_base` token count estimate of a supplied message list. */
export function estimateInputTokens(messages: readonly import('../transport/index.ts').Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.role) + estimateContentTokens(message.content);
  return total;
}

/**
 * Defense in depth: only the main reasoning role may carry image bytes. For any
 * other role every `image_url` part is replaced by a textual omitted descriptor
 * before the budget check and the driver, so a auxiliary request can never transmit
 * image content.
 */
export function sanitizeMessagesForRole(
  role: CallRole,
  messages: readonly import('../transport/index.ts').Message[],
): readonly import('../transport/index.ts').Message[] {
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

export interface ContextBudget {
  metadata: ModelMetadata;
  estimatedInputTokens: number;
  /**
   * The request output cap this call resolves and forwards as the serialized
   * transport cap. See {@link checkContextBudget}. Absent when the legacy
   * behaviour applies and no explicit per-call cap was given, in which case the
   * protocol's own default output field still applies.
   */
  requestMaxOutputTokens?: number;
  /** True when the call may be sent. */
  ok: boolean;
  /** Why the call may not be sent; absent when `ok`. */
  reason?: string;
}

/**
 * Context budget check. The model maximum is the only limit — there is no
 * extra soft budget — and a call is refused when the estimate plus the output
 * the request reserves would exceed its window.
 *
 * The declared `metadata.maxOutputTokens` is the model's source maximum — a
 * capability, not a mandatory per-request reservation. It is reserved only up to
 * {@link boundedOutputReservation}: reserving a huge declared maximum verbatim
 * would leave almost no input budget, so a request never reserves more than the
 * shared cap. A per-call cap that is already smaller than that bound still wins.
 * A route whose provider
 * opted out of the canonical metadata fallback therefore resolves its request
 * output cap to the smallest of the per-call cap (or the source maximum when
 * none was requested), the source maximum when known, and the room left after
 * the estimated input:
 *
 *   min(requested cap or source max, source max when known, contextWindow - estimatedInputTokens)
 *
 * Such a route fails only when the estimated input leaves no positive room. Its
 * resolved `requestMaxOutputTokens` is the single cap handed back for both this
 * check and the serialized transport request. Every other route keeps its prior
 * budget semantics: the per-call cap is reserved verbatim (never raised above the
 * source maximum) and, with none, the source maximum is reserved exactly as
 * before.
 */
export function checkContextBudget(
  publicId: string,
  messages: readonly import('../transport/index.ts').Message[],
  resolveProvider?: (providerId: string) => ProviderDefinition | undefined,
  requestedMaxOutputTokens?: number,
): ContextBudget {
  const metadata = resolveModelMetadata(publicId, resolveProvider);
  const estimatedInputTokens = estimateInputTokens(messages);
  const { contextWindow } = metadata;
  const sourceMax = boundedOutputReservation(metadata.maxOutputTokens);

  if (metadata.skipCanonicalMetadataFallback === true) {
    const requested = requestedMaxOutputTokens ?? sourceMax;
    if (requested === undefined) return { metadata, estimatedInputTokens, ok: true };
    const bounded = sourceMax === undefined ? requested : Math.min(requested, sourceMax);
    if (contextWindow === undefined) {
      return { metadata, estimatedInputTokens, requestMaxOutputTokens: bounded, ok: true };
    }
    const room = contextWindow - estimatedInputTokens;
    if (room <= 0) {
      return {
        metadata,
        estimatedInputTokens,
        ok: false,
        reason: `Estimated input ${estimatedInputTokens} leaves no room in the context window ${contextWindow}`,
      };
    }
    return { metadata, estimatedInputTokens, requestMaxOutputTokens: Math.min(bounded, room), ok: true };
  }

  // No declared window or maximum: nothing to check, exactly as before.
  if (contextWindow === undefined || sourceMax === undefined) {
    return { metadata, estimatedInputTokens, ok: true };
  }
  // With no explicit per-call cap the legacy reservation is the source maximum;
  // the protocol default is still what the transport sends, so no cap is added.
  if (requestedMaxOutputTokens === undefined) {
    if (estimatedInputTokens + sourceMax > contextWindow) {
      return {
        metadata,
        estimatedInputTokens,
        ok: false,
        reason: `Estimated input ${estimatedInputTokens} + max output ${sourceMax} exceeds the context window ${contextWindow}`,
      };
    }
    return { metadata, estimatedInputTokens, ok: true };
  }
  const reserved = Math.min(requestedMaxOutputTokens, sourceMax);
  if (estimatedInputTokens + reserved > contextWindow) {
    return {
      metadata,
      estimatedInputTokens,
      ok: false,
      reason: `Estimated input ${estimatedInputTokens} + max output ${reserved} exceeds the context window ${contextWindow}`,
    };
  }
  return { metadata, estimatedInputTokens, requestMaxOutputTokens: reserved, ok: true };
}

/**
 * The budget facts compaction and the turn need, resolved exactly as
 * {@link checkContextBudget} resolves them. `threshold` is the input size above
 * which a request compacts before sending: the lower of half the room left after
 * the output reservation and the fixed {@link COMPACTION_THRESHOLD_CAP}.
 */
export interface ContextBudgetFacts {
  contextWindow?: number;
  estimatedInputTokens: number;
  /** Output tokens the request reserves; absent when nothing is reserved. */
  outputReservation?: number;
  /** Input-token compaction threshold; absent when the window is unknown. */
  threshold?: number;
}

/** Metadata and budget facts of one assembled request, without mutating it. */
export function contextBudgetOf(
  publicId: string,
  messages: readonly import('../transport/index.ts').Message[],
  resolveProvider?: (providerId: string) => ProviderDefinition | undefined,
  requestedMaxOutputTokens?: number,
): ContextBudgetFacts {
  const metadata = resolveModelMetadata(publicId, resolveProvider);
  const estimatedInputTokens = estimateInputTokens(messages);
  const { contextWindow } = metadata;
  const sourceMax = boundedOutputReservation(metadata.maxOutputTokens);
  const outputReservation = metadata.skipCanonicalMetadataFallback === true
    ? sourceMax === undefined
      ? requestedMaxOutputTokens
      : Math.min(requestedMaxOutputTokens ?? sourceMax, sourceMax)
    : requestedMaxOutputTokens === undefined
      ? sourceMax
      : sourceMax === undefined
        ? undefined
        : Math.min(requestedMaxOutputTokens, sourceMax);
  const threshold = contextWindow === undefined || outputReservation === undefined
    ? undefined
    : Math.min(Math.floor(0.5 * (contextWindow - outputReservation)), COMPACTION_THRESHOLD_CAP);
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    estimatedInputTokens,
    ...(outputReservation === undefined ? {} : { outputReservation }),
    ...(threshold === undefined ? {} : { threshold }),
  };
}

/**
 * True only when the route declares the level as a legal reasoning effort. An
 * undeclared list is not a licence to accept an arbitrary level.
 */
export function isReasoningEffortSupported(metadata: ModelMetadata, effort: ReasoningEffort): boolean {
  return metadata.reasoningEfforts?.includes(effort) ?? false;
}

/**
 * True only for a route whose whole ladder is the single provider-default
 * sentinel. Such a route offers no selectable weak-to-strong level; any
 * requested level is satisfied by the route's own upstream default, which
 * materializes no explicit reasoning field. The sentinel is never substituted
 * for a route that declares real levels.
 */
export function isProviderDefaultReasoningOnly(metadata: ModelMetadata): boolean {
  const efforts = metadata.reasoningEfforts;
  return efforts !== undefined && efforts.length === 1 && efforts[0] === PROVIDER_DEFAULT_REASONING;
}

/** Reject promptly when the signal aborts, even while awaiting a plain promise. */
function settleWithAbort<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  const settled = Promise.resolve(value);
  if (signal.aborted) {
    // The caller has already created `value` (e.g. a transport request). We stop
    // waiting on it, but we must still observe it: its rejection would otherwise
    // be an unhandled rejection.
    void settled.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    settled.then(
      (resolved) => {
        signal.removeEventListener('abort', onAbort);
        resolve(resolved);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

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
 * limit with a reset, authentication, an unknown model or a caller error), a
 * local admission refusal and anything observed after output started fail at
 * once.
 */
function isReasoningCallerRetryable(error: unknown, outputStarted: boolean): boolean {
  if (outputStarted || !isModelError(error)) return false;
  if (error.outputStarted === true || error.source === 'admission') return false;
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

/**
 * The instant (epoch ms) the main reasoning route admits requests again, or
 * `undefined` when it is callable now. The transport waits it out before
 * sending. An exhausted quota with an upstream-stated reset is not waited for:
 * `final` ends the turn and asks the user to switch models.
 */
function routeNotBeforeMs(
  model: string,
  health: RouteHealth | undefined,
  nowMs: number,
): ModelPreflightResult | undefined {
  if (health === undefined || health.phase !== 'open') return undefined;
  const parsed = Date.parse(health.until);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return undefined;
  if (health.state === 'quota_exhausted' && health.resets === true) {
    const at = new Date(parsed);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    return { notBeforeMs: parsed, faultState: health.state, final: `${model} 的额度已用尽，预计 ${hhmm} 恢复；请换一个模型继续` };
  }
  return { notBeforeMs: parsed, faultState: health.state };
}

/** Create the role-aware call runner. */
export function createCallRunner(options: CallRunnerOptions): CallRunner {
  return {
    async run(input: ModelCallInput): Promise<ModelCallOutput> {
      // Non-reasoning roles never transmit image bytes: image parts become a
      // textual omitted descriptor before the budget check and the driver.
      const messages = sanitizeMessagesForRole(input.role, input.messages);
      // The suggestion role always carries its own tiny output allowance, so a
      // caller cannot spend more than a short hint's worth of tokens on it.
      const maxTokens = input.role === 'suggestion' ? SUGGESTION_MAX_TOKENS : input.maxTokens;
      const spanKind: 'reasoning' | 'auxiliary' = input.role === 'reason' ? 'reasoning' : 'auxiliary';
      let model = '';
      let estimatedInputTokens = 0;
      let actualReasoningEffort: ReasoningEffort | undefined;
      let requestedReasoningEffort: string | undefined;
      let auxiliaryRole: AuxiliaryCallRole | undefined;
      let routes: readonly AuxiliaryRoute[] | undefined;
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
      // attempts so the ledger records exactly what was tried and when the route
      // may be retried.
      const routeAttempts: ModelAttempt[] = [];
      /** Merge one route's own attempt records in order, stamped with its retry instant. */
      const collectAttempts = (metrics: ModelMetrics | undefined, routeUntil: string | undefined): number => {
        let added = 0;
        for (const attempt of metrics?.attempts ?? []) {
          routeAttempts.push(routeUntil === undefined ? attempt : { ...attempt, routeUntil });
          added += 1;
        }
        return added;
      };
      const retryInstantOf = (candidate: string): string | undefined => {
        const health = options.routeStatus?.(candidate);
        return health?.until;
      };
      /**
       * Route health handed to the transport for one main reasoning attempt. An
       * excluded route is reported as unusable so an open wait gives up and the
       * turn can re-select, even when the Gateway has no fault state for it.
       */
      const reasoningPreflight = (routeModel: string): ModelPreflightResult | undefined => {
        if (options.isRouteExcluded?.(routeModel) === true) {
          return { notBeforeMs: Number.MAX_SAFE_INTEGER, excluded: true };
        }
        return options.routeStatus === undefined
          ? undefined
          : routeNotBeforeMs(routeModel, options.routeStatus(routeModel), Date.now());
      };
      /**
       * The failure detail of one auxiliary exhaustion: every attempt tried so
       * far, the route's own retry instant, and the kind of the last real
       * failure. A user cancellation is neutral — it is `aborted` and carries no
       * retry time — and an all-open set reports the earliest retry it read from
       * the route health without inventing an attempt that never happened.
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
       * One auxiliary invocation on the selector's first ranked route only.
       * Route admission and supported reasoning effort are decided before
       * selection; this path keeps context-budget safety, classified failures,
       * and per-attempt ledger accounting.
       */
      const runAuxiliary = async (): Promise<ModelResult> => {
        const all = routes!;
        const route = all[0]!;
        const firstResponseTimeoutSec = auxiliaryFirstResponseTimeoutSec(input.role);
        const budget = checkContextBudget(route.model, messages, options.resolveProvider, maxTokens);
        estimatedInputTokens = budget.estimatedInputTokens;
        model = route.model;
        selectedRank = 1;
        if (!budget.ok) {
          const message = `context_overflow: ${budget.reason}`;
          return await fail(message, auxiliaryFailure(message, undefined, 'context_overflow'));
        }
        const providerDefaultOnly = isProviderDefaultReasoningOnly(budget.metadata);
        actualReasoningEffort = providerDefaultOnly ? PROVIDER_DEFAULT_REASONING : route.reasoningEffort;
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
            route: { candidates: all, rank: selectedRank },
          },
        });

        if (controller.signal.aborted) {
          const message = abortMessage(abortKind);
          return await fail(message, { status: 'aborted' });
        }

        const requestMaxOutputTokens = budget.requestMaxOutputTokens ?? maxTokens;
        const effort = actualReasoningEffort!;
        const attemptId = randomUUID();
        try {
          const request: ModelRequest = {
            model: route.model,
            messages,
            reasoningEffort: effort,
            attribution: { role: input.role, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) },
            ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
            ...(requestMaxOutputTokens === undefined ? {} : { maxOutputTokens: requestMaxOutputTokens }),
            ...(input.tools === undefined ? {} : { tools: input.tools }),
            ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
            firstResponseTimeoutSec,
            signal: controller.signal,
            onEvent,
            attemptId,
          };
          const completed = await settleWithAbort(options.transport.complete(request), controller.signal);
          collectAttempts(completed.metrics, retryInstantOf(route.model));
          return completed;
        } catch (error) {
          if (error instanceof ModelCallError) throw error;
          const fact = errorFactOf(error);
          const cancelled = abortKind === 'signal';
          const attemptUntil = retryInstantOf(route.model);
          collectAttempts(metricsOf(error), attemptUntil);
          if (cancelled || outputStarted) throw error;
          if (fact.kind === 'invalid_request' || fact.kind === 'context_overflow' || fact.kind === 'protocol' || fact.kind === 'aborted') throw error;
          const message = withOverflowPrefix(error);
          return await fail(message, auxiliaryFailure(message, attemptUntil, fact.kind));
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
          // A later ladder route is skipped when routing.exclude already names
          // it; it never spends the turn.
          if (candidate !== first && options.isRouteExcluded?.(candidateModel) === true) continue;
          const budget = checkContextBudget(candidateModel, messages, options.resolveProvider, maxTokens);
          // A route whose whole ladder is the provider-default sentinel has no
          // selectable level: it accepts any requested effort and is sent at its
          // own default. Every other route keeps the exact support check.
          const providerDefaultOnly = isProviderDefaultReasoningOnly(budget.metadata);
          if (!providerDefaultOnly && !isReasoningEffortSupported(budget.metadata, candidate.reasoningEffort)) {
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
          actualReasoningEffort = providerDefaultOnly ? PROVIDER_DEFAULT_REASONING : candidate.reasoningEffort;
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
              const completed = await settleWithAbort(options.transport.complete({
                model: candidateModel,
                messages,
                reasoningEffort: actualReasoningEffort,
                // The main reasoning path carries the user's explicit Fast
                // preference, including an explicit false; an absent preference
                // sends no field at all. Auxiliary requests never set it.
                ...(candidate.fast === undefined ? {} : { fast: candidate.fast }),
                attribution: { role: input.role, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) },
                ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
                ...(requestMaxOutputTokens === undefined ? {} : { maxOutputTokens: requestMaxOutputTokens }),
                ...(input.tools === undefined ? {} : { tools: input.tools }),
                ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
                ...(options.routeStatus === undefined && options.isRouteExcluded === undefined
                  ? {}
                  : { preflight: () => reasoningPreflight(candidateModel) }),
                signal: controller.signal,
                onEvent,
              }), controller.signal);
              collectAttempts(completed.metrics, retryInstantOf(candidateModel));
              return completed;
            } catch (error) {
              lastError = error;
              collectAttempts(metricsOf(error), retryInstantOf(candidateModel));
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
          routes = await settleWithAbort(
            options.selectAuxiliary(input.role, { toolChoice: input.toolChoice }),
            controller.signal,
          );
          if (!routes.length) throw new Error(`Auxiliary role ${input.role}: no candidate qualified (empty route selection)`);
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
