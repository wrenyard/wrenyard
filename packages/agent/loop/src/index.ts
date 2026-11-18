/** Shared loop mechanics; session definitions and task-output policy live with their owners. */
export { runAgentLoop } from './agent-loop.ts';
export {
  bindCatalog,
  buildAuxiliaryUser,
  createLoopRecord,
  errorResult,
  keepNewestWithinBudget,
  protocolTools,
  runAuxiliaryLoop,
  toActionOutcome,
} from './auxiliary-loop.ts';
export type {
  AuxiliaryLoopOptions,
  AuxiliaryLoopResult,
  LoopDeps,
  LoopRecord,
  LoopRole,
  LoopTool,
  MethodEffect,
} from './auxiliary-loop.ts';
export { SpanRecorder } from './span.ts';
export type {
  ModelSpanDraft,
  ModelSpanFinishedDraft,
  ModelSpanRequest,
  ModelSpanStartedDraft,
  SpanContextDraft,
  SpanError,
  SpanKind,
  SpanRoute,
  SpanStatus,
} from './span.ts';
export type {
  ActionExecutionOutcome,
  ActionRunContext,
  AgentLoopModelStepOutcome,
  AgentLoopStepOutcome,
  AgentLoopStepStatus,
  CallRunRequest,
  CallRunResult,
  CallsPort,
  LoopHelpers,
  Message,
  MethodCatalogPort,
  MethodInfo,
  RunAgentLoopOptions,
  ToolCall,
  ToolChoice,
  ToolSpec,
} from './types.ts';
