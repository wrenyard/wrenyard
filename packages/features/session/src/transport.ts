/**
 * Gateway transport shared by the session drivers.
 *
 * The protocol drivers (`driver.ts` for chat completions, `responses-driver.ts`
 * for Responses) only serialize a body and parse a response. This module owns
 * the exchange itself: local Gateway headers, failure classification and the
 * transport retry. A transient failure (network error, interrupted stream,
 * HTTP 5xx) is retried on the same route before any generated output; a route
 * state, a Gateway request error, any other 4xx and any failure after output
 * surface unchanged so the caller can decide whether to switch routes.
 */
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import { GATEWAY_HEADERS, parseGatewayRouteState, type GatewayRouteState } from '@wrenyard/providers/base';
import type { DriverRequest, DriverResult } from './driver.ts';

/** Only a non-2xx response body is ever truncated, so an upstream error stays readable. */
const ERROR_EXCERPT_CHARS = 2_000;

/** Waits after the first and second attempts; three attempts in total. */
const RETRY_DELAYS_MS = [3_000, 6_000] as const;

/** A failed Gateway response, with the Gateway's route classification. */
export class GatewayRequestError extends Error {
  readonly routeState?: GatewayRouteState;
  readonly routeUntil?: string;
  constructor(
    message: string,
    readonly status: number,
    route: { state?: GatewayRouteState; until?: string },
    /** The Gateway refused the request itself; retrying cannot help. */
    readonly requestError: boolean,
  ) {
    super(message);
    this.name = 'GatewayRequestError';
    if (route.state) this.routeState = route.state;
    if (route.until) this.routeUntil = route.until;
  }
}

/** A connection ended before a protocol completion marker arrived. */
export class IncompleteStreamError extends Error {
  constructor() { super('Model stream ended before the reply was complete'); this.name = 'IncompleteStreamError'; }
}

export interface GatewayExchange {
  connection: WrenyardGatewayConnection;
  fetch: typeof globalThis.fetch;
  url: string;
  /** Serializes the exact body; called once, before the first attempt. */
  body: () => string;
  maxBytes: number;
  /** Names the request in the byte-cap error. */
  label: string;
  read: (response: Response, request: DriverRequest) => Promise<DriverResult>;
}

/** Post one driver request to the Gateway under the shared retry policy. */
export async function postToGateway(exchange: GatewayExchange, request: DriverRequest): Promise<DriverResult> {
  if (!request.reasoningEffort) throw new Error('Model request requires reasoningEffort');
  if (request.signal.aborted) throw abortError();
  const body = exchange.body();
  const actualBytes = Buffer.byteLength(body, 'utf8');
  if (actualBytes > exchange.maxBytes) throw new Error(`${exchange.label} exceeds ${exchange.maxBytes} bytes: ${actualBytes}`);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${exchange.connection.token}`,
    [GATEWAY_HEADERS.reasoningEffort]: request.reasoningEffort,
    ...(request.role ? { [GATEWAY_HEADERS.callRole]: request.role } : {}),
    ...(request.sessionId ? { [GATEWAY_HEADERS.sessionId]: request.sessionId } : {}),
  };

  let outputStarted = false;
  const observed: DriverRequest = {
    ...request,
    onText: (delta) => { if (delta) outputStarted = true; request.onText?.(delta); },
    onReasoning: (delta) => { if (delta) outputStarted = true; request.onReasoning?.(delta); },
    onToolCall: (call) => { outputStarted = true; request.onToolCall?.(call); },
    onOutput: () => { outputStarted = true; request.onOutput?.(); },
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      let response: Response;
      try {
        response = await exchange.fetch(exchange.url, { method: 'POST', headers, body, signal: request.signal });
      } catch (error) {
        throw normalizeError(error, request.signal);
      }
      if (!response.ok) throw await gatewayResponseError(response);
      try {
        return await exchange.read(response, observed);
      } catch (error) {
        throw normalizeError(error, request.signal);
      }
    } catch (error) {
      if (outputStarted || attempt >= RETRY_DELAYS_MS.length || !isTransient(error, request.signal)) throw error;
      request.onTransportRetry?.();
      await retryDelay(RETRY_DELAYS_MS[attempt]!, request.signal);
    }
  }
}

async function gatewayResponseError(response: Response): Promise<GatewayRequestError> {
  const text = (await response.text().catch(() => '')).trim();
  const excerpt = text ? `: ${text.slice(0, ERROR_EXCERPT_CHARS)}` : '';
  return new GatewayRequestError(`Model request failed (HTTP ${response.status})${excerpt}`, response.status, {
    state: parseGatewayRouteState(response.headers.get(GATEWAY_HEADERS.routeState)),
    until: response.headers.get(GATEWAY_HEADERS.routeUntil) ?? undefined,
  }, response.headers.get(GATEWAY_HEADERS.requestError) === 'true');
}

function isTransient(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || isAbortError(error)) return false;
  if (error instanceof GatewayRequestError) return error.routeState === undefined && !error.requestError && error.status >= 500;
  if (error instanceof IncompleteStreamError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError'
    || /fetch failed|network|terminated|socket|connection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_/iu.test(error.message);
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Preserve an abort as an abort; rewrite anything else into a plain Error. */
export function normalizeError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return abortError();
  return error instanceof Error ? error : new Error(String(error));
}

export function abortError(): Error {
  const error = new Error('Model request was aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
