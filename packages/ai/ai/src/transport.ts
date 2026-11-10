/** Public model transport contract; adapter internals stay in the protocol package. */
export { createModelTransport, type GatewayConnectionSource, type ModelTransportOptions } from './transport/index.ts';
export {
  ModelError,
  abortError,
  isContextOverflowError,
  isModelError,
  type ModelErrorKind,
  type UpstreamErrorIdentity,
} from '@wrenyard/ai-protocol/errors';
export {
  record,
  stringField,
  type FinishReason,
  type Message,
  type ModelAttempt,
  type ModelContentPart,
  type ModelEvent,
  type ModelMetrics,
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  type ModelWaitReason,
  type ToolCall,
  type ToolChoice,
  type ToolSpec,
  type Usage,
} from '@wrenyard/ai-protocol/protocol';
