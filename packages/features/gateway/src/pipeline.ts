import {
  GATEWAY_ADMISSION_REFUSED,
  GATEWAY_HEADERS,
  GATEWAY_UPSTREAM_RESPONSE_HEADERS,
  type GatewayAdmissionRefusal,
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
import { classifyRouteOutcome, classifyStreamFailure, clientTimeoutFailure, isPoisoning, transportFailure, type RouteFaultKind } from './route-failure.ts';
import type { CircuitPhase, MarkableFailure, ProbeOutcome, RouteStateStore, RouteStatus } from './route-state.ts';
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
  /** The specific fault kind behind `routeState`, when a route was faulted. */
  faultReason?: RouteFaultKind;
  /** The circuit phase of the faulted scope at the moment of the outcome. */
  routePhase?: CircuitPhase;
  /** When a half-open trial may next run, when the scope is half-open. */
  nextProbeAt?: string;
  /** The outcome of a bounded half-open probe this request ran, when it ran one. */
  probeOutcome?: ProbeOutcome;
  /**
   * The internal gateway-only correlation marker carried by this attempt. It is
   * never forwarded upstream: it exists so a client-side timeout or fetch
   * failure can be accounted to the same store without double counting.
   */
  attemptId?: string;
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

/**
 * Internal, gateway-only correlation marker. It is read from the request and
 * never forwarded upstream (it is not in the request-header allowlist), so a
 * client-observed timeout or fetch failure can be attributed to the same
 * attempt without double counting.
 */
const CORRELATION_HEADER = 'x-wrenyard-gateway-attempt';

/**
 * Internal, gateway-only client deadline (epoch milliseconds) for one call. When
 * a request is aborted after this instant, the Gateway records a client-observed
 * timeout against the route instead of mistaking it for a plain cancellation.
 * Never forwarded upstream.
 */
const DEADLINE_HEADER = 'x-wrenyard-deadline';

/** Bound on time-to-first-byte of one upstream request, even if the promise stalls. */
const UPSTREAM_HEADERS_DEADLINE_MS = 120_000;

/** The largest delay `setTimeout` accepts; an oversized deadline is clamped to it. */
const MAX_TIMER_SAFE = 2_147_483_647;

/** The abort error a bounded race rejects with when its signal fires first. */
function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/**
 * Race one upstream promise against its abort signal, so a fetch or a stream that
 * ignores the signal still settles the pipeline at its deadline instead of
 * hanging forever. The losing promise keeps its own settlement handled.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

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

      // The internal correlation marker and the trusted client deadline are read
      // before admission so the admitted probe lease can be attached to this very
      // attempt, and the attempt's own lifetime can be bounded by it.
      const attemptId = localHeader(request, CORRELATION_HEADER);
      const deadlineHeader = localHeader(request, DEADLINE_HEADER);
      const clientDeadlineMs = deadlineHeader === undefined ? undefined : Number(deadlineHeader);
      const clientDeadline = clientDeadlineMs !== undefined && Number.isFinite(clientDeadlineMs) && clientDeadlineMs > 0 ? clientDeadlineMs : undefined;

      // Admission is enforced here, not only in the selector: before any
      // upstream call the route must be admitted. A faulted scope answers with a
      // structured, safe cooldown/retry payload and issues no upstream traffic;
      // a half-open scope admits exactly one concurrent bounded probe.
      const admission = options.routeStates.admit(resolved.provider.id, resolved.model.id, attemptId);
      if (admission.kind === 'blocked') {
        const retryAt = admission.status.nextProbeAt ?? admission.status.until;
        const message = `Route ${publicModel} is unavailable (fault ${admission.status.faultKind ?? admission.status.state}, circuit ${admission.status.phase}); retry after ${retryAt}`;
        const retrySeconds = Math.max(0, Math.ceil((Date.parse(retryAt) - options.now()) / 1000));
        // The admission refusal carries a structured, Gateway-local marker so a
        // caller can distinguish the local circuit refusing the request from a
        // real upstream fault. The protocol error body and the `retry-after`
        // hint keep their existing shape and values.
        const refusal: GatewayAdmissionRefusal = {
          kind: GATEWAY_ADMISSION_REFUSED,
          retryAt,
          phase: admission.status.phase,
          ...(admission.status.faultKind === undefined ? {} : { faultKind: admission.status.faultKind }),
        };
        response.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': String(retrySeconds),
          [GATEWAY_HEADERS.admission]: JSON.stringify(refusal),
        });
        response.end(JSON.stringify(gatewayErrorBody(module, 503, message)));
        await finish({
          ...target, status: 503, routeState: admission.status.state, routeUntil: retryAt,
          faultReason: admission.status.faultKind ?? admission.status.state, routePhase: admission.status.phase,
          ...(admission.status.nextProbeAt === undefined ? {} : { nextProbeAt: admission.status.nextProbeAt }),
          ...(attemptId === undefined ? {} : { attemptId }),
        });
        return true;
      }
      const guard = admission.guard;
      const lease = admission.kind === 'probe' ? admission.lease : undefined;
      // The lease must be released exactly once, on success, failure,
      // cancellation, shutdown or bounded expiry; the store's own timer covers
      // expiry, and the finally block covers shutdown and any early exit. The
      // classified fault a probe observed travels with its settlement.
      let leaseReleased = false;
      const releaseLease = (outcome?: ProbeOutcome, failure?: MarkableFailure, status?: number): void => {
        if (lease === undefined || leaseReleased) return;
        leaseReleased = true;
        options.routeStates.releaseProbe(lease, outcome, failure, status);
      };

      const forwarded: Partial<GatewayRequestCompletedEvent> = {
        ...target,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(reasoningParameters === undefined ? {} : { reasoningParameters }),
        ...(attemptId === undefined ? {} : { attemptId }),
      };
      let usage: GatewayUsage | undefined;
      let activeCredential = credential;
      /**
       * Record one route fault through the same classification path, correlated
       * to the attempt when one was identified, so a client report and a
       * server-side fault of the same attempt are never double counted. An
       * already-settled attempt yields nothing.
       */
      const recordFault = (failure: MarkableFailure, status: number): RouteStatus | undefined => attemptId === undefined
        ? options.routeStates.mark(resolved.provider.id, resolved.model.id, failure, status, activeCredential.value, guard)
        : options.routeStates.markAttemptFault(resolved.provider.id, resolved.model.id, attemptId, failure, status, activeCredential.value, guard);
      const controller = new AbortController();
      options.active.add(controller);
      let upstreamTimedOut = false;
      let fetchTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => controller.abort();
      // The whole response is bounded, streaming included: by the trusted client
      // deadline when one is present, and always by the probe lease so a
      // recovery probe's real request lifetime cannot outlive its own lease. At
      // that instant the upstream work is aborted as a route timeout even if
      // headers were already sent, so a stalled or vanished downstream can never
      // leave the upstream promise running unbounded.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const armDeadline = (deadlines: (number | undefined)[]): void => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        const hardDeadline = deadlines.filter((value): value is number => value !== undefined);
        deadlineTimer = hardDeadline.length === 0
          ? undefined
          : setTimeout(
              () => { upstreamTimedOut = true; abort(); },
              Math.min(MAX_TIMER_SAFE, Math.max(0, Math.min(...hardDeadline) - options.now())),
            );
        deadlineTimer?.unref?.();
      };
      armDeadline([clientDeadline, lease?.expiresAt]);
      // A completed-request client disconnect also aborts upstream work.
      const onResponseClose = (): void => { if (!response.writableEnded) abort(); };
      request.once('aborted', abort);
      response.once('close', onResponseClose);
      try {
        const send = async (): Promise<Response> => {
          // A request that is already aborted or disconnected is never sent.
          if (controller.signal.aborted || request.readableAborted || response.destroyed) throw abortError();
          if (fetchTimer !== undefined) clearTimeout(fetchTimer);
          fetchTimer = setTimeout(() => { upstreamTimedOut = true; abort(); }, UPSTREAM_HEADERS_DEADLINE_MS);
          try {
            // Raced against the signal: an uncooperative fetch that ignores the
            // abort can never leave this pipeline awaiting it forever.
            return await raceAbort(fetchImpl(resolved.capability.endpoint, {
              method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
            }), controller.signal);
          } finally {
            if (fetchTimer !== undefined) { clearTimeout(fetchTimer); fetchTimer = undefined; }
          }
        };
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
          const outcome = classifyRouteOutcome(
            resolved.provider, resolved.model.id, upstream.status, upstream.headers, errorBody, options.now(),
          );
          const failure = outcome !== undefined && isPoisoning(outcome) ? outcome : undefined;
          // A probe treats any HTTP response as evidence: a poisonable fault is
          // a failed probe (back off), a caller-caused fault is a release that
          // leaves the scope half-open, never a poison. A normal request records
          // only a poisonable fault.
          let state: RouteStatus | undefined;
          let probeOutcome: ProbeOutcome | undefined;
          if (lease !== undefined) {
            // A poisonable fault fails the probe with its own classification (a
            // 429's pool scope and `Retry-After`, an auth provider scope); a
            // caller-caused fault releases it neutrally, never a poison.
            probeOutcome = failure === undefined ? 'cancelled' : 'failure';
            releaseLease(probeOutcome, failure, upstream.status);
          } else if (failure !== undefined) {
            state = recordFault(failure, upstream.status);
          }
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
            ...(state ? { routeState: state.state, routeUntil: state.until, faultReason: state.faultKind, routePhase: state.phase } : {}),
            ...(probeOutcome === undefined ? {} : { probeOutcome }),
          });
          return true;
        }
        // The supplier response hook may replace the response (e.g. supply a
        // missing Content-Type), so the original upstream status and headers
        // are captured before it runs; in-stream error facts must record what
        // the supplier actually sent.
        // A probe whose upstream answered successfully is no longer bounded by
        // its lease: the lease stays held until this response settles it, and
        // only the client deadline still bounds the stream.
        if (lease !== undefined) {
          options.routeStates.holdProbe(lease);
          armDeadline([clientDeadline]);
        }
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
        const relayed = await raceAbort(relayResponse(repaired, response, {
          module, provider: resolved.provider, providers: options.providers,
          modelId: resolved.model.id, upstreamModel, publicModel, observer, sampler, translator,
        }), controller.signal);
        // Only a validated completed response restores health. An observed
        // in-stream error is classified first: a genuine fault fails a probe (with
        // its own classification) and is recorded on a plain call, while a
        // caller-benign frame (`content_filter`, an invalid request) releases a
        // probe neutrally and never poisons a route or backs it off.
        const validated = observer.succeeded();
        const streamFailure = relayed.observedError === undefined ? undefined : classifyStreamFailure(relayed.observedError);
        let streamState: RouteStatus | undefined;
        let probeOutcome: ProbeOutcome | undefined;
        if (lease !== undefined) {
          probeOutcome = validated ? 'success' : streamFailure === undefined ? 'cancelled' : 'failure';
          releaseLease(probeOutcome, streamFailure, originalStatus);
        } else if (validated) {
          options.routeStates.success(resolved.provider.id, resolved.model.id, guard);
        } else if (streamFailure !== undefined) {
          streamState = recordFault(streamFailure, originalStatus);
        }
        response.end();
        usage = observer.result();
        await finish({
          ...forwarded, status: repaired.status,
          ...(probeOutcome === undefined ? {} : { probeOutcome }),
          ...(streamState === undefined ? {} : { routeState: streamState.state, routeUntil: streamState.until, faultReason: streamState.faultKind, routePhase: streamState.phase }),
          // An official in-stream error after HTTP 200 is recorded with the
          // original `type`/`code` the protocol module observed, together with
          // the upstream's own retry hints; the HTTP status stays 200 because
          // that is what the supplier returned.
          ...(relayed.observedError ? { upstream: streamErrorFact(originalStatus, originalHeaders, relayed.observedError) } : {}),
          ...(sampler.sample() ?? {}), ...(usage ? { usage } : {}),
        });
      } catch (error) {
        // A timeout (the upstream deadline, or a stalled promise) is a route
        // fault; a cancellation (client disconnect, shutdown, caller abort) is
        // not, and must never be recorded as one.
        const timedOut = upstreamTimedOut;
        const aborted = controller.signal.aborted;
        // A deadline the client set and passed is a client-observed timeout, not
        // a plain cancellation, even though the Gateway only saw a disconnect.
        const clientTimedOut = aborted && clientDeadline !== undefined && options.now() >= clientDeadline;
        const routeTimedOut = timedOut || clientTimedOut;
        const status = aborted ? (routeTimedOut ? 504 : 499) : 502;
        let faultFact: Partial<GatewayRequestCompletedEvent> = {};
        if (lease !== undefined) {
          const outcome: ProbeOutcome = aborted && !routeTimedOut ? 'cancelled' : 'failure';
          releaseLease(outcome, outcome === 'failure' ? (routeTimedOut ? clientTimeoutFailure() : transportFailure()) : undefined, status);
          faultFact = { probeOutcome: outcome };
        } else if (!aborted || routeTimedOut) {
          const failure = routeTimedOut ? clientTimeoutFailure() : transportFailure();
          const state = recordFault(failure, status);
          faultFact = state === undefined ? {} : { routeState: state.state, routeUntil: state.until, faultReason: state.faultKind, routePhase: state.phase };
        }
        if (!response.headersSent) {
          const message = aborted ? (routeTimedOut ? 'Provider request timed out' : 'Request cancelled') : 'Provider request failed';
          json(response, status, gatewayErrorBody(module, status, message));
        } else {
          response.destroy();
        }
        await finish({ ...forwarded, status, ...faultFact, ...(usage ? { usage } : {}) });
      } finally {
        if (fetchTimer !== undefined) clearTimeout(fetchTimer);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        // Shutdown or any early exit still releases the probe lease.
        releaseLease();
        request.off('aborted', abort);
        response.off('close', onResponseClose);
        options.active.delete(controller);
      }
      return true;
    },
  };
}
