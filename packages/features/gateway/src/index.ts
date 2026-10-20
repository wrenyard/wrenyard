import type { IncomingMessage, ServerResponse } from 'node:http';
import { bareModelId, type Catalog, type GatewayProtocol, type PublicGatewayModel } from '@wrenyard/providers/catalog';
import type { ProviderRuntime } from '@wrenyard/providers';
import { RouteStateStore, type Admission, type ClientFaultKind, type MarkableFailure, type RouteGuard, type RouteStateChangedEvent, type RouteStatus } from './route-state.ts';
import { chatProtocol } from './protocols/chat.ts';
import { responsesProtocol } from './protocols/responses.ts';
import { messagesProtocol } from './protocols/messages.ts';
import type { GatewayProtocolModule } from './protocols/types.ts';
import { createGatewayPipeline, type GatewayRequestCompletedEvent, type GatewayRoute } from './pipeline.ts';
import type { UpstreamErrorFact } from './errors.ts';
import type { ResponseTpsContract, ResponseTpsSample } from './response-tps.ts';
import {
  classifyGatewayOutcome,
  createGatewayHealthStore,
  type GatewayHealthOutcome,
  type GatewayHealthRouteSnapshot,
  type GatewayHealthWindowFigures,
} from './health.ts';

export type { RouteStateChangedEvent, RouteStatus, CircuitPhase, ClientFaultKind, MarkableFailure, Admission, RouteGuard } from './route-state.ts';
export type { RouteFaultKind } from './route-failure.ts';
export { classifyRouteFailure } from './route-failure.ts';
export type { GatewayRequestCompletedEvent } from './pipeline.ts';
export type { GatewayHealthOutcome, GatewayHealthRouteSnapshot, GatewayHealthWindowFigures } from './health.ts';
export { classifyGatewayOutcome } from './health.ts';

export interface GatewayHealthSnapshot {
  generatedAt: string;
  routes: Array<GatewayHealthRouteSnapshot & { routeState?: RouteStatus }>;
}

export interface GatewayHealthCompletionInput {
  provider: string;
  publicModel: string;
  status: number;
  outcome?: GatewayHealthOutcome;
  failureClass?: string;
  faultReason?: string;
  faultCause?: GatewayRequestCompletedEvent['faultCause'];
  upstream?: UpstreamErrorFact;
  tps_samples?: ResponseTpsContract['tps_samples'];
  timestamp: number;
}

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
   * Report a client-observed transport fault (a fetch failure the Gateway only
   * saw as a disconnect) into the same route state store. A fault is recorded
   * only while the attempt is unsettled, so a client report and a server-side
   * fault of the same attempt are never double counted.
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
  /** Record a schema-validated native task success; it clears the faults it observed at admission. */
  completeRouteSuccess(provider: string, model: string, guard?: RouteGuard): void;
  /**
   * Record a route-local fault a native task attempt already classified for its
   * own route. The failure carries its own fault kind, scope and any
   * upstream-stated reset instant.
   */
  reportNativeRouteFault(provider: string, model: string, failure: MarkableFailure, guard?: RouteGuard): void;
  /** Passive per-route health figures from recent completions; does not affect routing. */
  health(): GatewayHealthSnapshot;
  /** Replay one persisted completion into the passive health store (daemon backfill). */
  ingestHealthCompletion(input: GatewayHealthCompletionInput): void;
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
 * Normalize one route model onto the route-state key's model part.
 *
 * A native task route carries its resolved client as a `:<client>` suffix
 * (`provider/model:client`), while route state is shared by provider and model.
 * Only a known public client key is stripped, so a `:free` model variant keeps
 * its exact identity. This is the single normalization used by every route-state
 * lookup, so a client-qualified route observes the same rate_limited window as
 * the bare route that recorded it.
 */
function routeModel(model: string): string {
  return bareModelId(model);
}

/**
 * Normalize one route identity onto the provider-qualified internal key.
 *
 * A bare registered model id is accepted only when exactly one provider offers
 * it; a model offered by several providers is ambiguous and yields no route
 * rather than silently selecting the first declaration. The route key stays the
 * internal identity for health, quota and statistics.
 */
function healthMetricsFromSamples(
  samples?: ResponseTpsContract['tps_samples'],
): { firstResponseMs?: number; tps?: number } {
  if (samples === undefined || samples.length === 0) return {};
  const sample = samples[0]!;
  if ('generation_windows' in sample && sample.generation_windows.length > 0) {
    const window = sample.generation_windows[0]!;
    const firstResponseMs = sample.request_started_at_ms === undefined
      ? undefined
      : window.first_token_at_ms - sample.request_started_at_ms;
    const span = window.completed_at_ms - window.first_token_at_ms;
    const tps = span > 0 ? (1000 * sample.output_tokens) / span : undefined;
    return {
      ...(firstResponseMs !== undefined && Number.isFinite(firstResponseMs) && firstResponseMs >= 0 ? { firstResponseMs } : {}),
      ...(tps !== undefined && Number.isFinite(tps) ? { tps } : {}),
    };
  }
  const scalar = sample as ResponseTpsSample;
  const firstResponseMs = scalar.request_started_at_ms === undefined
    ? undefined
    : scalar.first_token_at_ms - scalar.request_started_at_ms;
  const span = scalar.completed_at_ms - scalar.first_token_at_ms;
  const tps = span > 0 ? (1000 * scalar.output_tokens) / span : undefined;
  return {
    ...(firstResponseMs !== undefined && Number.isFinite(firstResponseMs) && firstResponseMs >= 0 ? { firstResponseMs } : {}),
    ...(tps !== undefined && Number.isFinite(tps) ? { tps } : {}),
  };
}

function healthFailureReason(input: {
  faultReason?: string;
  faultCause?: GatewayRequestCompletedEvent['faultCause'];
  upstream?: UpstreamErrorFact;
}): string | undefined {
  if (input.upstream !== undefined) {
    const code = input.upstream.code ?? input.upstream.type;
    if (code !== undefined) return `${input.upstream.status} ${code}`;
    return String(input.upstream.status);
  }
  if (input.faultCause?.message !== undefined && input.faultCause.message !== '') return input.faultCause.message;
  return input.faultReason;
}

function resolveHealthRoute(
  catalog: Catalog,
  provider: string,
  publicModel: string,
): { provider: string; model: string } {
  const identity = publicModel.includes('/') ? publicModel : `${provider}/${publicModel}`;
  const split = gatewayRouteKey(catalog, identity);
  return split ?? { provider, model: routeModel(publicModel) };
}

export function gatewayRouteKey(
  catalog: Catalog,
  identity: string,
): { provider: string; model: string } | undefined {
  const qualified = splitModel(identity);
  if (qualified !== undefined) return { provider: qualified.provider, model: routeModel(qualified.model) };
  if (identity.trim() === '') return undefined;
  const model = routeModel(identity);
  const matches = catalog.providers().filter((provider) =>
    provider.models.some((candidate) => candidate.id === model));
  return matches.length === 1 ? { provider: matches[0]!.id, model } : undefined;
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
  const nowFn = options.now ?? Date.now;
  const healthStore = createGatewayHealthStore(nowFn);
  const routeStates = new RouteStateStore(nowFn,
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
    if (split !== undefined) routeStates.reportAttemptFault(split.provider, split.model, attemptId, kind, 502);
  };

  const completeRouteAttempt = (publicModel: string, attemptId: string): void => {
    const split = gatewayRouteKey(options.catalog, publicModel);
    if (split !== undefined) routeStates.completeAttempt(split.provider, split.model, attemptId);
  };

  // ── Native task route-state ──
  // The task path admits exactly one attempt per collected run, so it hands the
  // admission handle back to be settled here instead of re-deriving a route.
  // These delegate to the same single RouteStateStore the HTTP callers use.
  const admitRoute = (provider: string, model: string): Admission => routeStates.admit(provider, routeModel(model));

  const completeRouteSuccess = (provider: string, model: string, guard?: RouteGuard): void => {
    routeStates.success(provider, routeModel(model), guard);
  };

  const reportNativeRouteFault = (provider: string, model: string, failure: MarkableFailure, guard?: RouteGuard): void => {
    routeStates.reportNativeRouteFault(provider, model, failure, guard);
  };

  /**
   * Credential-backed public models, each annotated with its current route
   * state. Without a protocol the complete, protocol-independent directory is
   * returned; with one the entries are filtered to that protocol. A faulted route stays visible with its state and retry time rather than
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
            ...(status.faultKind === undefined ? {} : { faultKind: status.faultKind }),
          }),
        };
      });
  };

  const recordHealthFromCompletion = (event: GatewayRequestCompletedEvent, timestamp: number): void => {
    if (event.provider === undefined || event.publicModel === undefined) return;
    const route = resolveHealthRoute(options.catalog, event.provider, event.publicModel);
    const classified = event.outcome !== undefined
      ? { outcome: event.outcome, failureClass: event.failureClass }
      : classifyGatewayOutcome({
        status: event.status,
        faultReason: event.faultReason,
        hasUpstreamError: event.upstream !== undefined,
        admissionRefusal: event.status === 503 && event.upstream === undefined,
        cancelled: event.status === 499,
      });
    const metrics = healthMetricsFromSamples(event.tps_samples);
    healthStore.record({
      provider: route.provider,
      publicModel: `${route.provider}/${route.model}`,
      timestamp,
      outcome: classified.outcome,
      failureClass: classified.failureClass,
      failureReason: healthFailureReason(event),
      ...metrics,
    });
  };

  const emit = async (event: GatewayRequestCompletedEvent): Promise<void> => {
    try { await options.onRequestCompleted?.(event); } catch { /* stats must not fail inference */ }
    try { recordHealthFromCompletion(event, nowFn()); } catch { /* passive health must not fail inference */ }
  };

  const pipeline = createGatewayPipeline({
    catalog: options.catalog,
    providers: options.providers,
    fetch: options.fetch ?? globalThis.fetch,
    now: nowFn,
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

    health() {
      const generatedAt = new Date(nowFn()).toISOString();
      const routes = healthStore.snapshot(nowFn()).map((route) => ({
        ...route,
        routeState: routeStates.status(route.provider, route.model),
      }));
      return { generatedAt, routes };
    },

    ingestHealthCompletion(input: GatewayHealthCompletionInput) {
      const route = resolveHealthRoute(options.catalog, input.provider, input.publicModel);
      const classified = input.outcome !== undefined
        ? { outcome: input.outcome, failureClass: input.failureClass }
        : classifyGatewayOutcome({
          status: input.status,
          faultReason: input.faultReason,
          hasUpstreamError: input.upstream !== undefined,
          admissionRefusal: input.status === 503 && input.upstream === undefined,
          cancelled: input.status === 499,
        });
      healthStore.record({
        provider: route.provider,
        publicModel: `${route.provider}/${route.model}`,
        timestamp: input.timestamp,
        outcome: classified.outcome,
        failureClass: classified.failureClass,
        failureReason: healthFailureReason(input),
        ...healthMetricsFromSamples(input.tps_samples),
      });
    },

    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      active.clear();
      routeStates.close();
    },
  };
}
