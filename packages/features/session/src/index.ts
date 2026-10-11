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

import { Ledger } from './ledger.ts';
import { WorkspaceFileSource } from './workspace.ts';
import { createCallRunner, type CallRunner } from './calls.ts';
import { createModelTransport } from './transport/index.ts';
import { FileStore } from './media.ts';
import { createEngine } from './engine.ts';
import {
  type CallsPort,
  type EnginePorts,
  type Session,
  type SessionHost,
} from './ports.ts';

export type {
  ActionBaseContext,
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
} from './ports.ts';
export type { CompileViewInput } from './actions/dispatch/dispatch.ts';
export type { DocSearchViewInput } from './actions/secondary/search.ts';
export type { MemorySearchViewInput } from './actions/secondary/memory.ts';
export type { ReasonViewInput } from './actions/reason/prompt.ts';
export type { ReplyViewInput } from './actions/secondary/reply.ts';
export type { TitleViewInput } from './actions/secondary/title.ts';
export { fallbackReply } from './actions/secondary/reply.ts';
export type {
  ActionExecutionOutcome,
  ActionKind,
  ActionRunContext,
  ActionStatus,
  ParsedAction,
} from './actions/index.ts';
export { ActionRunner } from './actions/index.ts';
export type { SchemaValidation } from './actions/dispatch/dispatch.ts';
export { validateJsonSchema } from './actions/dispatch/dispatch.ts';
export type { AuxiliaryRoute, CallErrorFact, CallLedgerEventDraft, CallRetry, CallRole, CallStartedEventDraft, ModelCallInput, ModelCallOutput } from './calls.ts';
export {
  CALL_ROLES,
  CHEAP_TIMEOUT_MS,
  IMAGE_INPUT_TOKEN_ESTIMATE,
  checkContextBudget,
  estimateContentTokens,
  estimateInputTokens,
  estimateTokens,
  isReasoningEffortSupported,
  resolveModelMetadata,
  sanitizeMessagesForRole,
} from './calls.ts';
export type { AuxiliaryCallRole, RoleReasoningRequirement } from './role-requirements.ts';
export { AUXILIARY_ROLE_ORDER, ROLE_REQUIREMENTS } from './role-requirements.ts';
export type { AuxiliaryRoutePreview } from './role-requirements.ts';
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
} from './context-inspect.ts';
export { ContextInspector } from './context-inspect.ts';
export type {
  FinishReason,
  Message,
  MessageToolCall,
  ModelAttempts,
  ModelContentPart,
  ModelErrorKind,
  ModelEvent,
  ModelRequest,
  ModelResult,
  ModelToolCall,
  ModelTransport,
  ToolCall,
  ToolChoice,
  ToolSpec,
  TpsSample,
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
export { ACTION_TOOL } from './actions/reason/tool.ts';
export { REPLY_TOOL } from './actions/secondary/reply.ts';
export type {
  ActionFinishedEvent,
  ActionStartedEvent,
  ActionTitledEvent,
  CallEvent,
  CallStartedEvent,
  DocContentEvent,
  DocPick,
  DocSearchEvent,
  ErrorEvent,
  FilesEvent,
  LedgerEvent,
  LedgerEventBase,
  LedgerEventDraft,
  LedgerEventType,
  MemoryRecalledEvent,
  ProjectSnapshot,
  ReasonCompletedEvent,
  ReplyEvent,
  SessionCreatedEvent,
  SessionSummary,
  TaskBrief,
  ThinkingEvent,
  TitleEvent,
  TurnFinishedEvent,
  TurnInterruptedEvent,
  TurnStartedEvent,
  TurnStatus,
  WorkspaceSnapshot,
  WsUpdatedEvent,
} from './ledger.ts';
export { collectSessionFiles } from './ledger.ts';

/** Create the session feature over a host. */
export function createSession(host: SessionHost): Session {
  const ledger = new Ledger({ stateRoot: host.stateRoot, workspaceRoot: host.workspaceRoot, now: host.now });

  // The call runner is session-scoped because its `append` sink is the only way
  // a `call` event reaches the owning timeline. The gateway is resolved inside
  // the transport, so acquiring it is covered by the call timeout and its
  // outcome is recorded in the `call` event; a failed lookup is never cached.
  const runners = new Map<string, CallRunner>();
  const calls = (sessionId: string): CallsPort => {
    let runner = runners.get(sessionId);
    if (!runner) {
      runner = createCallRunner({
        transport: createModelTransport({ gateway: () => host.gateway() }),
        selectAuxiliary: role => host.selectAuxiliary(role),
        ...(host.routeStatus === undefined ? {} : { routeStatus: (model: string) => host.routeStatus!(model) }),
        resolveProvider: (id) => host.resolveInferenceProvider(id),
        cacheKey: sessionId,
        sessionId,
        append: async (event) => {
          await ledger.append(sessionId, event);
        },
        ...(host.now === undefined ? {} : { now: () => host.now!() }),
      });
      runners.set(sessionId, runner);
    }
    return runner;
  };

  const ports: EnginePorts = {
    ledger,
    files: (_snapshot, workspaceRoot) => new WorkspaceFileSource({ workspaceRoot }),
    calls,
    fileStore: new FileStore({ stateRoot: host.stateRoot }),
  };
  return createEngine(host, ports);
}
