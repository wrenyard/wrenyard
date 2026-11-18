/** AI invocation entry; specialized, browser-safe surfaces use explicit subpaths. */
export { createModelTransport, type ModelTransportOptions, type Message } from './transport/index.ts';
export {
  IMAGE_INPUT_TOKEN_ESTIMATE,
  checkContextBudget,
  contextBudgetOf,
  estimateInputTokens,
  estimateTokens,
  hasSelectableReasoningEfforts,
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
export {
  AUXILIARY_FIRST_RESPONSE_TIMEOUT_SEC,
  COMPACTION_THRESHOLD_CAP,
  ModelCallError,
  SUGGESTION_MAX_TOKENS,
  admitSessionModel,
  compactionBudgetOf,
  createCallRunner,
  sanitizeMessagesForRole,
  type AuxiliaryRoute,
  type CallErrorFact,
  type CallRunner,
  type CallRunnerOptions,
  type ModelCallInput,
  type ModelCallOutput,
  type ModelSpanFinishedDraft,
  type ModelSpanStartedDraft,
  type ReasonSelection,
  type ReasoningRetryPolicy,
  type SpanEventDraft,
} from './runner.ts';
