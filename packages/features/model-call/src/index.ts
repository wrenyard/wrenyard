/**
 * Shared model-call layer above the local Gateway.
 *
 * Dependency direction: session, task-output compilation and future internal
 * agent-loop backends consume this package; it depends only on the provider
 * catalog, the model registry, metrics and protocol contracts — never on
 * session, task, agent-loop or daemon code. The Gateway does not depend on
 * this package.
 */
export * from './transport/index.ts';
export {
  CONTEXT_OUTPUT_RESERVATION_CAP,
  boundedOutputReservation,
  resolveModelMetadata,
  SESSION_PROTOCOLS,
  selectSessionProtocol,
  supportsSession,
  type ModelMetadata,
  type SessionProtocol,
} from './metadata.ts';
export {
  IMAGE_INPUT_TOKEN_ESTIMATE,
  checkContextBudget,
  contextBudgetOf,
  estimateContentTokens,
  estimateInputTokens,
  estimateTokens,
  isProviderDefaultReasoningOnly,
  isReasoningEffortSupported,
  type ContextBudget,
  type ContextBudgetFacts,
} from './budget.ts';
export {
  callModelAttempt,
  settleWithAbort,
  type ModelCallAttemptInput,
  type ModelCallAttemptResult,
} from './call.ts';
