/**
 * Browser-safe model metadata entry.
 *
 * The narrow `@wrenyard/model-call/metadata` subpath: it exposes the pure
 * `resolveModelMetadata` helper together with the per-model protocol-selection
 * helpers, without importing the Node transport/HTTP graph. A consumer such as
 * Desktop's metadata-only bundle resolves a model's protocols through it
 * without dragging the Node transport in.
 */
import type { GatewayModel } from '@wrenyard/protocol/gateway';
import type { ReasoningEffort } from '@wrenyard/models';

export { SESSION_PROTOCOLS, selectSessionProtocol, supportsSession } from './transport/protocol.ts';
export type { SessionProtocol } from './transport/protocol.ts';

/** Model facts used by the budget check and by the `<wy-info>` view. */
export interface ModelMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Reasoning levels the endpoint lists for this exact model. */
  reasoningEfforts?: readonly ReasoningEffort[];
  /** True only when the endpoint lists the `image` input capability. */
  imageInput?: boolean;
}

export { CONTEXT_OUTPUT_RESERVATION_CAP, boundedOutputReservation } from '@wrenyard/models';

/** Pi 1.5.0's output cap when neither the endpoint nor the registry defines one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Model metadata for one `provider/model` public id, read only from the
 * endpoint's model list. A model the endpoint does not list has no metadata;
 * fields the listing omits stay undefined, except the output cap, which falls
 * back to the client default so the window check and compaction still run.
 */
export function resolveModelMetadata(publicId: string, models: readonly GatewayModel[]): ModelMetadata {
  const definition = models.find((entry) => entry.publicId === publicId);
  if (definition === undefined) return {};
  const contextWindow = definition.contextWindow;
  const maxOutputTokens = definition.maxOutputTokens ?? definition.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const reasoningEfforts = definition.reasoningEfforts;
  const imageInput = definition.capabilities?.some((capability) => capability === 'image');
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(imageInput === undefined ? {} : { imageInput }),
  };
}
