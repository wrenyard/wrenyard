import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Catalog, GatewayProtocol, PublicGatewayModel } from '@wrenyard/providers/catalog';
import type { ProviderRuntime } from '@wrenyard/providers';
import { RouteStateStore, type Admission, type ClientFaultKind, type NativeRouteFaultKind, type ProbeLease, type RouteGuard, type RouteStateChangedEvent, type RouteStatus } from './route-state.ts';
import { chatProtocol } from './protocols/chat.ts';
import { responsesProtocol } from './protocols/responses.ts';
import { messagesProtocol } from './protocols/messages.ts';
import type { GatewayProtocolModule } from './protocols/types.ts';
import { createGatewayPipeline, type GatewayRequestCompletedEvent, type GatewayRoute } from './pipeline.ts';

export type { RouteStateChangedEvent, RouteStatus, CircuitPhase, ClientFaultKind, NativeRouteFaultKind, Admission, ProbeLease, RouteGuard } from './route-state.ts';
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
  /**
   * Admit one native task attempt for an exact `provider/model` route before it
   * launches. The identity is the route's provider plus its model key (the
   * canonical target's client-qualified model), never a re-split public string.
   * A `blocked` decision means the shared circuit refuses the route and the
   * attempt must not launch.
   */
  admitRoute(provider: string, model: string): Admission;
  /**
   * Record a schema-validated native task success. When the attempt was admitted
   * as one, the held half-open probe lease is settled as success so a
   * native-only route can close its own circuit and clear the faults it
   * observed at admission.
   */
  completeRouteSuccess(provider: string, model: string, guard?: RouteGuard, lease?: ProbeLease): void;
  /**
   * Record a route-local fault a native task attempt observed on its own route.
   * A held half-open probe lease is settled with the classified fault so the
   * probe backoff is preserved.
   */
  reportNativeRouteFault(provider: string, model: string, kind: NativeRouteFaultKind, guard?: RouteGuard, lease?: ProbeLease, until?: string): void;
  /** Release a held native-task probe lease as cancelled; it never silently expires. */
  releaseNativeProbe(lease: ProbeLease): void;
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

/** Split a provider-qualified internal route key; a malformed id yields no route. */
function splitModel(publicModel: string): { provider: string; model: string } | undefined {
  const separator = publicModel.indexOf('/');
  return separator > 0 ? { provider: publicModel.slice(0, separator), model: publicModel.slice(separator + 1) } : undefined;
}

/**
 * Normalize one route identity onto the provider-qualified internal key.
 *
 * A bare registered model id is accepted only when exactly one provider offers
 * it; a model offered by several providers is ambiguous and yields no route
 * rather than silently selecting the first declaration. The route key stays the
 * internal identity for health, quota and statistics.
 */
export function gatewayRouteKey(
  catalog: Catalog,
  identity: string,
): { provider: string; model: string } | undefined {
  const qualified = splitModel(identity);
  if (qualified !== undefined) return qualified;
  if (identity.trim() === '') return undefined;
  const matches = catalog.providers().filter((provider) =>
    provider.models.some((model) => model.id === identity));
  return matches.length === 1 ? { provider: matches[0]!.id, model: identity } : undefined;
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
    const split = gatewayRouteKey(options.catalog, publicModel);
    return split === undefined ? undefined : routeStates.status(split.provider, split.model);
  };

  const beginRouteAttempt = (publicModel: string, attemptId: string): void => {
    const split = gatewayRouteKey(options.catalog, publicModel);
    if (split !== undefined) routeStates.beginAttempt(split.provider, split.model, attemptId);
  };

  const reportRouteFault = (publicModel: string, attemptId: string, kind: ClientFaultKind): void => {
    const split = gatewayRouteKey(options.catalog, publicModel);
    if (split !== undefined) routeStates.reportAttemptFault(split.provider, split.model, attemptId, kind, kind === 'timeout' ? 504 : 502);
  };

  const completeRouteAttempt = (publicModel: string, attemptId: string): void => {
    const split = gatewayRouteKey(options.catalog, publicModel);
    if (split !== undefined) routeStates.completeAttempt(split.provider, split.model, attemptId);
  };

  // ── Native task route-state ──
  // The task path admits exactly one attempt per collected run, so it hands the
  // admission handle back to be settled here instead of re-deriving a route.
  // These delegate to the same single RouteStateStore the HTTP callers use.
  const admitRoute = (provider: string, model: string): Admission => routeStates.admit(provider, model);

  const completeRouteSuccess = (provider: string, model: string, guard?: RouteGuard, lease?: ProbeLease): void => {
    // A due half-open probe is settled as success first, then the captured
    // generations are cleared; either order leaves the route healthy.
    if (lease !== undefined) routeStates.releaseProbe(lease, 'success');
    routeStates.success(provider, model, guard);
  };

  const reportNativeRouteFault = (provider: string, model: string, kind: NativeRouteFaultKind, guard?: RouteGuard, lease?: ProbeLease, until?: string): void => {
    routeStates.reportNativeRouteFault(provider, model, kind, guard, lease, until);
  };

  const releaseNativeProbe = (lease: ProbeLease): void => {
    routeStates.releaseNativeProbe(lease);
  };

  /**
   * Credential-backed public models, each annotated with its current route
   * state. Without a protocol the complete, protocol-independent directory is
   * returned; with one the entries are filtered to that protocol. A faulted or
   * half-open route stays visible with its state and retry time rather than
   * being hidden or excluded.
   */
  const availableProviderIDs = async (): Promise<ReadonlySet<string>> => {
    const available = new Set<string>();
    await Promise.all(options.catalog.providers().map(async (provider) => {
      const credential = await options.providers.credential(provider);
      if (!credential) return;
      routeStates.observeCredential(provider.id, credential.value);
      available.add(provider.id);
    }));
    return available;
  };

  const availableModels = async (protocol?: GatewayProtocol): Promise<PublicGatewayModel[]> => {
    const available = await availableProviderIDs();
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
    availableProviderIDs,
    availableModels,
  });

  return {
    routeStatus,
    beginRouteAttempt,
    reportRouteFault,
    completeRouteAttempt,
    admitRoute,
    completeRouteSuccess,
    reportNativeRouteFault,
    releaseNativeProbe,
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
