/**
 * Single-attempt model call.
 *
 * Session, task-output compilation and future internal agent-loop backends all
 * consume this package: one business-neutral invocation above the transport,
 * given an already selected `provider/model` route and reasoning effort. It
 * resolves the context budget (or accepts a budget the caller already
 * validated), resolves the sent effort (a provider-default-only route
 * materializes no explicit level), issues exactly one {@link ModelTransport.complete}
 * and returns the result with the facts the caller needs for its own accounting.
 *
 * Session-specific policy stays in session: retries, route switching, role
 * cleanup, and ledger/span recording live there, not here. What this layer
 * deliberately does not do: it never selects a route, retries, backs off,
 * switches candidates, strips image content by role, applies a caller's
 * output-cap policy, starts or finishes any span/record, or persists anything.
 * The role in `attribution.role` is an opaque label forwarded to the Gateway for
 * attribution and never drives behaviour here.
 */
import type { ProviderDefinition } from '@wrenyard/providers/base';
import { PROVIDER_DEFAULT_REASONING, type ReasoningEffort } from '@wrenyard/models';
import { checkContextBudget, isProviderDefaultReasoningOnly, type ContextBudget } from './budget.ts';
import {
  abortError,
  ModelError,
  type Message,
  type ModelAttribution,
  type ModelEvent,
  type ModelPreflightResult,
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  type ToolChoice,
  type ToolSpec,
} from './transport/index.ts';

export interface ModelCallAttemptInput {
  /** The one unified transport the attempt calls. */
  transport: ModelTransport;
  /** Provider-scoped route key `provider/model`, already selected by the caller. */
  model: string;
  /** The effort the caller requests; a provider-default-only route accepts any level. */
  reasoningEffort: ReasoningEffort;
  messages: readonly Message[];
  /** Explicit Fast preference forwarded verbatim; absent sends no field. */
  fast?: boolean;
  /** Per-call output cap the caller asks for before budget resolution. */
  maxOutputTokens?: number;
  tools?: readonly ToolSpec[];
  toolChoice?: ToolChoice;
  /** Opaque attribution label forwarded as Gateway headers; never interpreted. */
  attribution?: ModelAttribution;
  /** Request cache key forwarded verbatim. */
  cacheKey?: string;
  /** Caller-supplied first-response timeout (seconds); absent uses the Gateway default. */
  firstResponseTimeoutSec?: number;
  /** Optional route-admission pre-check the transport waits out before the send. */
  preflight?: () => ModelPreflightResult | undefined;
  /** Gateway-only attempt correlation id forwarded verbatim. */
  attemptId?: string;
  /**
   * Cancellation signal for the attempt. The transport call is raced against
   * it and settles promptly even while the transport is still awaiting the
   * lazy gateway lookup, route admission or a stalled stream.
   */
  signal: AbortSignal;
  onEvent?: (event: ModelEvent) => void;
  resolveProvider?: (providerId: string) => ProviderDefinition | undefined;
  /**
   * A budget the caller already resolved for this exact model and messages.
   * Supplying it skips the check inside the attempt, so a caller that needs the
   * facts before invoking (for example to start a span) does not pay for the
   * estimation twice.
   */
  budget?: ContextBudget;
}

export interface ModelCallAttemptResult {
  /** The completed transport result, including its measured metrics. */
  result: ModelResult;
  /** The resolved budget of the attempt (the supplied one when provided). */
  budget: ContextBudget;
  /** The effort actually sent; `PROVIDER_DEFAULT_REASONING` when the route offers no selectable level. */
  sentEffort: ReasoningEffort;
  /** The output cap forwarded on the request, when one was set. */
  requestMaxOutputTokens?: number;
}

/**
 * Issue one model call on one already selected route.
 *
 * Refuses locally with a `context_overflow` {@link ModelError} when the
 * request cannot fit the model's window, without contacting the Gateway. Every
 * other transport failure propagates unchanged, preserving its classified
 * kind, partial metrics and cancellation identity.
 */
export async function callModelAttempt(input: ModelCallAttemptInput): Promise<ModelCallAttemptResult> {
  const budget = input.budget ?? checkContextBudget(input.model, input.messages, input.resolveProvider, input.maxOutputTokens);
  if (!budget.ok) {
    throw new ModelError(`context_overflow: ${budget.reason ?? 'context budget exceeded'}`, { kind: 'context_overflow' });
  }
  const sentEffort = isProviderDefaultReasoningOnly(budget.metadata)
    ? PROVIDER_DEFAULT_REASONING
    : input.reasoningEffort;
  const requestMaxOutputTokens = budget.requestMaxOutputTokens ?? input.maxOutputTokens;
  const request: ModelRequest = {
    model: input.model,
    messages: input.messages,
    reasoningEffort: sentEffort,
    ...(input.fast === undefined ? {} : { fast: input.fast }),
    ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
    ...(requestMaxOutputTokens === undefined ? {} : { maxOutputTokens: requestMaxOutputTokens }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
    ...(input.firstResponseTimeoutSec === undefined ? {} : { firstResponseTimeoutSec: input.firstResponseTimeoutSec }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
    signal: input.signal,
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  };
  const result = await settleWithAbort(input.transport.complete(request), input.signal);
  return {
    result,
    budget,
    sentEffort,
    ...(requestMaxOutputTokens === undefined ? {} : { requestMaxOutputTokens }),
  };
}

/** Reject promptly when the signal aborts, even while awaiting a plain promise. */
export function settleWithAbort<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
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
