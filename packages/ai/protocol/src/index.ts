/** Browser-safe shared AI facts and gateway connection contracts. */
export type {
  FinishReason,
  ModelAttempt,
  ModelErrorKind,
  ModelMetrics,
  RetryAfterHint,
  RetryAfterSource,
  Usage,
} from './facts.ts';
export type {
  GatewayConnection,
  GatewayModel,
  GatewayModelPricing,
  GatewayProtocol,
} from './gateway.ts';
