import type { ProviderDefinition } from '@wrenyard/providers/base';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { Catalog, GatewayProtocol, PublicGatewayModel } from '@wrenyard/providers/catalog';
import { upstreamAuthHeaders, type ProviderRuntime } from '@wrenyard/providers';
import { ResponseSampler, type ResponseTpsContract } from './response-tps.ts';

export interface GatewayRequestCompletedEvent {
  protocol: GatewayProtocol;
  publicModel?: string;
  provider?: string;
  status: number;
  durationMs: number;
  /** Scoped execution id attributed by the request path, when present. */
  executionId?: string;
  /** Response sampling contract used for this request, when sampled. */
  tps_sampling_contract?: 'tokenizer_v1';
  /** Attributable paired response samples for this request, when sampled. */
  tps_samples?: ResponseTpsContract['tps_samples'];
}

export interface GatewayConnection {
  openaiChatBaseUrl: string;
  openaiResponsesBaseUrl: string;
  anthropicBaseUrl: string;
  models: PublicGatewayModel[];
}

export interface ModelGatewayOptions {
  now?: () => number;
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

const CODEBUDDY_ROUND_TTL_MS = 30 * 60 * 1000;
const CODEBUDDY_ROUND_CACHE_LIMIT = 512;

interface CodeBuddyRound {
  conversationId: string;
  conversationRequestId: string;
  lastSeenMs: number;
}

/**
 * Splits an optional `/execution/<safe id>` scope out of a gateway request
 * path. Only a well-formed ASCII execution token (letters, digits, `_`, `-`,
 * max 128 chars) is accepted; the remaining path is resolved against the exact
 * known ROUTES set, so the execution segment is an attribution field and is
 * never forwarded upstream. A malformed scope yields undefined and the request
 * is not served, exactly as an unknown path.
 */
function parseScopedPath(pathname: string): { executionId?: string; routePath: string } | undefined {
  const match = /^\/gateway\/([^/]+)\/execution\/([^/]+)(\/v1\/.*)$/u.exec(pathname);
  if (!match) return { routePath: pathname };
  const executionId = match[2]!;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(executionId)) return undefined;
  const routePath = `/gateway/${match[1]!}${match[3]!}`;
  if (!ROUTES.has(routePath)) return undefined;
  return { executionId, routePath };
}

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

/** CodeBuddy ids are UUIDs with the dashes stripped. */
function codeBuddyId(): string {
  return randomUUID().replace(/-/gu, '');
}

/**
 * True when this request continues the current user turn rather than starting a
 * new one. The official client keeps one conversation request id for the whole
 * tool loop and only rotates it on a new user turn, so a trailing tool result -
 * or an assistant message that is still waiting on its tool calls - must reuse
 * the cached id.
 */
function codeBuddyContinuesTurn(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last)) return false;
  const entry = last as Record<string, unknown>;
  const role = typeof entry.role === 'string' ? entry.role : '';
  if (role === 'tool' || role === 'function') return true;
  if (role !== 'assistant') return false;
  return Array.isArray(entry.tool_calls) || entry.function_call !== undefined;
}

/**
 * Stable conversation key for round grouping. A scoped execution id is the
 * exact caller-supplied conversation scope; without one the conversation is
 * keyed by a digest of everything up to and including its first user message.
 * That prefix never changes while the tool loop and later turns append to the
 * same history, and it still separates two conversations that merely share a
 * system prompt. No message content is retained.
 */
function codeBuddyConversationKey(executionId: string | undefined, body: Record<string, unknown>): string {
  if (executionId !== undefined) return `execution:${executionId}`;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = messages.findIndex(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).role === 'user',
  );
  const prefix = messages.slice(0, firstUser >= 0 ? firstUser + 1 : 1);
  return `prefix:${createHash('sha256').update(JSON.stringify(prefix)).digest('hex')}`;
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
  sampler?: ResponseSampler,
): Promise<void> {
  if (!upstream.body) return;
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    sampler?.markNonStream();
    const text = await upstream.text();
    try {
      response.write(JSON.stringify(normalizeResponsePayload(JSON.parse(text), providers, context)));
    } catch {
      response.write(text);
    }
    return;
  }
  if (!contentType.includes('text/event-stream')) {
    sampler?.markNonStream();
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
      const text = decoder.decode(value, { stream: true });
      sampler?.feed(text);
      pending += text;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        response.write(`${normalizeSseLine(pending.slice(0, newline), providers, context)}\n`);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    const tail = decoder.decode();
    sampler?.feed(tail);
    sampler?.end();
    pending += tail;
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
  const codeBuddyRounds = new Map<string, CodeBuddyRound>();
  let closed = false;

  const emit = async (event: GatewayRequestCompletedEvent): Promise<void> => {
    try { await options.onRequestCompleted?.(event); } catch { /* stats must not fail inference */ }
  };

  /**
   * Conversation round identity for one CodeBuddy request. Entries expire so a
   * long-idle client starts a new round instead of being folded into a stale
   * one, and the map is bounded so an unbounded client population cannot grow
   * it without limit.
   */
  const codeBuddyRound = (key: string, continuesTurn: boolean, nowMs: number): CodeBuddyRound => {
    for (const [entryKey, entry] of codeBuddyRounds) {
      if (nowMs - entry.lastSeenMs > CODEBUDDY_ROUND_TTL_MS) codeBuddyRounds.delete(entryKey);
    }
    const existing = codeBuddyRounds.get(key);
    const round: CodeBuddyRound = existing !== undefined
      ? {
          conversationId: existing.conversationId,
          conversationRequestId: continuesTurn ? existing.conversationRequestId : codeBuddyId(),
          lastSeenMs: nowMs,
        }
      : { conversationId: codeBuddyId(), conversationRequestId: codeBuddyId(), lastSeenMs: nowMs };
    // Re-inserting refreshes the key's position, so the size trim below evicts
    // the least recently used conversation rather than the oldest one still in
    // active use.
    codeBuddyRounds.delete(key);
    codeBuddyRounds.set(key, round);
    while (codeBuddyRounds.size > CODEBUDDY_ROUND_CACHE_LIMIT) {
      const oldest = codeBuddyRounds.keys().next();
      if (oldest.done || oldest.value === key) break;
      codeBuddyRounds.delete(oldest.value);
    }
    return round;
  };

  return {
    async handle(request, response) {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const scoped = parseScopedPath(pathname);
      if (!scoped) return false;
      const route = ROUTES.get(scoped.routePath);
      if (!route) return false;
      const executionId = scoped.executionId;
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
        await emit({ protocol: route.protocol, status, durationMs: Date.now() - startedAt, executionId });
        return true;
      }
      if (typeof body.model !== 'string') {
        json(response, 400, { error: { type: 'invalid_request_error', message: 'model must be a provider/model string' } });
        await emit({ protocol: route.protocol, status: 400, durationMs: Date.now() - startedAt, executionId });
        return true;
      }

      let publicModel = body.model;
      let resolved;
      try { resolved = options.catalog.resolveGatewayModel(route.protocol, publicModel); } catch (error) {
        json(response, 404, { error: { type: 'not_found_error', message: error instanceof Error ? error.message : 'Unknown model' } });
        await emit({ protocol: route.protocol, publicModel, status: 404, durationMs: Date.now() - startedAt, executionId });
        return true;
      }
      publicModel = resolved.publicId;
      const credential = await options.providers.credential(resolved.provider);
      if (!credential) {
        json(response, 503, { error: { type: 'credential_unavailable', message: `Provider ${resolved.provider.id} is not configured` } });
        await emit({ protocol: route.protocol, publicModel, provider: resolved.provider.id, status: 503, durationMs: Date.now() - startedAt, executionId });
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

      // CodeBuddy counts one user turn - including its whole tool loop - as a
      // single usage record, keyed off the official client's product identity
      // and conversation round headers. Reproducing them here keeps a Gateway
      // client billed like the official CLI instead of once per HTTP request.
      if (resolved.provider.id === 'codebuddy' && route.protocol === 'openai_chat') {
        const identity = await options.providers.codeBuddyClientIdentity?.(resolved.provider);
        if (identity) {
          const incomingAgent = headers.get('user-agent');
          const version = identity.version;
          const agent = [`${identity.platform}/${version}`, `${identity.productName}/${version}`, incomingAgent]
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join(' ');
          headers.set('user-agent', agent);
          headers.set('x-product', identity.deploymentType);
          headers.set('x-ide-type', identity.platform);
          headers.set('x-ide-name', identity.platform);
          headers.set('x-ide-version', version);
        }
        headers.set('x-requested-with', 'XMLHttpRequest');
        headers.set('x-agent-intent', 'craft');
        const round = codeBuddyRound(
          codeBuddyConversationKey(executionId, body),
          codeBuddyContinuesTurn(body),
          options.now?.() ?? Date.now(),
        );
        const messageId = codeBuddyId();
        headers.set('x-conversation-id', round.conversationId);
        headers.set('x-conversation-request-id', round.conversationRequestId);
        headers.set('x-conversation-message-id', messageId);
        headers.set('x-request-id', messageId);
      }

      // OpenRouter free requests must not carry a model fallback list or route
      // object, which would let the client select a paid model. The exact free
      // model id is preserved; no fallback, retry, or substitution is added.
      if (resolved.provider.id === 'openrouter') {
        delete body.models;
        delete body.route;
      }

      // OpenAI chat streaming requests must report final usage so clients keep
      // receiving the provider's official billing numbers. Speed sampling no
      // longer depends on it. The flag is added only for streamed chat
      // requests; every other field is preserved exactly and no token values
      // are invented.
      if (route.protocol === 'openai_chat' && body.stream === true) {
        const existing = body.stream_options;
        body.stream_options = {
          ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {}),
          include_usage: true,
        };
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
        // Raw SSE is observed before model normalization so the sampler sees
        // the upstream wire bytes; the sample model is normalized to the
        // requested canonical public model.
        const sampler = new ResponseSampler({
          now: options.now,
          normalizeModel: (model) => options.providers.publicResponseModel(resolved.provider, model, upstreamModel, publicModel),
        });
        await writeNormalizedResponse(upstream, response, options.providers, {
          protocol: route.protocol,
          provider: resolved.provider,
          upstreamModel,
          publicModel,
        }, sampler);
        response.end();
        await emit({
          protocol: route.protocol,
          publicModel,
          provider: resolved.provider.id,
          status: upstream.status,
          durationMs: Date.now() - startedAt,
          ...(executionId ? { executionId } : {}),
          ...(sampler.sample() ?? {}),
        });
      } catch (error) {
        if (!response.headersSent) {
          json(response, controller.signal.aborted ? 499 : 502, { error: { type: 'upstream_error', message: controller.signal.aborted ? 'Request cancelled' : 'Provider request failed' } });
        } else {
          response.destroy();
        }
        await emit({ protocol: route.protocol, publicModel, provider: resolved.provider.id, status: controller.signal.aborted ? 499 : 502, durationMs: Date.now() - startedAt, executionId });
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
      codeBuddyRounds.clear();
    },
  };
}
