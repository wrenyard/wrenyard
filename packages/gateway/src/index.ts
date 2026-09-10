import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Catalog, GatewayProtocol, ProviderDefinition, PublicGatewayModel } from '@wrenyard/catalog';
import { upstreamAuthHeaders, type ProviderRuntime } from '@wrenyard/providers';

export interface GatewayRequestCompletedEvent {
  protocol: GatewayProtocol;
  publicModel?: string;
  provider?: string;
  status: number;
  durationMs: number;
}

export interface GatewayConnection {
  openaiChatBaseUrl: string;
  openaiResponsesBaseUrl: string;
  anthropicBaseUrl: string;
  models: PublicGatewayModel[];
}

export interface ModelGatewayOptions {
  catalog: Catalog;
  providers: ProviderRuntime;
  fetch?: typeof globalThis.fetch;
  onRequestCompleted?: (event: GatewayRequestCompletedEvent) => void | Promise<void>;
}

export interface ModelGateway {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  connection(origin: string): Promise<GatewayConnection>;
  close(): Promise<void>;
}

interface GatewayRoute {
  protocol: GatewayProtocol;
  kind: 'models' | 'inference';
}

const ROUTES = new Map<string, GatewayRoute>([
  ['/gateway/openai-chat/v1/models', { protocol: 'openai_chat', kind: 'models' }],
  ['/gateway/openai-chat/v1/chat/completions', { protocol: 'openai_chat', kind: 'inference' }],
  ['/gateway/openai-responses/v1/models', { protocol: 'openai_responses', kind: 'models' }],
  ['/gateway/openai-responses/v1/responses', { protocol: 'openai_responses', kind: 'inference' }],
  ['/gateway/anthropic/v1/models', { protocol: 'anthropic_messages', kind: 'models' }],
  ['/gateway/anthropic/v1/messages', { protocol: 'anthropic_messages', kind: 'inference' }],
]);

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
  'anthropic-version', 'content-type', 'openai-beta', 'user-agent', 'x-stainless-arch',
  'x-stainless-lang', 'x-stainless-os', 'x-stainless-package-version', 'x-stainless-retry-count',
  'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-timeout',
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'cache-control', 'content-type', 'openai-organization', 'openai-processing-ms',
  'openai-version', 'request-id', 'x-request-id',
  // Preserved for all providers so native clients observe 429 boundaries.
  'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
]);
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
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
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
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

// Returns a validated incoming OpenCode session id, or undefined. The value
// must be a single non-empty token of <=256 chars with no CRLF, so it cannot
// smuggle extra header lines into the upstream request. The OpenCode driver
// injects this header locally; we forward it only to OpenCode service providers.
function openCodeSessionHeader(headers: IncomingHttpHeaders): string | undefined {
  const value = headers['x-opencode-session'];
  if (value === undefined || Array.isArray(value)) return undefined;
  if (value.length === 0 || value.length > 256) return undefined;
  if (value.includes('\r') || value.includes('\n')) return undefined;
  return value;
}

interface ResponseModelContext {
  protocol: GatewayProtocol;
  provider: ProviderDefinition;
  upstreamModel: string;
  publicModel: string;
}

function normalizeModelField(
  value: Record<string, unknown>,
  key: string,
  providers: ProviderRuntime,
  context: ResponseModelContext,
): void {
  const model = value[key];
  if (typeof model !== 'string') return;
  value[key] = providers.publicResponseModel(
    context.provider,
    model,
    context.upstreamModel,
    context.publicModel,
  );
}

function responseObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeResponsePayload(
  payload: unknown,
  providers: ProviderRuntime,
  context: ResponseModelContext,
): unknown {
  const root = responseObject(payload);
  if (!root) return payload;
  normalizeModelField(root, 'model', providers, context);
  if (context.protocol === 'openai_responses') {
    const nested = responseObject(root.response);
    if (nested) normalizeModelField(nested, 'model', providers, context);
  }
  if (context.protocol === 'anthropic_messages') {
    const nested = responseObject(root.message);
    if (nested) normalizeModelField(nested, 'model', providers, context);
  }
  return payload;
}

function normalizeSseLine(
  line: string,
  providers: ProviderRuntime,
  context: ResponseModelContext,
): string {
  const match = /^(data:\s*)(.*?)(\r?)$/u.exec(line);
  if (!match || match[2] === '[DONE]') return line;
  try {
    const payload = normalizeResponsePayload(JSON.parse(match[2]!), providers, context);
    return `${match[1]}${JSON.stringify(payload)}${match[3]}`;
  } catch {
    return line;
  }
}

async function writeNormalizedResponse(
  upstream: Response,
  response: ServerResponse,
  providers: ProviderRuntime,
  context: ResponseModelContext,
): Promise<void> {
  if (!upstream.body) return;
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    const text = await upstream.text();
    try {
      response.write(JSON.stringify(normalizeResponsePayload(JSON.parse(text), providers, context)));
    } catch {
      response.write(text);
    }
    return;
  }
  if (!contentType.includes('text/event-stream')) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        response.write(`${normalizeSseLine(pending.slice(0, newline), providers, context)}\n`);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending) response.write(normalizeSseLine(pending, providers, context));
  } finally {
    reader.releaseLock();
  }
}

async function availableModels(catalog: Catalog, providers: ProviderRuntime, protocol: GatewayProtocol): Promise<PublicGatewayModel[]> {
  const available = new Set<string>();
  await Promise.all(catalog.providers().map(async (provider) => {
    if (await providers.credential(provider)) available.add(provider.id);
  }));
  return catalog.listGatewayModels(protocol, (provider) => available.has(provider.id));
}

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const active = new Set<AbortController>();
  let closed = false;

  const emit = async (event: GatewayRequestCompletedEvent): Promise<void> => {
    try { await options.onRequestCompleted?.(event); } catch { /* stats must not fail inference */ }
  };

  return {
    async handle(request, response) {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const route = ROUTES.get(pathname);
      if (!route) return false;
      const startedAt = Date.now();
      if (closed) {
        json(response, 503, { error: { type: 'gateway_unavailable', message: 'Model Gateway is stopping' } });
        return true;
      }
      if (route.kind === 'models') {
        if (request.method !== 'GET') {
          json(response, 405, { error: { type: 'method_not_allowed', message: 'Method not allowed' } });
          return true;
        }
        const models = await availableModels(options.catalog, options.providers, route.protocol);
        const data = models.map((entry) => ({ id: entry.publicId, object: 'model', owned_by: entry.provider, display_name: entry.displayName, context_window: entry.contextWindow, max_tokens: entry.maxTokens }));
        json(response, 200, route.protocol === 'anthropic_messages'
          ? { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }
          : { object: 'list', data });
        await emit({ protocol: route.protocol, status: 200, durationMs: Date.now() - startedAt });
        return true;
      }
      if (request.method !== 'POST') {
        json(response, 405, { error: { type: 'method_not_allowed', message: 'Method not allowed' } });
        return true;
      }

      let body: Record<string, unknown>;
      try { body = await readJson(request); } catch (error) {
        const status = error instanceof Error && error.message === 'request_too_large' ? 413 : 400;
        json(response, status, { error: { type: 'invalid_request_error', message: status === 413 ? 'Request body too large' : 'Request body must be a JSON object' } });
        await emit({ protocol: route.protocol, status, durationMs: Date.now() - startedAt });
        return true;
      }
      if (typeof body.model !== 'string') {
        json(response, 400, { error: { type: 'invalid_request_error', message: 'model must be a provider/model string' } });
        await emit({ protocol: route.protocol, status: 400, durationMs: Date.now() - startedAt });
        return true;
      }

      let publicModel = body.model;
      let resolved;
      try { resolved = options.catalog.resolveGatewayModel(route.protocol, publicModel); } catch (error) {
        json(response, 404, { error: { type: 'not_found_error', message: error instanceof Error ? error.message : 'Unknown model' } });
        await emit({ protocol: route.protocol, publicModel, status: 404, durationMs: Date.now() - startedAt });
        return true;
      }
      publicModel = resolved.publicId;
      const credential = await options.providers.credential(resolved.provider);
      if (!credential) {
        json(response, 503, { error: { type: 'credential_unavailable', message: `Provider ${resolved.provider.id} is not configured` } });
        await emit({ protocol: route.protocol, publicModel, provider: resolved.provider.id, status: 503, durationMs: Date.now() - startedAt });
        return true;
      }

      const headers = upstreamHeaders(request.headers);
      upstreamAuthHeaders(resolved.provider, credential, route.protocol).forEach((value, name) => headers.set(name, value));
      const upstreamModel = options.providers.resolveUpstreamModel(resolved.provider, resolved.upstreamModel, credential);
      body.model = upstreamModel;

      // OpenCode service providers require the stable OpenCode User-Agent and
      // the forwarded session header. Other providers are left untouched and
      // never receive these identity values.
      if (resolved.provider.id === 'opencode-zen' || resolved.provider.id === 'opencode-go') {
        headers.set('user-agent', 'wrenyard');
        const session = openCodeSessionHeader(request.headers);
        if (session) headers.set('x-opencode-session', session);
      }

      // OpenRouter free requests must not carry a model fallback list or route
      // object, which would let the client select a paid model. The exact free
      // model id is preserved; no fallback, retry, or substitution is added.
      if (resolved.provider.id === 'openrouter') {
        delete body.models;
        delete body.route;
      }
      const controller = new AbortController();
      active.add(controller);
      const abort = () => controller.abort();
      request.once('aborted', abort);
      try {
        const upstream = await fetchImpl(resolved.capability.endpoint, {
          method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        });
        const responseHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, name) => {
          if (RESPONSE_HEADER_ALLOWLIST.has(name)) responseHeaders[name] = value;
        });
        response.writeHead(upstream.status, responseHeaders);
        await writeNormalizedResponse(upstream, response, options.providers, {
          protocol: route.protocol,
          provider: resolved.provider,
          upstreamModel,
          publicModel,
        });
        response.end();
        await emit({ protocol: route.protocol, publicModel, provider: resolved.provider.id, status: upstream.status, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (!response.headersSent) {
          json(response, controller.signal.aborted ? 499 : 502, { error: { type: 'upstream_error', message: controller.signal.aborted ? 'Request cancelled' : 'Provider request failed' } });
        } else {
          response.destroy();
        }
        await emit({ protocol: route.protocol, publicModel, provider: resolved.provider.id, status: controller.signal.aborted ? 499 : 502, durationMs: Date.now() - startedAt });
      } finally {
        request.off('aborted', abort);
        active.delete(controller);
      }
      return true;
    },

    async connection(origin) {
      const root = origin.replace(/\/$/, '');
      return {
        openaiChatBaseUrl: `${root}/gateway/openai-chat/v1`,
        openaiResponsesBaseUrl: `${root}/gateway/openai-responses/v1`,
        anthropicBaseUrl: `${root}/gateway/anthropic/v1`,
        models: await availableModels(options.catalog, options.providers, 'openai_chat'),
      };
    },

    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      active.clear();
    },
  };
}
