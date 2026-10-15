import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Catalog, GatewayProtocol, PublicGatewayModel } from '@wrenyard/providers/catalog';
import type { ProviderRuntime } from '@wrenyard/providers';
import { RouteStateStore, type ClientFaultKind, type RouteStateChangedEvent, type RouteStatus } from './route-state.ts';
import { chatProtocol } from './protocols/chat.ts';
import { responsesProtocol } from './protocols/responses.ts';
import { messagesProtocol } from './protocols/messages.ts';
import type { GatewayProtocolModule } from './protocols/types.ts';
import { createGatewayPipeline, type GatewayRequestCompletedEvent, type GatewayRoute } from './pipeline.ts';

export type { RouteStateChangedEvent, RouteStatus, CircuitPhase, ClientFaultKind } from './route-state.ts';
export type { RouteFaultKind } from './route-failure.ts';
export type { GatewayRequestCompletedEvent } from './pipeline.ts';

export interface GatewayConnection {
  openaiChatBaseUrl: string;
  openaiResponsesBaseUrl: string;
  anthropicBaseUrl: string;
  /** The complete, protocol-independent public model directory. */
  models: PublicGatewayModel[];
}

export interface ModelGatewayOptions {
  now?: () => number;
  catalog: Catalog;
  providers: ProviderRuntime;
  fetch?: typeof globalThis.fetch;
  onRouteStateChanged?: (event: RouteStateChangedEvent) => void | Promise<void>;
  onRequestCompleted?: (event: GatewayRequestCompletedEvent) => void | Promise<void>;
}

export interface ModelGateway {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  connection(origin: string): Promise<GatewayConnection>;
  /** Current in-memory state of a public `provider/model` route, with circuit detail. */
  routeStatus(publicModel: string): RouteStatus | undefined;
  /**
   * Begin a client attempt, capturing the fault generations it observes. The
   * attempt identity is shared with the Gateway through `x-wrenyard-gateway-attempt`.
   */
  beginRouteAttempt(publicModel: string, attemptId: string): void;
  /**
   * Report a client-observed fault (a timeout or fetch failure the Gateway only
   * saw as a disconnect) into the same route state store. A fault is recorded
   * only while the attempt is unsettled, so a client report and the server-side
   * timeout of the same attempt are never double counted.
   */
  reportRouteFault(publicModel: string, attemptId: string, kind: ClientFaultKind): void;
  /** Finish a client attempt; its settled tombstone expires after a bounded TTL. */
  completeRouteAttempt(publicModel: string, attemptId: string): void;
  close(): Promise<void>;
}

/** The three official entry protocols, each owning its own paths and shapes. */
const PROTOCOLS: readonly GatewayProtocolModule[] = [chatProtocol, responsesProtocol, messagesProtocol];

const ROUTES: ReadonlyMap<string, GatewayRoute> = new Map(
  PROTOCOLS.flatMap((module): [string, GatewayRoute][] => [
    [module.modelsPath, { module, kind: 'models' }],
    [module.inferencePath, { module, kind: 'inference' }],
  ]),
);

/** Split a public `provider/model` id; a malformed id yields no route. */
function splitModel(publicModel: string): { provider: string; model: string } | undefined {
  const separator = publicModel.indexOf('/');
  return separator > 0 ? { provider: publicModel.slice(0, separator), model: publicModel.slice(separator + 1) } : undefined;
}

/**
 * Assemble the Model Gateway from its parts: the route table, the in-memory
 * route-state store, and the protocol-agnostic pipeline. This module owns no
 * protocol or supplier behavior; it is the Gateway's assembly and public
 * interface only.
 */
export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const active = new Set<AbortController>();
  let closed = false;
  const routeStates = new RouteStateStore(options.now ?? Date.now,
    options.providers.quotaPools ?? (() => []),
    event => { void Promise.resolve().then(() => options.onRouteStateChanged?.(event)).catch(() => undefined); });

  const routeStatus = (publicModel: string): RouteStatus | undefined => {
    const split = splitModel(publicModel);
    return split === undefined ? undefined : routeStates.status(split.provider, split.model);
  };

  const beginRouteAttempt = (publicModel: string, attemptId: string): void => {
    const split = splitModel(publicModel);
    if (split !== undefined) routeStates.beginAttempt(split.provider, split.model, attemptId);
  };

  const reportRouteFault = (publicModel: string, attemptId: string, kind: ClientFaultKind): void => {
    const split = splitModel(publicModel);
    if (split !== undefined) routeStates.reportAttemptFault(split.provider, split.model, attemptId, kind, kind === 'timeout' ? 504 : 502);
  };

  const completeRouteAttempt = (publicModel: string, attemptId: string): void => {
    const split = splitModel(publicModel);
    if (split !== undefined) routeStates.completeAttempt(split.provider, split.model, attemptId);
  };

  /**
   * Credential-backed public models, each annotated with its current route
   * state. Without a protocol the complete, protocol-independent directory is
   * returned; with one the entries are filtered to that protocol. A faulted or
   * half-open route stays visible with its state and retry time rather than
   * being hidden or excluded.
   */
  const availableModels = async (protocol?: GatewayProtocol): Promise<PublicGatewayModel[]> => {
    const available = new Set<string>();
    await Promise.all(options.catalog.providers().map(async (provider) => {
      const credential = await options.providers.credential(provider);
      if (!credential) return;
      routeStates.observeCredential(provider.id, credential.value);
      available.add(provider.id);
    }));
    return options.catalog.gatewayModels((provider) => available.has(provider.id))
      .filter((model) => protocol === undefined || model.protocols.includes(protocol))
      .map((model) => {
        const status = routeStates.status(model.provider, model.id);
        return {
          ...model,
          ...(status === undefined ? {} : {
            routeState: status.state, routeUntil: status.until,
            routePhase: status.phase,
            ...(status.nextProbeAt === undefined ? {} : { routeNextProbeAt: status.nextProbeAt }),
            ...(status.faultKind === undefined ? {} : { faultKind: status.faultKind }),
          }),
        };
      });
  };

  const emit = async (event: GatewayRequestCompletedEvent): Promise<void> => {
    try { await options.onRequestCompleted?.(event); } catch { /* stats must not fail inference */ }
  };

  const pipeline = createGatewayPipeline({
    catalog: options.catalog,
    providers: options.providers,
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? Date.now,
    routes: ROUTES,
    routeStates,
    active,
    isClosed: () => closed,
    emit,
    availableModels,
  });

  return {
    routeStatus,
    beginRouteAttempt,
    reportRouteFault,
    completeRouteAttempt,
    handle: (request, response) => pipeline.handle(request, response),

    async connection(origin) {
      const root = origin.replace(/\/$/, '');
      return {
        openaiChatBaseUrl: `${root}/gateway/openai-chat/v1`,
        openaiResponsesBaseUrl: `${root}/gateway/openai-responses/v1`,
        anthropicBaseUrl: `${root}/gateway/anthropic/v1`,
        models: await availableModels(),
      };
    },

    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      active.clear();
      routeStates.close();
    },
  };
}
