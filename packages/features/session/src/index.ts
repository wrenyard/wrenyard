/**
 * session public surface.
 *
 * This module is the single composition root for the feature. It wires the
 * sibling modules into the engine ports and exposes the frozen `createSession`
 * contract:
 *
 *   ledger.ts         `Ledger` (init/append/read/listSessions/subscribe/close)
 *                     and the `LedgerEvent` union plus the snapshot types.
 *   workspace.ts      `WorkspaceFileSource` and the document catalogue.
 *   calls.ts          `createCallRunner({ transport, selectAuxiliary, append, now })`.
 *   transport/        `createModelTransport({ gateway })`, the one unified call
 *                     protocol, the three protocol adapters and the sole
 *                     same-route retry.
 *   media.ts          `FileStore` (attachments, artifact description, images).
 *
 * Everything else in the feature depends only on the port interfaces declared
 * in `ports.ts`.
 */

import { Ledger } from './ledger/store.ts';
import { WorkspaceFileSource } from './workspace.ts';
import { createWorkspaceMemory } from './memory-write.ts';
import { createCallRunner, type CallRunner } from './model/request.ts';
import { createModelTransport } from './transport/index.ts';
import { FileStore } from './media.ts';
import { createEngine } from './turn/engine.ts';
import {
  type CallsPort,
  type EnginePorts,
  type Session,
  type SessionHost,
} from './ports.ts';

export type {
  ActionBaseContext,
  AgentToolPort,
  BuiltView,
  CallFailureSummary,
  CallRunRequest,
  CallRunResult,
  CallsPort,
  EnginePorts,
  FilesPort,
  LedgerPort,
  LiveCall,
  ProjectInfo,
  RecalledFile,
  Session,
  SessionHost,
  SessionViewInfo,
  SnapshotInput,
  SnapshotProjectInput,
  TurnPhase,
  ViewMessage,
  WorkspaceMemoryPort,
} from './ports.ts';
export type { CompileViewInput } from './auxiliary/dispatch.ts';
export type { DocSearchViewInput } from './auxiliary/search.ts';
export type { MemorySearchViewInput } from './auxiliary/memory.ts';
export type { ReasonViewInput } from './reasoning/prompt.ts';
export type { ReplyViewInput } from './auxiliary/reply.ts';
export type { TitleViewInput } from './auxiliary/title.ts';
export { fallbackReply } from './auxiliary/reply.ts';
export type {
  ActionExecutionOutcome,
  ActionRunContext,
  ParsedAction,
} from './reasoning/actions.ts';
export { ActionRunner } from './reasoning/actions.ts';
export type { SchemaValidation } from './auxiliary/dispatch.ts';
export { validateJsonSchema } from './auxiliary/dispatch.ts';
export type { AuxiliaryRoute, CallErrorFact, CallRole, ModelCallInput, ModelCallOutput, SpanEventDraft } from './model/request.ts';
export {
  CALL_ROLES,
  AUXILIARY_TIMEOUT_MS,
  IMAGE_INPUT_TOKEN_ESTIMATE,
  checkContextBudget,
  estimateContentTokens,
  estimateInputTokens,
  estimateTokens,
  isReasoningEffortSupported,
  resolveModelMetadata,
  sanitizeMessagesForRole,
} from './model/request.ts';
export type { AuxiliaryCallRole, RoleReasoningRequirement } from './model/roles.ts';
export { AUXILIARY_ROLE_ORDER } from './model/roles.ts';
export type { AuxiliaryRoutePreview } from './model/roles.ts';
export type { AttachmentInput, SessionFile, TaskArtifact } from './media.ts';
export { FileStore, MEDIA_LIMITS } from './media.ts';
export type { DocCatalogEntry } from './workspace.ts';
export type {
  ContextInspectCalibration,
  ContextInspectFiles,
  ContextInspectModel,
  ContextInspectRequest,
  ContextInspection,
  ContextItem,
  ContextItemKind,
  ContextLayerId,
  ContextLayerTokens,
} from './context/inspect.ts';
export { ContextInspector } from './context/inspect.ts';
export type {
  FinishReason,
  Message,
  MessageToolCall,
  ModelAttempt,
  ModelContentPart,
  ModelErrorKind,
  ModelEvent,
  ModelRequest,
  ModelMetrics,
  ModelResult,
  ModelToolCall,
  ModelTransport,
  ToolCall,
  ToolChoice,
  ToolSpec,
  Usage,
} from './transport/index.ts';
export {
  BASE_DELAY_MS,
  CHAT_REQUEST_MAX_BYTES,
  GATEWAY_REQUEST_MAX_BYTES,
  MAX_RETRIES,
  MESSAGES_REQUEST_MAX_BYTES,
  ModelError,
  RESPONSES_REQUEST_MAX_BYTES,
  SESSION_PROTOCOLS,
  abortError,
  adapterForProtocol,
  classifyStatus,
  createModelTransport,
  isContextOverflowError,
  isModelError,
  isQuotaCode,
  isRetryable,
  normalizeStreamError,
  retryDelayMs,
  type GatewayConnectionSource,
  type ModelTransportOptions,
  type SessionProtocol,
} from './transport/index.ts';
// The pure protocol-selection helpers come from the browser-safe protocol
// module, so exporting them never pulls the Node transport in with them.
export { selectSessionProtocol, supportsSession } from './transport/protocol.ts';
export { ACTION_TOOL } from './reasoning/tool.ts';
export { REPLY_TOOL } from './auxiliary/reply.ts';
export type {
  ActionFinishedEvent,
  ActionStartedEvent,
  ActionStatus,
  ActionTitledEvent,
  ActionType,
  DocPick,
  DocumentContentEvent,
  DocumentFoundEvent,
  FilesAttachedEvent,
  LedgerEvent,
  LedgerEventBase,
  LedgerEventDraft,
  LedgerEventType,
  MemoryRecalledEvent,
  ModelSpanFinishedEvent,
  ModelSpanRequest,
  ModelSpanStartedEvent,
  ProjectSnapshot,
  ReasoningCompletedEvent,
  ReasoningThinkingEvent,
  SessionCreatedEvent,
  SessionSummary,
  SpanContextEvent,
  SpanError,
  SpanFinishedEvent,
  SpanKind,
  SpanStartedEvent,
  SpanStatus,
  StepFinishedEvent,
  StepStartedEvent,
  StepStatus,
  SystemNoticeEvent,
  ReplySentEvent,
  SessionTitledEvent,
  TaskBrief,
  TaskSpanFinishedEvent,
  TaskSpanMetrics,
  TaskSpanRequest,
  TaskSpanStartedEvent,
  TurnFinishedEvent,
  TurnInterruptedEvent,
  TurnModel,
  TurnStartedEvent,
  TurnStatus,
  WorkspaceChangedEvent,
  WorkspaceSnapshot,
} from './ledger/store.ts';
export { REPLY_FALLBACK_SOURCES, collectSessionFiles, stepId, turnId } from './ledger/store.ts';
import { SpanRecorder } from './loop/span.ts';

/** Create the session feature over a host. */
export function createSession(host: SessionHost): Session {
  const ledger = new Ledger({ stateRoot: host.stateRoot, workspaceRoot: host.workspaceRoot, now: host.now });

  // The request executor is session-scoped: it reports every request to the
  // session's span recorder, the only way a span reaches the owning timeline. The gateway is resolved inside
  // the transport, so acquiring it is covered by the call timeout and its
  // outcome is recorded in the `call` event; a failed lookup is never cached.
  const runners = new Map<string, CallsPort>();
  const calls = (sessionId: string): CallsPort => {
    let runner = runners.get(sessionId);
    if (!runner) {
      const recorder = new SpanRecorder((draft) => ledger.append(sessionId, draft).then(() => undefined));
      const executor = createCallRunner({
        transport: createModelTransport({ gateway: () => host.gateway() }),
        selectAuxiliary: role => host.selectAuxiliary(role),
        ...(host.routeStatus === undefined ? {} : { routeStatus: (model: string) => host.routeStatus!(model) }),
        // Attempt-level route feedback is forwarded only when the host supplies
        // it; a host without it keeps the prior behaviour unchanged.
        ...(host.beginRouteAttempt === undefined ? {} : {
          beginRouteAttempt: (publicModel: string, attemptId: string) => host.beginRouteAttempt!(publicModel, attemptId),
        }),
        ...(host.reportRouteFault === undefined ? {} : {
          reportRouteFault: (publicModel: string, attemptId: string, kind: 'timeout' | 'transport') =>
            host.reportRouteFault!(publicModel, attemptId, kind),
        }),
        ...(host.completeRouteAttempt === undefined ? {} : {
          completeRouteAttempt: (publicModel: string, attemptId: string) => host.completeRouteAttempt!(publicModel, attemptId),
        }),
        resolveProvider: (id) => host.resolveInferenceProvider(id),
        cacheKey: sessionId,
        sessionId,
        append: recorder.report,
        ...(host.now === undefined ? {} : { now: () => host.now!() }),
      });
      runner = {
        run: (input) => executor.run(input),
        holdSpan: (spanId) => recorder.hold(spanId),
        releaseSpan: (spanId, status) => recorder.release(spanId, status),
      };
      runners.set(sessionId, runner);
    }
    return runner;
  };

  const ports: EnginePorts = {
    ledger,
    memory: createWorkspaceMemory(host.workspaceRoot),
    files: (_snapshot, workspaceRoot) => new WorkspaceFileSource({ workspaceRoot }),
    calls,
    fileStore: new FileStore({ stateRoot: host.stateRoot }),
  };
  return createEngine(host, ports);
}
