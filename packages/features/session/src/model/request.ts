/**
 * session model calls.
 *
 * One call is one stateless request: pick the role's model, resolve its model
 * metadata, estimate the input with `o200k_base`, enforce the context budget,
 * run it through the {@link ModelTransport} under the role's timeout, and write
 * exactly one `span.started` and one `span.finished` ledger event for the
 * invocation. The runner keeps no session state, never parses JSON output and
 * never repairs schemas — those belong to `actions.ts` / `engine.ts`.
 *
 * The transport owns the only same-route retry and the protocol adapters. The
 * runner performs no failover: the main reasoning call keeps the user's model,
 * and an auxiliary call keeps the one route it selected after skipping blocked
 * routes, failing on the selected route instead of switching to another.
 */
import { randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import type { GatewayRouteStatus, ProviderDefinition } from '@wrenyard/providers/base';
import { PROVIDER_DEFAULT_REASONING, type ReasoningEffort } from '@wrenyard/models';
import {
  abortError,
  isContextOverflowError,
  type ModelContentPart,
  type ModelErrorKind,
  type ModelAttempt,
  type ModelEvent,
  type ModelMetrics,
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  type ModelWaitReason,
  type ToolCall,
  type ToolSpec,
  type ToolChoice,
  type Usage,
} from '../transport/index.ts';
import type { ModelSpanFinishedEvent, ModelSpanStartedEvent } from '../ledger/events.ts';
import { ROLE_REQUIREMENTS } from '@wrenyard/auto-routing';
import type { AuxiliaryCallRole } from './roles.ts';
import { boundedOutputReservation, resolveModelMetadata, type ModelMetadata } from './metadata.ts';

// The pure metadata helper now lives in the browser-safe model-metadata entry;
// the call runner re-exports it so existing `./calls.ts` consumers are unchanged.
export { resolveModelMetadata } from './metadata.ts';
export type { ModelMetadata } from './metadata.ts';

export type { Message, ModelContentPart, ToolCall, ToolSpec, Usage } from '../transport/index.ts';

/** Every role that may issue a call. `reason` is the one expensive role. */
export const CALL_ROLES = ['reason', 'memory-search', 'search', 'dispatch', 'reply', 'title', 'document', 'todo', 'vcs', 'project', 'status', 'suggestion'] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/** The expensive role streams with no total deadline; its idle stream is bounded. */
export const REASON_IDLE_TIMEOUT_MS = 180_000;
/** Every auxiliary request is bounded end to end. */
export const AUXILIARY_TIMEOUT_MS = 60_000;
/** The whole bounded auxiliary failover budget: route selection plus every attempt. */
export const AUXILIARY_TOTAL_BUDGET_MS = AUXILIARY_TIMEOUT_MS;
/** At most this many distinct candidate routes, each tried once. */
export const AUXILIARY_MAX_ROUTES = 3;
/**
 * Per-attempt no-progress deadline for auxiliary calls. It is reset on any
 * streamed output, so a route that keeps producing tokens is never cut off by
 * it; it aborts the attempt only after this long with no output. It is distinct
 * from {@link AUXILIARY_TOTAL_BUDGET_MS}, the finite total budget that cuts the
 * whole call regardless of progress.
 */
export const AUXILIARY_IDLE_TIMEOUT_MS = 30_000;
/**
 * The two local, caller-side terminal classifications this runner decides
 * itself — never a transport adapter: the caller's finite auxiliary total
 * budget ran out (`local_budget`) or the last attempt was cut by the local
 * per-route no-progress deadline (`local_deadline`). They share the `kind` slot
 * with the transport's {@link ModelErrorKind} so the span and attempt error
 * surfaces keep one shape, but they are local facts and must never be read as
 * an upstream `network`, `server` or `aborted`; the assertions below are the
 * single point where the local vocabulary meets the transport's.
 */
export const LOCAL_CALL_ERROR = {
  /** The caller's own finite total budget cut the whole call. */
  budget: 'local_budget' as ModelErrorKind,
  /** The per-route idle/no-progress deadline cut the last attempt. */
  deadline: 'local_deadline' as ModelErrorKind,
};

/**
 * Route health the runner reads: the Gateway's typed route status, whose circuit
 * detail (`phase`, `nextProbeAt`, `faultKind`) is what decides whether a route
 * may be tried now.
 */
export type RouteHealth = GatewayRouteStatus;

/** Output-token allowance for the one next-input suggestion call (384 tokens). */
export const SUGGESTION_MAX_TOKENS = 384;
/** Total deadline for the suggestion role, including auxiliary route selection (15 s). */
export const SUGGESTION_TIMEOUT_MS = 15_000;
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
  /**
   * Announce the start of one auxiliary attempt, so a later client-observed
   * timeout or transport failure is attributed to the same attempt the Gateway
   * already saw. Optional: absent, no attempt-level feedback is sent.
   */
  beginRouteAttempt?: (publicModel: string, attemptId: string) => void;
  /**
   * Report a client-observed route fault (timeout or real transport failure) for
   * one attempt into the same route-health authority. Never called for a user
   * cancellation or an HTTP error the Gateway already recorded.
   */
  reportRouteFault?: (publicModel: string, attemptId: string, kind: 'timeout' | 'transport') => void;
  /** Release one attempt's bookkeeping once it has settled. */
  completeRouteAttempt?: (publicModel: string, attemptId: string) => void;
  /** Session id, sent to the Gateway for request attribution. */
  sessionId?: string;
  /** Fresh non-empty ranked routes for each auxiliary invocation. */
  selectAuxiliary: (role: AuxiliaryCallRole) => readonly AuxiliaryRoute[] | Promise<readonly AuxiliaryRoute[]>;
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

/** Human-readable failure message for one abort cause. */
function abortMessage(kind: 'signal' | 'timeout' | 'idle' | undefined, totalTimeoutMs: number | undefined): string {
  if (kind === 'timeout') return `Call timed out after ${totalTimeoutMs} ms`;
  if (kind === 'idle') return `Reasoning stalled: no output for ${REASON_IDLE_TIMEOUT_MS} ms`;
  if (kind === 'signal') return 'Model call was aborted';
  return 'Model call failed';
}

/**
 * Structured failure fact of a call this runner cut itself. It carries the
 * local classification — `local_budget` for the caller's exhausted total
 * budget, `local_deadline` for a per-route idle stall that ended the call — so
 * the span error surface tells a local cut apart from any upstream
 * {@link ModelErrorKind}.
 */
function localCutFact(kind: 'budget' | 'deadline', message: string): CallErrorFact {
  return { kind: kind === 'budget' ? LOCAL_CALL_ERROR.budget : LOCAL_CALL_ERROR.deadline, message };
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
 * Distinct candidate routes for one logical auxiliary call, in preference order.
 * A repeated model is dropped so a failover can never retry a route it already
 * used. The list is NOT truncated here: the runner skips routes that are open or
 * mid-probe and stops only after {@link AUXILIARY_MAX_ROUTES} routes were
 * actually called, so a skipped route never consumes one of the three attempts.
 */
function distinctCandidates(routes: readonly AuxiliaryRoute[]): AuxiliaryRoute[] {
  const candidates: AuxiliaryRoute[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.model)) continue;
    seen.add(route.model);
    candidates.push(route);
  }
  return candidates;
}

/**
 * True when the route may be called now: healthy, or half-open with its bounded
 * recovery probe due. An open route, or a route whose `nextProbeAt` is still in
 * the future — a half-open route another caller is already probing under a
 * lease, as well as one whose probe is not yet due — is skipped so the attempt
 * is spent on a route that can actually answer.
 */
function isCallableNow(health: RouteHealth | undefined, nowMs: number): boolean {
  if (health === undefined) return true;
  if (health.phase === 'open') return false;
  if (health.nextProbeAt !== undefined) return Date.parse(health.nextProbeAt) <= nowMs;
  return true;
}

/**
 * The absolute instant (epoch ms) the route may next be probed, or `undefined`
 * when it is callable now. The main reasoning call hands this to the transport
 * as its pre-admission check, so a route already known to be cooling down is
 * waited out inside the one retry budget instead of being probed early and
 * rejected by the Gateway.
 */
function routeNotBeforeMs(health: RouteHealth | undefined, nowMs: number): number | undefined {
  if (health === undefined) return undefined;
  const candidate = health.nextProbeAt ?? (health.phase === 'open' ? health.until : undefined);
  if (candidate === undefined) return undefined;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : undefined;
}

/** The earlier of two optional ISO instants. */
function earliest(current: string | undefined, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
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

      // Timers and abort wiring come first so the total deadline also covers
      // auxiliary route selection and driver acquisition; the same start instant
      // anchors the per-route budget, so selection time is never free.
      const startedAtMs = Date.now();
      const controller = new AbortController();
      let abortKind: 'signal' | 'timeout' | 'idle' | undefined;
      const abort = (kind: 'signal' | 'timeout' | 'idle'): void => {
        abortKind ??= kind;
        controller.abort();
      };
      const onExternalAbort = (): void => abort('signal');
      if (input.signal.aborted) abort('signal');
      else input.signal.addEventListener('abort', onExternalAbort, { once: true });

      // Every auxiliary role, including document, shares one finite total budget
      // that also covers route selection; only the reasoning role streams with
      // no total deadline. The suggestion role is a cheap, fire-and-wait hint
      // whose own short deadline also covers route selection, so a slow or
      // stalled route resolves as no suggestion rather than delaying the
      // composer.
      const totalTimeoutMs = input.role === 'reason'
        ? undefined
        : input.role === 'suggestion'
          ? SUGGESTION_TIMEOUT_MS
          : AUXILIARY_TOTAL_BUDGET_MS;
      const totalTimer = totalTimeoutMs === undefined
        ? undefined
        : setTimeout(() => abort('timeout'), totalTimeoutMs);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = (): void => {
        if (input.role !== 'reason') return;
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort('idle'), REASON_IDLE_TIMEOUT_MS);
      };
      /**
       * Suspend the reason idle deadline for the whole recovery wait. A
       * scheduled wait is activity, not upstream silence, and it can be
       * extended while it runs, so no single delay-based timer is armed. The
       * deadline is re-armed on real request activity or cleared on exit, so a
       * genuinely stalled attempt after the wait is still detected and no
       * periodic fake activity can mask a real upstream hang.
       */
      const suspendIdle = (): void => {
        if (input.role !== 'reason') return;
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };
      resetIdle();

      let outputStarted = false;
      /**
       * Re-arms the in-flight auxiliary attempt's idle/no-progress deadline. It
       * is set while an attempt runs and cleared when it settles, so the
       * streamed-output callbacks below — and the transport's own `activity` and
       * `retry` signals — reset the deadline exactly when a route shows progress.
       */
      let resetAttemptIdle: (() => void) | undefined;
      const onOutput = (): void => { outputStarted = true; resetIdle(); resetAttemptIdle?.(); };
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
          case 'activity': reportWait(null); resetIdle(); resetAttemptIdle?.(); return;
          case 'retry':
            // A plain backoff retry is not a recovery wait: clear any waiting
            // state and treat the wait as activity.
            reportWait(null);
            resetIdle();
            resetAttemptIdle?.();
            return;
          case 'wait':
            // A recovery wait is scheduled, not upstream inactivity: suspend the
            // idle deadline for the whole wait (including any extension) and
            // re-arm it on the next real request activity.
            reportWait({
              reason: event.reason,
              ...(event.retryAt === undefined ? {} : { retryAt: event.retryAt }),
            });
            suspendIdle();
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
        return health?.nextProbeAt ?? health?.until;
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
       * Bounded cross-route failover for one logical auxiliary call: at most
       * three distinct routes, each tried once, inside one total budget and a
       * per-route cap. It never fails over after visible output has begun, on a
       * user cancellation, or on an invalid-request/context/protocol failure,
       * and it never reuses a known-open first route.
       */
      const runAuxiliary = async (): Promise<ModelResult> => {
        const all = routes!;
        const candidates = distinctCandidates(all);
        const deadlineMs = startedAtMs + AUXILIARY_TOTAL_BUDGET_MS;
        // The span records the first candidate that may actually be tried; the
        // list itself is the full ranked set, never pre-truncated. Only a route
        // that could really be called may raise a terminal effort or budget
        // failure: when every candidate is open the all-open feedback below is
        // what the caller needs, so an unavailable route's budget error never
        // replaces it.
        const callable = candidates.find((candidate) => isCallableNow(options.routeStatus?.(candidate.model), startedAtMs));
        const primary = callable ?? candidates[0]!;
        const primaryBudget = checkContextBudget(primary.model, messages, options.resolveProvider, maxTokens);
        estimatedInputTokens = primaryBudget.estimatedInputTokens;
        model = primary.model;
        selectedRank = all.indexOf(primary) + 1;
        const primaryDefault = isProviderDefaultReasoningOnly(primaryBudget.metadata);
        if (callable !== undefined) {
          if (!primaryDefault && !isReasoningEffortSupported(primaryBudget.metadata, primary.reasoningEffort)) {
            const message = `Model ${primary.model} does not support reasoning effort "${primary.reasoningEffort ?? ''}"`;
            return await fail(message, auxiliaryFailure(message, undefined, 'protocol'));
          }
          if (!primaryBudget.ok) {
            const message = `context_overflow: ${primaryBudget.reason}`;
            return await fail(message, auxiliaryFailure(message, undefined, 'context_overflow'));
          }
        }
        actualReasoningEffort = primaryDefault ? PROVIDER_DEFAULT_REASONING : primary.reasoningEffort;
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

        // A cancel can land while the started span is appended; never start a
        // transport request for a call that is already cancelled. A total-budget
        // cut that landed in the same window is a local cut, not a route fault.
        if (controller.signal.aborted) {
          const message = abortMessage(abortKind, totalTimeoutMs);
          return await fail(message, {
            status: abortKind === 'signal' ? 'aborted' : 'failed',
            ...(abortKind === 'timeout' ? { error: localCutFact('budget', message) } : {}),
          });
        }

        let attempted = 0;
        let lastMessage = `Auxiliary role ${input.role}: no candidate route succeeded`;
        let earliestRetry: string | undefined;
        let lastFailure: CallErrorFact | undefined;
        // Local cuts that may have ended the call: the caller's finite total
        // budget and the per-route idle deadline. They are classified as local
        // facts at the terminal failure below, distinct from the upstream
        // `lastFailure` kind, and never touch route health.
        let budgetExhausted = false;
        let idleDeadlineCut = false;
        for (const candidate of candidates) {
          if (controller.signal.aborted) break;
          // Stop once three distinct routes have really been called: a route
          // skipped because it is open or mid-probe never spends an attempt.
          if (attempted >= AUXILIARY_MAX_ROUTES) break;
          const remaining = deadlineMs - Date.now();
          if (remaining <= 0) {
            lastMessage = `Auxiliary budget of ${AUXILIARY_TOTAL_BUDGET_MS} ms exhausted`;
            budgetExhausted = true;
            break;
          }
          const health = options.routeStatus?.(candidate.model);
          // A route whose circuit is open, or whose recovery probe is not yet
          // due — including one another caller is already probing under a lease —
          // cannot be called: the Gateway would only reject it. Record its retry
          // time and try the next candidate.
          if (!isCallableNow(health, Date.now())) {
            earliestRetry = earliest(earliestRetry, health?.nextProbeAt ?? health?.until);
            continue;
          }
          const budget = checkContextBudget(candidate.model, messages, options.resolveProvider, maxTokens);
          const providerDefaultOnly = isProviderDefaultReasoningOnly(budget.metadata);
          if (!providerDefaultOnly && !isReasoningEffortSupported(budget.metadata, candidate.reasoningEffort)) {
            lastMessage = `Model ${candidate.model} does not support reasoning effort "${candidate.reasoningEffort}"`;
            continue;
          }
          if (!budget.ok) {
            const message = `context_overflow: ${budget.reason}`;
            return await fail(message, auxiliaryFailure(message, earliestRetry, 'context_overflow'));
          }
          const effort = providerDefaultOnly ? PROVIDER_DEFAULT_REASONING : candidate.reasoningEffort;
          const requestMaxOutputTokens = budget.requestMaxOutputTokens ?? maxTokens;
          model = candidate.model;
          selectedRank = all.indexOf(candidate) + 1;
          actualReasoningEffort = effort;
          attempted += 1;

          // A fresh id per attempt lets the Gateway tie a client-observed timeout
          // or fetch failure to the exact attempt it already saw.
          const attemptId = randomUUID();
          options.beginRouteAttempt?.(candidate.model, attemptId);
          const attemptController = new AbortController();
          const onMainAbort = (): void => attemptController.abort();
          controller.signal.addEventListener('abort', onMainAbort, { once: true });
          let perRouteTimedOut = false;
          // The per-attempt deadline is idle, not absolute: it is re-armed on
          // every streamed-output or transport-progress signal, so a route that
          // keeps producing tokens runs on while a silent route is aborted.
          let attemptTimer: ReturnType<typeof setTimeout> | undefined;
          const armAttemptIdle = (): void => {
            if (attemptTimer !== undefined) clearTimeout(attemptTimer);
            attemptTimer = setTimeout(() => { perRouteTimedOut = true; attemptController.abort(); }, AUXILIARY_IDLE_TIMEOUT_MS);
          };
          resetAttemptIdle = armAttemptIdle;
          armAttemptIdle();
          try {
            const request: ModelRequest = {
              model: candidate.model,
              messages,
              reasoningEffort: effort,
              attribution: { role: input.role, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) },
              ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
              ...(requestMaxOutputTokens === undefined ? {} : { maxOutputTokens: requestMaxOutputTokens }),
              ...(input.tools === undefined ? {} : { tools: input.tools }),
              ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
              signal: attemptController.signal,
              onEvent,
              // An auxiliary call must not use the same-route retry loop, so a
              // failover cannot multiply attempts on one route.
              noRetry: true,
              attemptId,
            };
            const completed = await settleWithAbort(options.transport.complete(request), attemptController.signal);
            collectAttempts(completed.metrics, retryInstantOf(candidate.model));
            return completed;
          } catch (error) {
            if (error instanceof ModelCallError) throw error;
            const fact = errorFactOf(error);
            // A user cancellation is neutral and final: it never fails over and
            // is never reported as a route fault.
            const cancelled = abortKind === 'signal';
            // The caller's finite total budget cutting the whole call is not a
            // route fault: no route stalled, the call itself ran out of time.
            const callerBudgetExhausted = abortKind === 'timeout';
            // Report the real fault before reading the route's retry instant, so
            // the attempt record carries the `until` this report just wrote, and
            // before stopping failover, so a genuine transport failure after
            // visible output still reaches the route-health authority. Only a
            // genuine network failure blames the route: a local deadline (an
            // idle stall, a role's own deadline or the caller's total budget) is
            // our own decision, not the route's fault, so it never marks the
            // route unhealthy.
            if (!cancelled && !callerBudgetExhausted && !perRouteTimedOut && fact.kind === 'network') {
              options.reportRouteFault?.(candidate.model, attemptId, 'transport');
            }
            const attemptUntil = retryInstantOf(candidate.model);
            if (!cancelled && !callerBudgetExhausted) earliestRetry = earliest(earliestRetry, attemptUntil);
            // Exactly one record per attempt: the transport's own record when it
            // produced one, otherwise a synthetic record of this route's stall.
            const supplied = collectAttempts(metricsOf(error), attemptUntil);
            if (supplied === 0 && perRouteTimedOut && !callerBudgetExhausted) {
              routeAttempts.push({
                error: 'network',
                ms: AUXILIARY_IDLE_TIMEOUT_MS,
                model: candidate.model,
                ...(attemptUntil === undefined ? {} : { routeUntil: attemptUntil }),
              });
            }
            lastFailure = fact;
            // A cancellation or any visible output already produced is final:
            // no further route may be tried.
            if (cancelled || outputStarted) throw error;
            if (perRouteTimedOut) {
              // An idle route stall is a fallback fact, never a terminal aborted
              // state: the route fault is reported and the next candidate tried.
              // If it also ends the call, the terminal fact is the local idle
              // deadline — not the `aborted` its request abort happens to carry.
              lastMessage = `Route ${candidate.model} stalled after ${AUXILIARY_IDLE_TIMEOUT_MS} ms without output`;
              idleDeadlineCut = true;
              continue;
            }
            if (callerBudgetExhausted) {
              lastMessage = abortMessage('timeout', totalTimeoutMs);
              budgetExhausted = true;
              break;
            }
            // A caller-caused or protocol failure is not the route's fault: it is
            // reported once and never fails over.
            if (fact.kind === 'invalid_request' || fact.kind === 'context_overflow' || fact.kind === 'protocol' || fact.kind === 'aborted') throw error;
            // A later upstream fault supersedes an earlier idle stall: the
            // terminal classification is the upstream kind, not the local cut.
            idleDeadlineCut = false;
            lastMessage = withOverflowPrefix(error);
            continue;
          } finally {
            options.completeRouteAttempt?.(candidate.model, attemptId);
            if (attemptTimer !== undefined) clearTimeout(attemptTimer);
            resetAttemptIdle = undefined;
            controller.signal.removeEventListener('abort', onMainAbort);
          }
        }
        if (attempted === 0 && earliestRetry !== undefined) {
          const message = `Auxiliary role ${input.role}: every candidate route is cooling down or probing; earliest retry ${earliestRetry} (${candidates.length} candidate route(s), budget ${AUXILIARY_TOTAL_BUDGET_MS} ms)`;
          return await fail(message, auxiliaryFailure(message, earliestRetry, 'protocol'));
        }
        const message = `${lastMessage} (${attempted} of ${candidates.length} candidate route(s), budget ${AUXILIARY_TOTAL_BUDGET_MS} ms)`;
        // The terminal classification: a local cut this runner made itself — the
        // caller's exhausted budget or the per-route idle deadline — is told
        // apart from every upstream kind, so the span never reports a local cut
        // as `network`, `server` or `aborted`.
        const classification = abortKind === 'timeout' || budgetExhausted
          ? LOCAL_CALL_ERROR.budget
          : idleDeadlineCut
            ? LOCAL_CALL_ERROR.deadline
            : lastFailure?.kind ?? 'protocol';
        return await fail(message, auxiliaryFailure(message, earliestRetry, classification));
      };

      try {
        if (input.role === 'reason') {
          const selection = input.reason;
          if (!selection) return await fail('The reason role requires a model selection');
          model = routeKeyOf(selection.provider, selection.model);
          requestedReasoningEffort = selection.reasoningEffort;
        } else {
          auxiliaryRole = input.role;
          requestedReasoningEffort = ROLE_REQUIREMENTS[input.role].expectedReasoningEffort[0];
          routes = await settleWithAbort(options.selectAuxiliary(input.role), controller.signal);
          if (!routes.length) throw new Error(`Auxiliary role ${input.role}: no candidate qualified (empty route selection)`);
        }
        if (controller.signal.aborted) {
          const message = abortMessage(abortKind, totalTimeoutMs);
          return await fail(message, {
            status: abortKind === 'signal' ? 'aborted' : 'failed',
            ...(abortKind === 'timeout' ? { error: localCutFact('budget', message) } : {}),
          });
        }

        if (input.role === 'reason') {
          // The main reasoning call is explicit and never switches routes.
          const selection = input.reason!;
          const budget = checkContextBudget(model, messages, options.resolveProvider, maxTokens);
          estimatedInputTokens = budget.estimatedInputTokens;
          const requestMaxOutputTokens = budget.requestMaxOutputTokens ?? maxTokens;
          // A route whose whole ladder is the provider-default sentinel has no
          // selectable level: it accepts any requested effort and is sent at its
          // own default. Every other route keeps the exact support check.
          const providerDefaultOnly = isProviderDefaultReasoningOnly(budget.metadata);
          if (!providerDefaultOnly && !isReasoningEffortSupported(budget.metadata, selection.reasoningEffort)) {
            return await fail(`Model ${model} does not support reasoning effort "${selection.reasoningEffort ?? ''}"`);
          }
          actualReasoningEffort = providerDefaultOnly ? PROVIDER_DEFAULT_REASONING : selection.reasoningEffort;
          if (!budget.ok) return await fail(`context_overflow: ${budget.reason}`);
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
          result = await settleWithAbort(options.transport.complete({
            model,
            messages,
            reasoningEffort: actualReasoningEffort,
            // The main reasoning path carries the user's explicit Fast
            // preference, including an explicit false; an absent preference
            // sends no field at all. Auxiliary requests never set it.
            ...(selection.fast === undefined ? {} : { fast: selection.fast }),
            attribution: { role: input.role, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) },
            ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
            ...(requestMaxOutputTokens === undefined ? {} : { maxOutputTokens: requestMaxOutputTokens }),
            ...(input.tools === undefined ? {} : { tools: input.tools }),
            ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
            // The main reasoning route is the user's explicit selection and is
            // never substituted. Its known route health is handed to the
            // transport so a cooling-down route is waited out inside the one
            // retry budget rather than probed early; the Gateway stays the
            // atomic admission authority for races.
            ...(options.routeStatus === undefined
              ? {}
              : { preflight: () => routeNotBeforeMs(options.routeStatus!(model), Date.now()) }),
            signal: controller.signal,
            onEvent,
          }), controller.signal);
        } else {
          result = await runAuxiliary();
        }
      } catch (error) {
        if (error instanceof ModelCallError) throw error;
        const status: 'failed' | 'aborted' = abortKind === 'signal' ? 'aborted' : 'failed';
        const message = abortKind === undefined
          ? withOverflowPrefix(error)
          : abortMessage(abortKind, totalTimeoutMs);
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
        if (totalTimer !== undefined) clearTimeout(totalTimer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
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

      return {
        model,
        text: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        ...(usage === undefined ? {} : { usage }),
        toolCalls: completed.toolCalls,
        ...(completed.finishReason === undefined ? {} : { finishReason: completed.finishReason }),
        metrics,
      };
    },
  };
}
