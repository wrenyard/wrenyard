/**
 * Session public surface: the composition root.
 *
 * This module exports only what hosts consume; every name here is a commitment.
 * Feature internals stay reachable inside the package through their own
 * modules. The package subpaths are declared in `package.json`
 * (`./session-status`).
 */

import { Ledger } from './ledger/store.ts';
import { WorkspaceFileSource } from './workspace.ts';
import { createWorkspaceMemory } from './memory-write.ts';
import { createCallRunner, type CallRunner, type ReasonSelection, type ReasoningRetryPolicy } from './model/request.ts';
import { createModelTransport } from '@wrenyard/model-call/transport';
import { FileStore } from './media.ts';
import { createEngine } from './turn/engine.ts';
import { SpanRecorder } from '@wrenyard/agent-loop';
import {
  type CallsPort,
  type EnginePorts,
  type Session,
  type SessionHost,
} from './ports.ts';

// ── Composition root contract ─────────────────────────────────────
export type {
  AgentToolPort,
  LiveCall,
  ProjectInfo,
  Session,
  SessionHost,
  WorkspaceMemoryPort,
} from './ports.ts';
export type { DocumentCommitContext } from './document-commit.ts';

// ── Ledger ────────────────────────────────────────────────────────
export {
  Ledger,
  type ActionType,
  type LedgerEvent,
  type ReplySentEvent,
  type SessionSummary,
  type TurnModel,
  type TurnStatus,
} from './ledger/store.ts';

// ── Workspace memory ──────────────────────────────────────────────
export { createWorkspaceMemory } from './memory-write.ts';

// ── Model routing ─────────────────────────────────────────────────
export {
  createCallRunner,
  type AuxiliaryRoute,
} from './model/request.ts';
export { AUXILIARY_ROLE_ORDER, type AuxiliaryRoutePreview } from './model/roles.ts';
export { ROLE_ROUTE_REQUIREMENTS } from './model/route-requirements.ts';

// ── Shapes hosts pass across the boundary ─────────────────────────
export type { TaskArtifact } from './media.ts';

/**
 * Options a host passes beside the host itself. Both members are optional: an
 * automatic main reasoning turn without `selectAutomaticRoutes` keeps the model
 * it started with, and retries without `retryPolicy` are on.
 */
export interface CreateSessionOptions {
  /** Shared authority for workspace documents and session events. */
  ledger?: Ledger;
  /**
   * Fresh ranked routes for an automatic main reasoning turn, read only when
   * such a turn switches model.
   */
  selectAutomaticRoutes?: () => readonly ReasonSelection[] | Promise<readonly ReasonSelection[]>;
  /** Live global retry switches for main reasoning. */
  retryPolicy?: ReasoningRetryPolicy;
}

/** Create the session feature over a host. */
export function createSession(host: SessionHost, options?: CreateSessionOptions): Session {
  const ledger = options?.ledger ?? new Ledger({ stateRoot: host.stateRoot, workspaceRoot: host.workspaceRoot, now: host.now });

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
        resolveAuxiliaryModel: (role, input) => host.resolveAuxiliaryModel(role, input),
        ...(options?.selectAutomaticRoutes === undefined
          ? {}
          : { selectAutomaticRoutes: () => options.selectAutomaticRoutes!() }),
        ...(options?.retryPolicy === undefined
          ? (host.retryPolicy === undefined ? {} : { retryPolicy: host.retryPolicy })
          : { retryPolicy: options.retryPolicy }),
        models: async () => (await host.gateway()).models,
        cacheKey: sessionId,
        append: recorder.report,
        ...(host.now === undefined ? {} : { now: () => host.now!() }),
      });
      runner = {
        run: (input) => executor.run(input),
        holdSpan: (spanId) => recorder.hold(spanId),
        releaseSpan: (spanId, status) => recorder.release(spanId, status),
        ...(host.recordAuxiliaryRun === undefined ? {} : {
          recordAuxiliaryRun: (input) => host.recordAuxiliaryRun!(input),
        }),
      };
      runners.set(sessionId, runner);
    }
    return runner;
  };

  const ports: EnginePorts = {
    ledger,
    memory: createWorkspaceMemory(host.workspaceRoot),
    ...(host.memoryFor === undefined ? {} : { memoryFor: (sessionId: string) => host.memoryFor!(sessionId) }),
    files: (_snapshot, workspaceRoot) => new WorkspaceFileSource({ workspaceRoot }),
    calls,
    fileStore: new FileStore({ stateRoot: host.stateRoot }),
  };
  return createEngine(host, ports);
}
