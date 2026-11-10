/** Shared loop mechanics; session definitions and task-output policy live with their owners. */
export {
  bindCatalog,
  buildAuxiliaryUser,
  createLoopRecord,
  errorResult,
  keepNewestWithinBudget,
  protocolTools,
  runAuxiliaryLoop,
  toActionOutcome,
} from './loop.ts';
export type {
  AuxiliaryLoopOptions,
  AuxiliaryLoopResult,
  LoopDeps,
  LoopRecord,
  LoopTool,
  MethodEffect,
} from './loop.ts';
export { SpanRecorder } from './span.ts';
export type {
  ActionExecutionOutcome,
  ActionRunContext,
  CallRunRequest,
  CallRunResult,
  CallsPort,
  LoopHelpers,
  Message,
  MethodCatalogPort,
  MethodInfo,
  ToolCall,
  ToolChoice,
  ToolSpec,
} from './ports.ts';
