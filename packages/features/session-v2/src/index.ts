/**
 * session-v2 public surface.
 *
 * This module is the single composition root for the feature. It wires the
 * sibling modules into the engine ports and exposes the frozen `createSessionV2`
 * contract:
 *
 *   ledger.ts     `Ledger` (init/append/read/listSessions/subscribe/close) and
 *                 the `LedgerEvent` union plus the snapshot types.
 *   workspace.ts  `createWorkspaceSnapshot(input)` and `WorkspaceFileSource`.
 *   views.ts      `createViews(documentRules?)`.
 *   calls.ts      `createCallRunner({ driver, cheapModel, append, now })`.
 *   driver.ts     `createGatewayDriver(connection)`.
 *
 * Everything else in the feature depends only on the port interfaces declared
 * in `engine.ts` / `actions.ts`.
 */

import { Ledger } from './ledger.ts';
import { createWorkspaceSnapshot, WorkspaceFileSource, readDocumentRules } from './workspace.ts';
import { createViews } from './views.ts';
import { createCallRunner, type CallRunner } from './calls.ts';
import { createGatewayDriver, type ModelDriver } from './driver.ts';
import {
  createEngine,
  type CallsPort,
  type EnginePorts,
  type SessionV2,
  type SessionV2Host,
} from './engine.ts';

export type {
  ActionBaseContext,
  ActionRunContext,
  BuiltView,
  CallRunRequest,
  CallRunResult,
  CallsPort,
  EnginePorts,
  FilesPort,
  LedgerPort,
  LiveCall,
  ProjectInfo,
  RecallGate,
  RecalledFile,
  SessionV2,
  SessionV2Host,
  SessionViewInfo,
  SnapshotInput,
  SnapshotProjectInput,
  TurnPhase,
  ViewMessage,
  ViewsPort,
} from './engine.ts';
export { MAX_CYCLES } from './engine.ts';
export type {
  ActionExecutionOutcome,
  ActionKind,
  ActionParseResult,
  ActionStatus,
  DocType,
  ParsedAction,
  ParsedDocBlock,
  SchemaValidation,
  SplitActionBlock,
} from './actions.ts';
export { ActionRunner, ActionSplitter, DOC_TYPE_DIRS, parseDocBlock, validateJsonSchema } from './actions.ts';
export type { CallLedgerEventDraft, CallRole, CallStartedEventDraft, ModelCallInput, ModelCallOutput } from './calls.ts';
export { CALL_ROLES, checkContextBudget, estimateTokens, resolveModelMetadata } from './calls.ts';
export type { DriverResult, ModelDriver, ModelMessage, Usage } from './driver.ts';
export { createGatewayDriver } from './driver.ts';
export type {
  ActionBlockEvent,
  ActionFinishedEvent,
  ActionStartedEvent,
  CallEvent,
  CallStartedEvent,
  ContextSelectedEvent,
  DocReadEvent,
  ErrorEvent,
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
  TitleEvent,
  TurnFinishedEvent,
  TurnInterruptedEvent,
  TurnStartedEvent,
  TurnStatus,
  WorkspaceSnapshot,
  WsUpdatedEvent,
} from './ledger.ts';

/** Create the session-v2 feature over a host. */
export function createSessionV2(host: SessionV2Host): SessionV2 {
  const ledger = new Ledger({ stateRoot: host.stateRoot, workspaceRoot: host.workspaceRoot, now: host.now });
  const views = createViews(readDocumentRules(host.workspaceRoot));

  // The call runner is session-scoped because its `append` sink is the only way
  // a `call` event reaches the owning timeline. The gateway is resolved inside
  // `driver.complete`, so acquiring it is covered by the call timeout and its
  // outcome is recorded in the `call` event; a failed lookup is never cached.
  const runners = new Map<string, CallRunner>();
  const calls = (sessionId: string): CallsPort => {
    let runner = runners.get(sessionId);
    if (!runner) {
      const driver: ModelDriver = {
        async complete(request) {
          const connection = await host.gateway();
          return createGatewayDriver(connection).complete(request);
        },
      };
      runner = createCallRunner({
        driver,
        cheapModel: () => host.cheapModel(),
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
  };
  return createEngine(host, ports);
}
