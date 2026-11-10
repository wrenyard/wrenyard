/**
 * Browser-safe model metadata entry.
 *
 * The narrow `@wrenyard/ai/metadata` subpath: it exposes the pure
 * `resolveModelMetadata` helper together with the per-model protocol-selection
 * helpers, without importing the Node transport/HTTP graph. A consumer such as
 * Desktop's metadata-only bundle resolves a model's protocols through it
 * without dragging the Node transport in.
 */
import type { GatewayModel } from '@wrenyard/ai-protocol';
import type { ReasoningEffort } from '@wrenyard/models';

export { selectSessionProtocol } from '@wrenyard/ai-protocol/protocol';

/** Model facts used by the budget check and by the `<wy-info>` view. */
export interface ModelMetadata {
  contextWindow?: number;
  /** Maximum input tokens the route accepts. */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Reasoning levels the endpoint lists for this exact model. */
  reasoningEfforts?: readonly ReasoningEffort[];
  /** Full input modalities the route accepts. */
  inputModalities?: readonly string[];
  /** True only when the endpoint lists the `image` input capability. */
  imageInput?: boolean;
}

export { boundedOutputReservation } from '@wrenyard/models';

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
  const maxInputTokens = definition.maxInputTokens;
  const maxOutputTokens = definition.maxOutputTokens ?? definition.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const reasoningEfforts = definition.reasoningEfforts;
  const inputModalities = definition.inputModalities;
  const imageInput = definition.capabilities?.some((capability) => capability === 'image');
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(imageInput === undefined ? {} : { imageInput }),
  };
}
