/**
 * Shared token estimation and context-budget calculation.
 *
 * These helpers are business-neutral: they estimate one request's input with
 * `o200k_base`, apply the shared output-reservation cap, and decide whether the
 * request fits the model's context window. Caller policy — which roles may
 * carry images, per-role output caps, compaction thresholds — stays with the
 * caller: the compaction threshold cap is supplied as `compactionThresholdCap`
 * rather than fixed here.
 */
import o200k_base from 'gpt-tokenizer/encoding/o200k_base';
import type { ProviderDefinition } from '@wrenyard/providers/base';
import { PROVIDER_DEFAULT_REASONING, type ReasoningEffort } from '@wrenyard/models';
import { boundedOutputReservation, resolveModelMetadata, type ModelMetadata } from './metadata.ts';
import type { Message, ModelContentPart } from './transport/index.ts';

let tokenizer: typeof o200k_base | undefined;

/** Fallback per-image input-token estimate when only a data URL is available. */
export const IMAGE_INPUT_TOKEN_ESTIMATE = 1_200;

/** `o200k_base` token count estimate of one text. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  tokenizer ??= o200k_base;
  return tokenizer.encode(text, { allowedSpecial: new Set(), disallowedSpecial: new Set() }).length;
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
export function estimateInputTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.role) + estimateContentTokens(message.content);
  return total;
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
 * budget semantics: the per-call cap is reserved verbatim (never raised above
 * the source maximum) and, with none, the source maximum is reserved exactly as
 * before.
 */
export function checkContextBudget(
  publicId: string,
  messages: readonly Message[],
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
 * which a request compacts before sending: the lower of half the room left
 * after the output reservation and the caller-supplied
 * `compactionThresholdCap`; the cap is caller policy, so a caller without a
 * compaction threshold simply omits it.
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
  messages: readonly Message[],
  resolveProvider?: (providerId: string) => ProviderDefinition | undefined,
  requestedMaxOutputTokens?: number,
  compactionThresholdCap?: number,
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
    : Math.min(Math.floor(0.5 * (contextWindow - outputReservation)), compactionThresholdCap ?? Number.MAX_SAFE_INTEGER);
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
