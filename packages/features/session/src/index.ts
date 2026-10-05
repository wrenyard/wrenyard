/**
 * session public surface.
 *
 * This module is the single composition root for the feature. It wires the
 * sibling modules into the engine ports and exposes the frozen `createSession`
 * contract:
 *
 *   ledger.ts     `Ledger` (init/append/read/listSessions/subscribe/close) and
 *                 the `LedgerEvent` union plus the snapshot types.
 *   workspace.ts  `createWorkspaceSnapshot(input)`, `WorkspaceFileSource` and
 *                 the document catalogue.
 *   views.ts      `createViews()`.
 *   calls.ts      `createCallRunner({ driver, cheapModel, append, now })`.
 *   inference.ts  `createInferenceDriver(gateway)`, the one main/auxiliary
 *                 runtime selection site over the shared inference-mode policy.
 *   driver.ts     `createGatewayDriver(connection)` (chat adapter).
 *   responses-driver.ts `createResponsesDriver(connection)` (Responses adapter).
 *   media.ts      `FileStore` (attachments, artifact description, images).
 *
 * Everything else in the feature depends only on the port interfaces declared
 * in `engine.ts` / `actions.ts`.
 */

import { Ledger } from './ledger.ts';
import { createWorkspaceSnapshot, WorkspaceFileSource } from './workspace.ts';
import { createViews } from './views.ts';
import { createCallRunner, type CallRunner } from './calls.ts';
import { createInferenceDriver } from './inference.ts';
import { FileStore } from './media.ts';
import {
  createEngine,
  type CallsPort,
  type EnginePorts,
  type Session,
  type SessionHost,
} from './engine.ts';

export type {
  ActionBaseContext,
  BuiltView,
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
  ViewsPort,
} from './engine.ts';
export type {
  CompileViewInput,
  DocSearchViewInput,
  MemorySearchViewInput,
  ReasonViewInput,
  ReplyViewInput,
  TitleViewInput,
} from './engine.ts';
export { fallbackReply } from './engine.ts';
export type {
  ActionExecutionOutcome,
  ActionKind,
  ActionRunContext,
  ActionStatus,
  ParsedAction,
  SchemaValidation,
} from './actions.ts';
export {
  ActionRunner,
  actionFromToolCall,
  validateJsonSchema,
} from './actions.ts';
export type { CallLedgerEventDraft, CallRole, CallStartedEventDraft, ModelCallInput, ModelCallOutput } from './calls.ts';
export {
  CALL_ROLES,
  IMAGE_INPUT_TOKEN_ESTIMATE,
  checkContextBudget,
  estimateContentTokens,
  estimateInputTokens,
  estimateTokens,
  resolveModelMetadata,
  sanitizeMessagesForRole,
} from './calls.ts';
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
  DriverResult,
  GatewayRequestFields,
  ModelContentPart,
  ModelDriver,
  ModelMessage,
  ToolCall,
  Usage,
} from './driver.ts';
export {
  ACTION_TOOL,
  GATEWAY_REQUEST_MAX_BYTES,
  createGatewayDriver,
  serializeGatewayRequest,
} from './driver.ts';
export type { GatewayConnectionSource, InferenceDriverOptions } from './inference.ts';
export { createInferenceDriver } from './inference.ts';
export { selectInferenceMode } from './inference-mode.ts';
export type { ResponsesDriverOptions, ResponsesRequestFields } from './responses-driver.ts';
export {
  RESPONSES_REQUEST_MAX_BYTES,
  createResponsesDriver,
  serializeResponsesRequest,
} from './responses-driver.ts';
export type { SummarySettingsOption, SummarySettingsSnapshot } from './summary-model.ts';
export {
  DEFAULT_SUMMARY_CANONICAL_MODEL,
  buildSummarySettingsSnapshot,
  readSummaryModel,
  saveSummaryModel,
} from './summary-model.ts';
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
export { CURRENT_SESSION_FORMAT, collectSessionFiles } from './ledger.ts';

/** Create the session feature over a host. */
export function createSession(host: SessionHost): Session {
  const ledger = new Ledger({ stateRoot: host.stateRoot, workspaceRoot: host.workspaceRoot, now: host.now });
  const views = createViews();

  // The call runner is session-scoped because its `append` sink is the only way
  // a `call` event reaches the owning timeline. The gateway is resolved inside
  // `createInferenceDriver`, so acquiring it is covered by the call timeout and
  // its outcome is recorded in the `call` event; a failed lookup is never cached.
  const runners = new Map<string, CallRunner>();
  const calls = (sessionId: string): CallsPort => {
    let runner = runners.get(sessionId);
    if (!runner) {
      runner = createCallRunner({
        driver: createInferenceDriver(() => host.gateway(), {
          resolveProvider: (providerId) => host.resolveInferenceProvider(providerId),
        }),
        cheapModel: () => host.cheapModel(),
        cacheKey: sessionId,
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
    createSnapshot: (input) => createWorkspaceSnapshot(input),
    files: (snapshot, workspaceRoot) => new WorkspaceFileSource({ workspaceRoot, snapshot }),
    views,
    calls,
    fileStore: new FileStore({ stateRoot: host.stateRoot }),
  };
  return createEngine(host, ports);
}
