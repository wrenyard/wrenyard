import {
  GATEWAY_HEADERS,
  GATEWAY_UPSTREAM_RESPONSE_HEADERS,
} from '@wrenyard/providers/base';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  normalizeReasoningEffort,
  type Catalog,
  type GatewayProtocol,
  type PublicGatewayModel,
  type ReasoningEffort,
} from '@wrenyard/providers/catalog';
import { upstreamAuthHeaders, type ProviderCredential, type ProviderRuntime } from '@wrenyard/providers';
import { classifyRouteFailure } from './route-failure.ts';
import type { RouteStateStore } from './route-state.ts';
import { ResponseSampler, type ResponseTpsContract } from './response-tps.ts';
import { repairUpstreamResponse, relayResponse } from './relay.ts';
import { gatewayErrorBody, mapUpstreamErrorBody, streamErrorFact, upstreamErrorFact, type UpstreamErrorFact } from './errors.ts';
import { applyReasoningFields, type GatewayProtocolModule, type GatewayUsage } from './protocols/types.ts';

export interface GatewayRequestCompletedEvent {
  protocol: GatewayProtocol;
  role?: string;
  sessionId?: string;
  usage?: GatewayUsage;
  reasoningParameters?: Record<string, unknown>;
  routeState?: 'rate_limited' | 'quota_exhausted' | 'auth_failed' | 'model_unavailable';
  routeUntil?: string;
  publicModel?: string;
  provider?: string;
  status: number;
  durationMs: number;
  /** Scoped execution id attributed by the request path, when present. */
  executionId?: string;
  /** Public reasoning effort this request was translated at, when it carried one. */
  reasoningEffort?: ReasoningEffort;
  /** Attributable paired response samples for this request, when sampled. */
  tps_samples?: ResponseTpsContract['tps_samples'];
  /**
   * The upstream's own error facts, captured before any normalization. Present
   * on a request that received an upstream error response, and on a request
   * whose HTTP success status carried an official in-stream error observed by
   * the relay (the recorded `status` stays the real upstream status).
   */
  upstream?: UpstreamErrorFact;
}

/** One resolved gateway route: which protocol module owns it and what it is. */
export interface GatewayRoute {
  module: GatewayProtocolModule;
  kind: 'models' | 'inference';
}

export interface GatewayPipelineOptions {
  catalog: Catalog;
  providers: ProviderRuntime;
  fetch: typeof globalThis.fetch;
  now: () => number;
  routes: ReadonlyMap<string, GatewayRoute>;
  routeStates: RouteStateStore;
  /** In-flight request controllers, aborted when the Gateway closes. */
  active: Set<AbortController>;
  isClosed: () => boolean;
  emit: (event: GatewayRequestCompletedEvent) => Promise<void>;
  /** Credential-backed public models, annotated with route state. */
  availableModels: (protocol?: GatewayProtocol) => Promise<PublicGatewayModel[]>;
}

export interface GatewayPipeline {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
  'anthropic-version', 'content-type', 'openai-beta', 'user-agent', 'x-stainless-arch',
  'x-stainless-lang', 'x-stainless-os', 'x-stainless-package-version', 'x-stainless-retry-count',
  'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-timeout',
]);
// Sized for a request that carries its session's images inline as base64.
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/** Upstream headers forwarded to the client, copied verbatim. */
export function allowedResponseHeaders(upstream: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.forEach((value, name) => { if (GATEWAY_UPSTREAM_RESPONSE_HEADERS.has(name)) headers[name] = value; });
  return headers;
}

/** Attribution value of a local `x-wrenyard-*` request header; malformed values are dropped. */
function localHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,256}$/u.test(value) ? value : undefined;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request_too_large');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json_body');
  return parsed as Record<string, unknown>;
}

function upstreamHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (!REQUEST_HEADER_ALLOWLIST.has(name) || value === undefined) continue;
    out.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  out.set('content-type', 'application/json');
  return out;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Splits an optional `/execution/<safe id>` scope out of a gateway request
 * path. Only a well-formed ASCII execution token (letters, digits, `_`, `-`,
 * max 128 chars) is accepted; the remaining path is resolved against the exact
 * known route table, so the execution segment is an attribution field and is
 * never forwarded upstream. A malformed scope yields undefined and the request
 * is not served, exactly as an unknown path.
 */
export function parseScopedPath(
  pathname: string,
  routes: ReadonlyMap<string, GatewayRoute>,
): { executionId?: string; routePath: string } | undefined {
  const match = /^\/gateway\/([^/]+)\/execution\/([^/]+)(\/v1\/.*)$/u.exec(pathname);
  if (!match) return { routePath: pathname };
  const executionId = match[2]!;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(executionId)) return undefined;
  const routePath = `/gateway/${match[1]!}${match[3]!}`;
  if (!routes.has(routePath)) return undefined;
  return { executionId, routePath };
}

/**
 * The protocol-agnostic Gateway pipeline: resolve a model, prepare and send the
 * upstream request, relay the response and record the completion. Every
 * protocol difference is delegated to the route's protocol module and every
 * supplier difference to the provider's request/response hooks; the pipeline
 * itself never branches on a protocol name or a provider id.
 */
export function createGatewayPipeline(options: GatewayPipelineOptions): GatewayPipeline {
  const fetchImpl = options.fetch;

  return {
    async handle(request, response) {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const scoped = parseScopedPath(pathname, options.routes);
      if (!scoped) return false;
      const route = options.routes.get(scoped.routePath);
      if (!route) return false;
      const module = route.module;
      const protocol = module.protocol;
      const executionId = scoped.executionId;
      const startedAt = Date.now();
      const role = localHeader(request, GATEWAY_HEADERS.callRole);
      const sessionId = localHeader(request, GATEWAY_HEADERS.sessionId);
      /** The one completion event of this request, with its attribution. */
      const finish = (event: Omit<GatewayRequestCompletedEvent, 'protocol' | 'durationMs'>): Promise<void> => options.emit({
        protocol, durationMs: Date.now() - startedAt,
        ...(executionId ? { executionId } : {}), ...(role ? { role } : {}), ...(sessionId ? { sessionId } : {}),
        ...event,
      });
      /** A request the Gateway itself refuses; the body is the official envelope. */
      const reject = async (status: number, message: string, event: Partial<GatewayRequestCompletedEvent> = {}): Promise<true> => {
        json(response, status, gatewayErrorBody(module, status, message));
        await finish({ ...event, status });
        return true;
      };
      if (options.isClosed()) {
        json(response, 503, gatewayErrorBody(module, 503, 'Model Gateway is stopping'));
        return true;
      }
      if (route.kind === 'models') {
        if (request.method !== 'GET') return reject(405, 'Method not allowed');
        const models = await options.availableModels(protocol);
        json(response, 200, module.listModels(models));
        await finish({ status: 200 });
        return true;
      }
      if (request.method !== 'POST') return reject(405, 'Method not allowed');

      let body: Record<string, unknown>;
      try { body = await readJson(request); } catch (error) {
        const tooLarge = error instanceof Error && error.message === 'request_too_large';
        return reject(tooLarge ? 413 : 400, tooLarge ? 'Request body too large' : 'Request body must be a JSON object');
      }
      if (typeof body.model !== 'string') return reject(400, 'model must be a provider/model string');

      let publicModel = body.model;
      let resolved;
      try { resolved = options.catalog.resolveGatewayModel(protocol, publicModel); } catch (error) {
        return reject(404, error instanceof Error ? error.message : 'Unknown model', { publicModel });
      }
      publicModel = resolved.publicId;
      const target = { publicModel, provider: resolved.provider.id };

      // A resolved public reasoning effort arrives in a request header, never as
      // a raw body field. When present it is validated against the public enum
      // and this route's own ladder here, before any upstream call; a request
      // without the header keeps its body exactly as delivered.
      const rawEffortHeader = request.headers[GATEWAY_HEADERS.reasoningEffort];
      const effortHeader = Array.isArray(rawEffortHeader) ? rawEffortHeader[0] : rawEffortHeader;
      let reasoningEffort: ReasoningEffort | undefined;
      if (effortHeader !== undefined) {
        const normalized = normalizeReasoningEffort(effortHeader);
        if (normalized === undefined) return reject(400, `Invalid reasoning effort: ${effortHeader}`, target);
        if (!resolved.model.reasoningEfforts.includes(normalized)) {
          return reject(400, `Model ${publicModel} does not support reasoning effort "${normalized}"`, target);
        }
        reasoningEffort = normalized;
      }

      const credential = await options.providers.credential(resolved.provider);
      if (!credential) return reject(401, `Provider ${resolved.provider.id} is not configured`, target);
      options.routeStates.observeCredential(resolved.provider.id, credential.value);

      let reasoningParameters: Record<string, unknown> | undefined;
      const headers = upstreamHeaders(request.headers);
      upstreamAuthHeaders(resolved.provider, credential, protocol).forEach((value, name) => headers.set(name, value));
      const upstreamModel = options.providers.resolveUpstreamModel(resolved.provider, resolved.upstreamModel, credential);
      body.model = upstreamModel;

      // The header is the sole authority for reasoning: strip every raw body
      // spelling and merge the owning provider's exact protocol fields. Without
      // the header the body is left untouched (existing forwarding behavior).
      if (reasoningEffort !== undefined) {
        module.stripReasoningFields(body);
        const fields = resolved.provider.convertReasoningEffort(resolved.model.id, reasoningEffort, protocol);
        reasoningParameters = structuredClone(fields);
        applyReasoningFields(body, fields);
      }

      // Protocol-fixed request fields (e.g. Chat streaming usage reporting).
      module.prepareRequest(body);

      // Supplier request rewrite, executed generically through the runtime.
      const hookContext = () => ({
        protocol,
        modelId: resolved.model.id,
        publicModel,
        ...(executionId === undefined ? {} : { executionId }),
        requestHeaders: request.headers,
        headers,
        body,
        nowMs: options.now(),
      });
      await options.providers.beforeRequest?.(resolved.provider, hookContext());

      const forwarded: Partial<GatewayRequestCompletedEvent> = {
        ...target,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(reasoningParameters === undefined ? {} : { reasoningParameters }),
      };
      let usage: GatewayUsage | undefined;
      let activeCredential = credential;
      const controller = new AbortController();
      options.active.add(controller);
      const abort = () => controller.abort();
      request.once('aborted', abort);
      try {
        const send = () => fetchImpl(resolved.capability.endpoint, {
          method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        });
        let upstream = await send();
        // One bounded recovery for an expired credential: the runtime decides
        // whether refresh is available, and the identical request is retried
        // exactly once. Every other status or failure is exposed unchanged.
        if (upstream.status === 401 && options.providers.refreshCredential !== undefined) {
          let refreshed: ProviderCredential | undefined;
          try {
            refreshed = await options.providers.refreshCredential(resolved.provider, credential, controller.signal);
          } catch (error) {
            // Refresh unavailable or failed: keep the original, unconsumed 401
            // response. Only an abort propagates, so a cancelled request is
            // never silently served as an auth error.
            if (controller.signal.aborted) throw error;
            refreshed = undefined;
          }
          // The retry runs outside the refresh catch, so a retry transport
          // failure propagates to the outer 502 handler rather than falling
          // back to the now-canceled original 401.
          if (refreshed !== undefined) {
            activeCredential = refreshed;
            options.routeStates.observeCredential(resolved.provider.id, refreshed.value);
            upstreamAuthHeaders(resolved.provider, refreshed, protocol).forEach((value, name) => headers.set(name, value));
            await options.providers.beforeRequest?.(resolved.provider, hookContext());
            await upstream.body?.cancel().catch(() => undefined);
            upstream = await send();
          }
        }
        if (!upstream.ok) {
          // Only errors are buffered so their facts can be captured and, when
          // needed, remapped. A conforming upstream body is forwarded with its
          // exact status and bytes.
          const errorBytes = new Uint8Array(await upstream.arrayBuffer());
          let errorBody: unknown;
          try { errorBody = JSON.parse(new TextDecoder().decode(errorBytes)); } catch { errorBody = undefined; }
          const fact = upstreamErrorFact(upstream.status, upstream.headers, errorBody);
          const failure = classifyRouteFailure(
            resolved.provider, resolved.model.id, upstream.status, upstream.headers, errorBody, options.now(),
          );
          const state = failure && options.routeStates.mark(
            resolved.provider.id, resolved.model.id, failure, upstream.status, activeCredential.value,
          );
          let finalStatus = upstream.status;
          let finalBody = errorBody;
          let finalBytes: Uint8Array<ArrayBufferLike> = errorBytes;
          if (options.providers.afterResponse) {
            const corrected = await options.providers.afterResponse(resolved.provider, {
              protocol, modelId: resolved.model.id, publicModel,
              status: upstream.status, headers: upstream.headers, errorBytes, errorBody,
            });
            if (corrected?.status !== undefined) finalStatus = corrected.status;
            if (corrected?.errorBody !== undefined) {
              finalBody = corrected.errorBody;
              finalBytes = encodeJson(corrected.errorBody);
            }
          }
          // Minimal mapping: an official body keeps its bytes; a non-conforming
          // structure is wrapped in the entry protocol's official envelope.
          const mapped = mapUpstreamErrorBody(module, finalStatus, finalBytes, finalBody);
          response.writeHead(mapped.status, allowedResponseHeaders(upstream.headers));
          response.end(Buffer.from(mapped.bytes));
          await finish({
            ...forwarded, status: mapped.status, upstream: fact,
            ...(state ? { routeState: state.state, routeUntil: state.until } : {}),
          });
          return true;
        }
        // The supplier response hook may replace the response (e.g. supply a
        // missing Content-Type), so the original upstream status and headers
        // are captured before it runs; in-stream error facts must record what
        // the supplier actually sent.
        const originalStatus = upstream.status;
        const originalHeaders = new Headers(upstream.headers);
        const repaired = await repairUpstreamResponse(upstream, {
          module, provider: resolved.provider, providers: options.providers,
          modelId: resolved.model.id, publicModel,
        });
        response.writeHead(repaired.status, allowedResponseHeaders(repaired.headers));
        // The selected protocol module translates its own generation events
        // into protocol-neutral signals for the shared TPS sampler; the sample
        // model is the requested canonical public model.
        const sampler = new ResponseSampler({ now: options.now, model: publicModel });
        const observer = module.createObserver();
        const translator = module.createTpsTranslator();
        const relayed = await relayResponse(repaired, response, {
          module, provider: resolved.provider, providers: options.providers,
          modelId: resolved.model.id, upstreamModel, publicModel, observer, sampler, translator,
        });
        if (observer.succeeded()) options.routeStates.success(resolved.provider.id, resolved.model.id);
        response.end();
        usage = observer.result();
        await finish({
          ...forwarded, status: repaired.status,
          // An official in-stream error after HTTP 200 is recorded with the
          // original `type`/`code` the protocol module observed, together with
          // the upstream's own retry hints; the HTTP status stays 200 because
          // that is what the supplier returned.
          ...(relayed.observedError ? { upstream: streamErrorFact(originalStatus, originalHeaders, relayed.observedError) } : {}),
          ...(sampler.sample() ?? {}), ...(usage ? { usage } : {}),
        });
      } catch (error) {
        const status = controller.signal.aborted ? 499 : 502;
        if (!response.headersSent) {
          json(response, status, gatewayErrorBody(module, status, controller.signal.aborted ? 'Request cancelled' : 'Provider request failed'));
        } else {
          response.destroy();
        }
        await finish({ ...forwarded, status, ...(usage ? { usage } : {}) });
      } finally {
        request.off('aborted', abort);
        options.active.delete(controller);
      }
      return true;
    },
  };
}
