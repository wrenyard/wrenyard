import { randomUUID } from 'node:crypto';
import type { ProviderDefinition } from '../base/index.ts';
import type { ProviderRequestHookContext, ProviderResponseHookContext, ProviderResponseHookResult } from '../base/contracts.ts';
import type { ProviderCredential } from '../base/provider.ts';

/**
 * The stable Codex wire identity the ChatGPT subscription endpoint accepts.
 * Used only for openai_responses forwarding; native Codex runs keep their own
 * installed client identity.
 */
const CHATGPT_CODEX_USER_AGENT = 'codex-tui/0.154.0';

/** ChatGPT access token plus account id, as returned by the injected client reader. */
export interface ChatGptGatewayCredential {
  readonly accessToken: string;
  readonly accountId: string;
}

/**
 * Injected Codex auth callbacks. Implemented by @wrenyard/client-codex and wired
 * by the daemon; the providers package never performs a login or a token
 * refresh of its own.
 */
export interface ChatGptGatewayAuthAdapter {
  read(): Promise<ChatGptGatewayCredential>;
  refresh(credential: ChatGptGatewayCredential, signal: AbortSignal): Promise<ChatGptGatewayCredential>;
}

// Bind the ChatGPT account id to the exact credential object that supplied it,
// so a credential loaded for another provider can never be mistaken for
// ChatGPT, and no account identity is copied into a provider definition or an
// event output.
const chatGptAccountIds = new WeakMap<ProviderCredential, string>();

/** Bind a loaded ChatGPT credential to its account id. */
export function bindChatGptGatewayCredential(credential: ProviderCredential, accountId: string): void {
  chatGptAccountIds.set(credential, accountId);
}

/** The account id bound to a loaded ChatGPT credential, if any. */
export function chatGptGatewayAccountId(credential: ProviderCredential): string | undefined {
  return chatGptAccountIds.get(credential);
}

/**
 * Add the ChatGPT subscription headers for a bound credential. The Bearer token
 * is the provider credential value; the account id comes only from the WeakMap
 * binding, so an unbound credential produces no ChatGPT identity. This is a
 * no-op for every other provider, credential resolver, or protocol, so no
 * ChatGPT header can leak cross-provider.
 */
export function applyChatGptNativeHeaders(
  headers: Headers,
  provider: Pick<ProviderDefinition, 'id' | 'credentialResolver'>,
  credential: ProviderCredential,
  protocol: string,
): void {
  if (provider.id !== 'chatgpt' || provider.credentialResolver !== 'codex' || protocol !== 'openai_responses') return;
  const accountId = chatGptAccountIds.get(credential);
  if (accountId === undefined || credential.value === '') return;
  headers.set('authorization', `Bearer ${credential.value}`);
  headers.set('chatgpt-account-id', accountId);
  headers.set('originator', 'codex-tui');
  headers.set('accept', 'text/event-stream');
  headers.set('content-type', 'application/json');
  headers.set('session_id', randomUUID());
  headers.set('user-agent', CHATGPT_CODEX_USER_AGENT);
}

/**
 * The subscription endpoint keys its prompt cache on the `session_id` header
 * and ignores the body's `prompt_cache_key`. Carry a caller-supplied key into
 * the header so requests sharing a prefix reuse the cache; without a key the
 * per-request random id set above stays.
 */
export function applyChatGptPromptCacheKey(headers: Headers, body: Record<string, unknown>): void {
  const key = body.prompt_cache_key;
  if (typeof key === 'string' && key !== '') headers.set('session_id', key);
}

/**
 * Pin the ChatGPT subscription wire contract on an openai_responses request:
 * the endpoint accepts only streamed turns, never persists them, and keys its
 * prompt cache on the `session_id` header rather than the body's
 * `prompt_cache_key`. Every other field, instruction, and content part is left
 * exactly as delivered.
 */
export function chatGptBeforeRequest(context: ProviderRequestHookContext): void {
  if (context.protocol !== 'openai_responses') return;
  context.body.stream = true;
  context.body.store = false;
  applyChatGptPromptCacheKey(context.headers, context.body);
}

/**
 * The subscription endpoint can omit Content-Type on a valid SSE response. Its
 * streamed Responses contract supplies the missing type for both Gateway
 * normalization and downstream stream readers.
 */
export function chatGptAfterResponse(context: ProviderResponseHookContext): ProviderResponseHookResult | undefined {
  if (context.protocol !== 'openai_responses') return undefined;
  const response = context.response;
  if (!response || !response.ok || response.headers.get('content-type')) return undefined;
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  return {
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  };
}
