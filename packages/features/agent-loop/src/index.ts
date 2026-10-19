/**
 * `@wrenyard/agent-loop` public surface.
 *
 * The package owns the in-process auxiliary loop (rounds, timeout, tool calls
 * and the `done` contract), the protocol-method tool builder, the span
 * recorder, and every auxiliary definition as data. It depends on nothing but
 * its own port types (plus the routing requirement key vocabulary), so a
 * session, a bot kernel or the CLI can run an auxiliary with its own ledger,
 * model transport and method catalog.
 *
 * Two entry points:
 *   - {@link runAuxiliaryLoop}: the lower-level loop over prebuilt tools;
 *   - {@link runAuxiliary}: the definition-driven runner a host calls.
 */

import { getAuxiliaryDefinition, type AuxiliaryDefinitionId } from './definitions.ts';
import {
  bindCatalog,
  buildAuxiliaryUser,
  protocolTools,
  runAuxiliaryLoop,
  toActionOutcome,
  type LoopDeps,
  type LoopRecord,
} from './loop.ts';
import type {
  ActionExecutionOutcome,
  ActionRunContext,
  CallsPort,
  LoopHelpers,
  MethodCatalogPort,
} from './ports.ts';

export {
  DONE_TOOL,
  bindCatalog,
  buildAuxiliaryUser,
  createLoopRecord,
  errorCodeOf,
  errorResult,
  jsonResult,
  protocolTools,
  recordWorkspaceUpdate,
  runAuxiliaryLoop,
  toActionOutcome,
} from './loop.ts';
export type {
  AuxiliaryLoopOptions,
  AuxiliaryLoopResult,
  LoopDeps,
  LoopRecord,
  LoopRole,
  LoopTool,
  MethodEffect,
  WorkspaceUpdate,
} from './loop.ts';
export {
  AUXILIARY_DEFINITION_IDS,
  AUXILIARY_DEFINITIONS,
  getAuxiliaryDefinition,
} from './definitions.ts';
export type {
  AuxiliaryDefinition,
  AuxiliaryDefinitionId,
  DefinitionPorts,
} from './definitions.ts';
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
  AuxiliaryCallRole,
  CallRole,
  CallRunRequest,
  CallRunResult,
  CallsPort,
  DocumentContentDraft,
  FinishReason,
  LedgerEvent,
  LedgerEventDraft,
  LoopHelpers,
  Message,
  MessageToolCall,
  MethodCallContext,
  MethodCatalogPort,
  MethodInfo,
  ModelAttempt,
  ModelContentPart,
  ModelErrorKind,
  ModelMetrics,
  ModelToolCall,
  ParsedAction,
  ProjectInfo,
  ReasoningEffort,
  RetryAfterHint,
  RetryAfterSource,
  ToolCall,
  ToolCallObservation,
  ToolContractRecord,
  ToolDiagnosis,
  ToolSpec,
  Usage,
  WorkspaceChange,
  WorkspaceChangedDraft,
  WorkspaceSnapshot,
} from './ports.ts';

/**
 * The record a host supplies to {@link runAuxiliary}: the loop's mutable
 * record plus the host's own text/diagnostic helpers and optional hooks.
 */
export interface AuxiliaryRecordPort extends LoopRecord {
  /** The host helpers the loop reuses instead of importing host modules. */
  helpers: LoopHelpers;
}

/** Everything one definition-driven auxiliary run needs from its host. */
export interface AuxiliaryRunnerPorts {
  /** The host's protocol-method catalog, gated by the running definition. */
  catalog: MethodCatalogPort;
  /** The host's model transport and span bookkeeping. */
  calls: CallsPort;
  /** The host's record adapter and helpers. */
  record: AuxiliaryRecordPort;
  /** The action context the auxiliary runs inside. */
  context: ActionRunContext;
  /** The workspace document rules, used by the document definition only. */
  documentRules?: () => string;
}

/**
 * Run one auxiliary definition end to end. The definition supplies the
 * system prompt, the method allowlist, the effect map and the round budget;
 * the host supplies the catalog, the model transport, the record and the
 * action context.
 */
export async function runAuxiliary(
  definitionId: AuxiliaryDefinitionId,
  intent: string,
  ports: AuxiliaryRunnerPorts,
): Promise<ActionExecutionOutcome> {
  const definition = getAuxiliaryDefinition(definitionId);
  if (definition === undefined) {
    throw new Error(`Unknown auxiliary definition: ${definitionId}`);
  }
  const { context, record } = ports;
  const helpers = record.helpers;
  const deps: LoopDeps = {
    host: bindCatalog(ports.catalog, definition.role),
    calls: ports.calls,
    helpers,
  };
  const tools = await protocolTools(
    deps.host,
    helpers,
    context,
    record,
    definition.methods,
    definition.effects,
  );
  const result = await runAuxiliaryLoop({
    deps,
    ctx: context,
    role: definition.role,
    system: definition.buildSystemPrompt({ documentRules: ports.documentRules ?? (() => '') }),
    user: buildAuxiliaryUser(context, intent, helpers),
    tools,
    maxRounds: definition.maxRounds,
    spanIdPrefix: definition.spanIdPrefix,
    record,
  });
  return toActionOutcome(result, record, record.documents);
}
