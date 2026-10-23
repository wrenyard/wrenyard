import { createHash, randomUUID } from 'node:crypto';
import type {
  ProviderDefinition,
  ProviderRequestHookContext,
  ProviderResponseHookContext,
  ProviderResponseHookResult,
} from '../base/index.ts';
import { resolveCodeBuddyProductModelId, type CodeBuddyModels } from './models.ts';
import { codeBuddyProtocolError } from './route-errors.ts';
import type { CodeBuddyEnvironment, CodeBuddyProductModelEntry } from './product.ts';

export type { CodeBuddyEnvironment };

export interface CodeBuddyClientIdentity {
  readonly platform: string;
  readonly productName: string;
  readonly version: string;
  readonly deploymentType: string;
}

export interface CodeBuddyCredential {
  value: string;
}

export interface CodeBuddyFreeSupplyFact {
  readonly confirmedFree: true
  readonly source: string
  readonly ruleId: string
}

export interface CodeBuddyActiveSnapshot {
  readonly provider: 'codebuddy'
  readonly credential: CodeBuddyCredential
  readonly environment: CodeBuddyEnvironment
  readonly stableScope: string | undefined
  resolveUpstreamModel(model: string): string
  freeSupply(model: string): CodeBuddyFreeSupplyFact | undefined
}

/** Product and account facts supplied by the composition root. This module does not read the install. */
export interface CodeBuddyProviderProduct {
  readonly status: 'ready' | 'unavailable';
  /**
   * Safe, actionable discovery reason from the install read (for example
   * 'configuration request timed out'). Distinct from credential presence and
   * route availability so an unavailable catalog still explains itself.
   */
  readonly reason?: string;
  readonly environment: CodeBuddyEnvironment;
  readonly entries: readonly CodeBuddyProductModelEntry[];
  readonly identity?: CodeBuddyClientIdentity;
  /**
   * The startup account read once by the composition root. When a loadAccount
   * loader is supplied to createCodeBuddyRuntime this is only the initial and
   * fallback value; otherwise it is the account every read resolves to.
   */
  readonly account?: {
    readonly accessToken: string;
    readonly domain?: string;
    readonly stableScope?: string;
    readonly headers?: Readonly<Record<string, string>>;
  };
}

function createModelRouting(state: CodeBuddyModels) {
  // The offered endpoint ids. The endpoint's own row id is the offering id, so
  // an observed id equal to one of them needs no mapping at all.
  const offeringIds: ReadonlySet<string> = new Set(state.definition.models.map((entry) => entry.id));

  /**
   * The exact spelling the endpoint declares for an offered row. The mapping is
   * fixed by the selected endpoint entries, never by the active environment or
   * credential: a real endpoint row is by itself evidence for the wire spelling,
   * so it applies to native dispatch, gateway dispatch and observed-id
   * normalization alike, and an unlisted id is identity.
   */
  function codeBuddyUpstreamWireModel(model: string): string {
    return state.upstreamModels[model] ?? model;
  }

  /**
   * Reverse an observed wire spelling onto the offering it names. An observed
   * endpoint id is already the offering id; otherwise the provider's published
   * alias map (current wire ids plus historical spellings) is consulted, and a
   * product-id resolution is used only when it lands on an actually offered row.
   * Any other observed id stays itself, so an unregistered endpoint model is
   * never renamed onto something the account cannot run.
   */
  function canonicalizeCodeBuddyObservedModelId(model: string): string {
    if (offeringIds.has(model)) return model;
    const aliased = state.definition.modelAliases?.[model];
    if (aliased !== undefined) return aliased;
    const canonical = resolveCodeBuddyProductModelId(model);
    return canonical !== undefined && offeringIds.has(canonical) ? canonical : model;
  }

  function evaluateCodeBuddyFreeSupply(
    environment: CodeBuddyEnvironment | undefined,
    model: string,
  ): CodeBuddyFreeSupplyFact | undefined {
    if (environment !== 'ioa') return undefined;
    const wireModel = codeBuddyUpstreamWireModel(model);
    const definition = state.definition.models.find((entry) => codeBuddyUpstreamWireModel(entry.id) === wireModel);
    if (definition?.free !== true) return undefined;
    return {
      confirmedFree: true,
      source: 'codebuddy.credential_environment',
      ruleId: 'codebuddy.verified_hy_model_confirmed_free',
    };
  }

  return { codeBuddyUpstreamWireModel, evaluateCodeBuddyFreeSupply, canonicalizeCodeBuddyObservedModelId };
}

const codeBuddyNativeHeaders = new WeakMap<CodeBuddyCredential, Readonly<Record<string, string>>>();
const CODEBUDDY_NATIVE_HEADER_NAMES = ['X-User-Id', 'X-Enterprise-Id', 'X-Tenant-Id', 'X-Domain'] as const;

function freezeCodeBuddyActiveSnapshot(
  credential: CodeBuddyCredential,
  environment: CodeBuddyEnvironment,
  stableScope: string | undefined,
  routing: ReturnType<typeof createModelRouting>,
): CodeBuddyActiveSnapshot {
  const frozenCredential = Object.freeze(credential);
  return Object.freeze({
    provider: 'codebuddy',
    credential: frozenCredential,
    environment,
    stableScope,
    resolveUpstreamModel(model: string): string {
      return routing.codeBuddyUpstreamWireModel(model);
    },
    freeSupply(model: string): CodeBuddyFreeSupplyFact | undefined {
      return routing.evaluateCodeBuddyFreeSupply(environment, model);
    },
  });
}

export function applyCodeBuddyNativeHeaders(
  headers: Headers,
  provider: Pick<ProviderDefinition, 'id' | 'credentialResolver'>,
  credential: CodeBuddyCredential,
  protocol: string,
): void {
  if (
    provider.id !== 'codebuddy' ||
    provider.credentialResolver !== 'codebuddy' ||
    (protocol !== 'openai_chat' && protocol !== 'anthropic_messages')
  ) return;
  const nativeHeaders = codeBuddyNativeHeaders.get(credential);
  if (!nativeHeaders) return;
  for (const name of CODEBUDDY_NATIVE_HEADER_NAMES) {
    const value = nativeHeaders[name];
    if (value !== undefined) headers.set(name, value);
  }
}

/** Conversation round identity of one user turn; see {@link codeBuddyRound}. */
interface CodeBuddyRound {
  conversationId: string;
  conversationRequestId: string;
  lastSeenMs: number;
}

const CODEBUDDY_ROUND_TTL_MS = 30 * 60 * 1000;
const CODEBUDDY_ROUND_CACHE_LIMIT = 512;

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
/** True when a Messages content array carries a block of the given type. */
function hasBlock(entry: Record<string, unknown>, type: string): boolean {
  const content = entry.content;
  return Array.isArray(content) && content.some(
    (block) =>
      block !== null &&
      typeof block === 'object' &&
      !Array.isArray(block) &&
      (block as Record<string, unknown>).type === type,
  );
}

function codeBuddyContinuesTurn(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last)) return false;
  const entry = last as Record<string, unknown>;
  const role = typeof entry.role === 'string' ? entry.role : '';
  if (role === 'tool' || role === 'function') return true;
  if (role === 'user') return hasBlock(entry, 'tool_result');
  if (role !== 'assistant') return false;
  return Array.isArray(entry.tool_calls) || entry.function_call !== undefined || hasBlock(entry, 'tool_use');
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
  // Chat and Messages bodies encode the same conversation differently (role
  // 'tool' rows and tool_calls versus content blocks), so the digest keys on
  // the request's shape: a Messages-shaped prefix cannot collide with the
  // identical logical history sent through the Chat endpoint.
  const messagesShaped = prefix.some(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      Array.isArray((entry as Record<string, unknown>).content),
  );
  const shape = messagesShaped ? 'messages' : 'chat';
  return `prefix:${createHash('sha256').update(`${shape}:${JSON.stringify(prefix)}`).digest('hex')}`;
}

type CodeBuddyProviderAccount = NonNullable<CodeBuddyProviderProduct['account']>;

export function createCodeBuddyRuntime(
  product: CodeBuddyProviderProduct | undefined,
  state: CodeBuddyModels,
  loadAccount?: (environment: CodeBuddyEnvironment) => Promise<CodeBuddyProviderProduct['account'] | undefined>,
  discover?: () => Promise<CodeBuddyProviderProduct | undefined>,
) {
  const routing = createModelRouting(state);
  // Readiness is current state, re-evaluated by sync() on a fresh discovery
  // rather than frozen at construction: a startup-unavailable product does not
  // permanently lock this instance's catalog.
  let ready = product?.status === 'ready' ? product : undefined;
  let discoveryReason: string | undefined = ready ? undefined : product?.reason;
  let environment = ready?.environment ?? 'unknown';
  const environments = new WeakMap<CodeBuddyCredential, CodeBuddyEnvironment>();
  // The last resolved credential/account pair. It starts from the product
  // snapshot account and is refreshed by the loader; a loader failure keeps the
  // last good pair so a transient unreadable auth file never drops a signed-in
  // credential.
  let last: { credential: CodeBuddyCredential; account: CodeBuddyProviderAccount } | undefined;
  function bind(account: CodeBuddyProviderAccount): { credential: CodeBuddyCredential; account: CodeBuddyProviderAccount } {
    // Credential object identity tracks the token value: an unchanged token
    // reuses the exact frozen object (and its registered environment) while
    // still rebinding account.headers onto it, a rotated token mints a new one.
    if (last && last.credential.value === account.accessToken) {
      // A reused credential still tracks the current environment so an
      // environment switch under the same token rescopes free-supply/quota.
      environments.set(last.credential, environment);
      if (account.headers) codeBuddyNativeHeaders.set(last.credential, account.headers);
      return { credential: last.credential, account };
    }
    const credential = Object.freeze({ value: account.accessToken });
    environments.set(credential, environment);
    if (account.headers) codeBuddyNativeHeaders.set(credential, account.headers);
    return { credential, account };
  }
  const startupAccount = ready?.account;
  if (startupAccount?.accessToken) last = bind(startupAccount);
  /**
   * Apply a freshly discovered product snapshot: readiness, the safe discovery
   * reason, the environment and the snapshot account all move together so a
   * recovered install republishes its catalog without recreating the runtime.
   */
  function sync(next: CodeBuddyProviderProduct | undefined): void {
    ready = next?.status === 'ready' ? next : undefined;
    discoveryReason = ready ? undefined : next?.reason;
    environment = ready?.environment ?? 'unknown';
    last = ready?.account?.accessToken ? bind(ready.account) : undefined;
    state.publish(ready?.entries ?? [], environment);
  }
  /**
   * Run the injected discovery again and publish the result: install,
   * account, environment and the `/v3/config` model list are re-read together,
   * so a previously failed startup discovery recovers without a restart. The
   * whole snapshot is applied at once, so an account/environment change never
   * reuses the old model mappings or quota scope.
   */
  async function refresh(): Promise<void> {
    if (!discover) return;
    sync(await discover());
  }
  /**
   * Resolve the current account on every call. With no loader the startup
   * account is used; with a loader a rotated token is picked up immediately, a
   * loader error keeps the last resolved pair, and an undefined/empty result
   * clears the remembered pair so a later loader error cannot fall back to a
   * signed-out account's old token.
   */
  async function current(): Promise<{ credential: CodeBuddyCredential; account: CodeBuddyProviderAccount } | undefined> {
    if (!loadAccount) return last;
    let account: CodeBuddyProviderProduct['account'];
    try {
      account = await loadAccount(environment);
    } catch {
      return last;
    }
    if (!account?.accessToken) {
      last = undefined;
      return undefined;
    }
    last = bind(account);
    return last;
  }

  /**
   * Conversation round identity for one CodeBuddy request. Entries expire so a
   * long-idle client starts a new round instead of being folded into a stale
   * one, and the map is bounded so an unbounded client population cannot grow
   * it without limit. The cache lives with the supplier runtime, not the
   * Gateway.
   */
  const rounds = new Map<string, CodeBuddyRound>();
  const round = (key: string, continuesTurn: boolean, nowMs: number): CodeBuddyRound => {
    for (const [entryKey, entry] of rounds) {
      if (nowMs - entry.lastSeenMs > CODEBUDDY_ROUND_TTL_MS) rounds.delete(entryKey);
    }
    const existing = rounds.get(key);
    const next: CodeBuddyRound = existing !== undefined
      ? {
          conversationId: existing.conversationId,
          conversationRequestId: continuesTurn ? existing.conversationRequestId : codeBuddyId(),
          lastSeenMs: nowMs,
        }
      : { conversationId: codeBuddyId(), conversationRequestId: codeBuddyId(), lastSeenMs: nowMs };
    // Re-inserting refreshes the key's position, so the size trim below evicts
    // the least recently used conversation rather than the oldest one still in
    // active use.
    rounds.delete(key);
    rounds.set(key, next);
    while (rounds.size > CODEBUDDY_ROUND_CACHE_LIMIT) {
      const oldest = rounds.keys().next();
      if (oldest.done || oldest.value === key) break;
      rounds.delete(oldest.value);
    }
    return next;
  };

  return {
    canonicalizeModel: routing.canonicalizeCodeBuddyObservedModelId,
    /**
     * Reproduce the official client's Chat Completions identity: product
     * headers, the requested-with marker, and the per-turn conversation round
     * headers. The Gateway calls this generically through the provider hook and
     * never knows these headers are CodeBuddy-specific.
     */
    async beforeRequest(context: ProviderRequestHookContext): Promise<void> {
      if (context.protocol !== 'openai_chat' && context.protocol !== 'anthropic_messages') return;
      // The /v2/chat/completions upstream accepts only a string tool_choice and rejects the object form.
      // The Messages endpoint keeps its native tool_choice structure, so this rewrite stays Chat-only.
      if (context.protocol === 'openai_chat' && context.body.tool_choice !== null && typeof context.body.tool_choice === 'object') {
        context.body.tool_choice = 'required';
      }
      if (ready?.identity) {
        const identity = ready.identity;
        const incomingAgent = context.headers.get('user-agent');
        const version = identity.version;
        const agent = [`${identity.platform}/${version}`, `${identity.productName}/${version}`, incomingAgent]
          .filter((part): part is string => typeof part === 'string' && part.length > 0)
          .join(' ');
        context.headers.set('user-agent', agent);
        context.headers.set('x-product', identity.deploymentType);
        context.headers.set('x-ide-type', identity.platform);
        context.headers.set('x-ide-name', identity.platform);
        context.headers.set('x-ide-version', version);
      }
      context.headers.set('x-requested-with', 'XMLHttpRequest');
      context.headers.set('x-agent-intent', 'craft');
      const next = round(
        codeBuddyConversationKey(context.executionId, context.body),
        codeBuddyContinuesTurn(context.body),
        context.nowMs,
      );
      const messageId = codeBuddyId();
      context.headers.set('x-conversation-id', next.conversationId);
      context.headers.set('x-conversation-request-id', next.conversationRequestId);
      context.headers.set('x-conversation-message-id', messageId);
      context.headers.set('x-request-id', messageId);
    },
    /** Correct only the CodeBuddy departures from the official Chat contract. */
    afterResponse(context: ProviderResponseHookContext): ProviderResponseHookResult | undefined {
      if ((context.protocol !== 'openai_chat' && context.protocol !== 'anthropic_messages') || context.status < 400) return undefined;
      const mapped = codeBuddyProtocolError({ status: context.status, body: context.errorBody, protocol: context.protocol });
      return mapped === undefined ? undefined : { status: mapped.status, errorBody: mapped.body };
    },
    async credential(): Promise<CodeBuddyCredential | undefined> {
      return (await current())?.credential;
    },
    /**
     * Canonical offering -> the exact product-file wire spelling. The mapping
     * depends only on the selected product entries, so it holds with or without
     * a bound credential (matching the Kimi Coding wire-alias contract) and is
     * what a native CodeBuddy launch must pass to the CLI `--model`.
     */
    resolveUpstreamModel(model: string, _bound?: CodeBuddyCredential): string | undefined {
      return routing.codeBuddyUpstreamWireModel(model);
    },
    freeSupply(model: string, bound: CodeBuddyCredential): CodeBuddyFreeSupplyFact | undefined {
      return routing.evaluateCodeBuddyFreeSupply(environments.get(bound), model);
    },
    async snapshot(): Promise<CodeBuddyActiveSnapshot | undefined> {
      const resolved = await current();
      if (!resolved) return undefined;
      return freezeCodeBuddyActiveSnapshot(resolved.credential, environment, resolved.account.stableScope, routing);
    },
    async clientIdentity(): Promise<CodeBuddyClientIdentity | undefined> {
      return ready?.identity;
    },
    refresh,
    /**
     * Current discovery state distinct from credential presence and route
     * availability: an unavailable discovery still reports its safe,
     * actionable reason even when zero models are offered, so a healthy
     * credential is never reported as simply signed out.
     */
    discovery(): { status: 'ready' | 'unavailable'; reason?: string } {
      return ready ? { status: 'ready' } : { status: 'unavailable', ...(discoveryReason ? { reason: discoveryReason } : {}) };
    },
  };
}
