import { createHash, randomUUID } from 'node:crypto';
import { configModelEntries } from '@wrenyard/client-codebuddy';
import type {
  ProviderCredential,
  ProviderDefinition,
  ProviderRequestHookContext,
  ProviderResponseHookContext,
  ProviderResponseHookResult,
} from '../base/index.ts';
import type { RoutingFreeSupplyFact } from '../base/provider.ts';
import { codeBuddyProtocolError } from '../codebuddy/route-errors.ts';
import { productCreditsAreFree } from '../codebuddy/product.ts';
import type { WorkBuddyBuild } from './definition.ts';
import {
  meterAuthHeaders,
  nativeHeadersForSession,
  readPersistedAuth,
  refreshWorkBuddyAuth,
  resolveWorkBuddySession,
  sessionFromAuth,
  type WorkBuddyCredentialStore,
  type WorkBuddySession,
  type WorkBuddyStoredAuth,
  writePersistedAuth,
} from './credentials.ts';
import type { WorkBuddyModelState } from './models.ts';
import {
  WORKBUDDY_CONFIG_USER_AGENT,
  WORKBUDDY_UA_VERSION,
  WORKBUDDY_USER_AGENT,
  configUrl,
  enterpriseUserUsageUrl,
  userResourceSummaryUrl,
} from './protocol.ts';
import {
  fitWorkBuddyTools,
  normalizeWorkBuddyToolChoice,
  renameWorkBuddyResponse,
} from './tools.ts';

export interface WorkBuddyProviderCredential extends ProviderCredential {
  readonly value: string;
}

interface WorkBuddyRound {
  conversationId: string;
  conversationRequestId: string;
  lastSeenMs: number;
}

const nativeHeaders = new WeakMap<WorkBuddyProviderCredential, Readonly<Record<string, string>>>();
const sessionByCredential = new WeakMap<WorkBuddyProviderCredential, WorkBuddySession>();

const ROUND_TTL_MS = 30 * 60 * 1000;
const ROUND_CACHE_LIMIT = 512;
const CATALOG_TTL_MS = 5 * 60_000;
const TOOL_NAME_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SYSTEM_TEXT = 'You are a helpful assistant.';

const toolNamesByTurn = new Map<string, { names: ReadonlyMap<string, string>; lastSeenMs: number }>();

function workBuddyId(): string {
  return randomUUID().replace(/-/gu, '');
}

function continuesTurn(body: Record<string, unknown>): boolean {
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

function conversationKey(executionId: string | undefined, body: Record<string, unknown>): string {
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

export interface WorkBuddyRuntimeOptions {
  readonly store: WorkBuddyCredentialStore;
  readonly state: WorkBuddyModelState;
  readonly fetch?: typeof fetch;
}

export function createWorkBuddyRuntime(options: WorkBuddyRuntimeOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const { store, state } = options;
  const rounds = new Map<string, WorkBuddyRound>();
  let catalogExpires = 0;
  let catalogRetryAt = 0;
  let pendingCatalog: Promise<void> | undefined;

  const round = (key: string, continues: boolean, nowMs: number): WorkBuddyRound => {
    for (const [entryKey, entry] of rounds) {
      if (nowMs - entry.lastSeenMs > ROUND_TTL_MS) rounds.delete(entryKey);
    }
    const existing = rounds.get(key);
    const next: WorkBuddyRound = existing !== undefined
      ? {
          conversationId: existing.conversationId,
          conversationRequestId: continues ? existing.conversationRequestId : workBuddyId(),
          lastSeenMs: nowMs,
        }
      : { conversationId: workBuddyId(), conversationRequestId: workBuddyId(), lastSeenMs: nowMs };
    rounds.delete(key);
    rounds.set(key, next);
    while (rounds.size > ROUND_CACHE_LIMIT) {
      const oldest = rounds.keys().next();
      if (oldest.done || oldest.value === key) break;
      rounds.delete(oldest.value);
    }
    return next;
  };

  function bindCredential(session: WorkBuddySession): WorkBuddyProviderCredential {
    const credential = Object.freeze({ value: session.accessToken }) as WorkBuddyProviderCredential;
    nativeHeaders.set(credential, nativeHeadersForSession(session));
    sessionByCredential.set(credential, session);
    return credential;
  }

  async function fetchCatalog(session: WorkBuddySession, signal?: AbortSignal): Promise<void> {
    const headers = meterAuthHeaders(session, WORKBUDDY_CONFIG_USER_AGENT);
    const response = await fetchImpl(configUrl(store.build), { method: 'GET', headers, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('WorkBuddy configuration request failed');
    }
    const payload = await response.json();
    const entries = configModelEntries(payload);
    if (!entries) throw new Error('WorkBuddy configuration response was rejected');
    // modelPromotions parsing is intentionally not implemented.
    state.publish(entries);
    catalogExpires = Date.now() + CATALOG_TTL_MS;
  }

  async function ensureCatalog(session: WorkBuddySession, signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    if (state.definition.models.length > 0 && catalogExpires > now) return;
    if (now < catalogRetryAt) return;
    if (!pendingCatalog) {
      pendingCatalog = fetchCatalog(session, signal).catch(() => {
        catalogRetryAt = Date.now() + 30_000;
      }).finally(() => {
        pendingCatalog = undefined;
      });
    }
    await pendingCatalog;
  }

  return {
    get definition(): ProviderDefinition {
      return state.definition;
    },
    async beforeRequest(context: ProviderRequestHookContext): Promise<void> {
      if (context.protocol !== 'openai_chat') return;
      const { safeToOriginal } = fitWorkBuddyTools(context.body);
      normalizeWorkBuddyToolChoice(context.body, safeToOriginal);
      context.headers.set('User-Agent', WORKBUDDY_USER_AGENT);
      context.headers.set('X-Product', 'SaaS');
      context.headers.set('X-IDE-Type', 'WorkBuddy');
      context.headers.set('X-Requested-With', 'XMLHttpRequest');
      context.headers.set('X-Agent-Intent', 'craft');
      context.headers.set('X-Agent-Purpose', 'conversation');
      context.headers.set('X-IDE-Name', 'WorkBuddy');
      context.headers.set('X-IDE-Version', WORKBUDDY_UA_VERSION);
      context.headers.set('X-Agent-Type', 'main');
      const next = round(
        conversationKey(context.executionId, context.body),
        continuesTurn(context.body),
        context.nowMs,
      );
      const messageId = workBuddyId();
      context.headers.set('x-conversation-id', next.conversationId);
      context.headers.set('x-conversation-request-id', next.conversationRequestId);
      context.headers.set('x-conversation-message-id', messageId);
      context.headers.set('x-request-id', messageId);
      if (safeToOriginal.size > 0) {
        for (const [key, entry] of toolNamesByTurn) {
          if (context.nowMs - entry.lastSeenMs > TOOL_NAME_TTL_MS) toolNamesByTurn.delete(key);
        }
        toolNamesByTurn.set(next.conversationRequestId, { names: safeToOriginal, lastSeenMs: context.nowMs });
      }
      const messages = context.body.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        const first = messages[0];
        if (first && typeof first === 'object' && !Array.isArray(first) && (first as Record<string, unknown>).role !== 'system') {
          context.body.messages = [{ role: 'system', content: DEFAULT_SYSTEM_TEXT }, ...messages];
        }
      }
      if (typeof context.body.max_completion_tokens === 'number' && context.body.max_tokens === undefined) {
        context.body.max_tokens = context.body.max_completion_tokens;
        delete context.body.max_completion_tokens;
      }
      for (const message of Array.isArray(context.body.messages) ? context.body.messages : []) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
        const entry = message as Record<string, unknown>;
        if (entry.role === 'developer') entry.role = 'system';
      }
    },
    async afterResponse(context: ProviderResponseHookContext): Promise<ProviderResponseHookResult | undefined> {
      if (context.protocol !== 'openai_chat') return undefined;
      const turnId = context.headers.get('x-conversation-request-id');
      const toolNames = turnId ? toolNamesByTurn.get(turnId)?.names : undefined;
      if (context.status < 400) {
        if (!toolNames?.size || !context.response) return undefined;
        return { response: await renameWorkBuddyResponse(context.response, toolNames) };
      }
      const mapped = codeBuddyProtocolError({ status: context.status, body: context.errorBody });
      return mapped === undefined ? undefined : { status: mapped.status, errorBody: mapped.body };
    },
    async credential(signal?: AbortSignal): Promise<WorkBuddyProviderCredential | undefined> {
      const session = await resolveWorkBuddySession(store, signal ?? AbortSignal.timeout(30_000), fetchImpl);
      if (!session) return undefined;
      const credential = bindCredential(session);
      await ensureCatalog(session, signal);
      return credential;
    },
    async refreshCredential(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderCredential> {
      const session = sessionByCredential.get(credential as WorkBuddyProviderCredential);
      const stored = session ?? await readPersistedAuth(store);
      if (!stored) throw new Error('WorkBuddy credential is not refreshable');
      const refreshed = await refreshWorkBuddyAuth(store, stored, signal, fetchImpl);
      if (!refreshed) throw new Error('WorkBuddy credential refresh failed');
      return bindCredential(sessionFromAuth(refreshed));
    },
    resolveUpstreamModel(model: string): string {
      const wire = state.upstreamModels[model];
      if (wire !== undefined) return wire;
      const offering = state.definition.models.find((entry) => entry.id === model);
      return offering?.upstreamId ?? model;
    },
    canonicalizeModel(model: string): string {
      const alias = state.definition.modelAliases?.[model];
      if (alias !== undefined) return alias;
      return model;
    },
    applyHeaders(headers: Headers, credential: ProviderCredential, protocol: string): void {
      if (protocol !== 'openai_chat') return;
      const native = nativeHeaders.get(credential as WorkBuddyProviderCredential);
      if (!native) return;
      for (const [name, value] of Object.entries(native)) headers.set(name, value);
    },
    freeSupply(model: string, credential: ProviderCredential): RoutingFreeSupplyFact | undefined {
      if (!sessionByCredential.has(credential as WorkBuddyProviderCredential)) return undefined;
      const offering = state.definition.models.find((entry) => entry.id === model);
      if (!offering || !productCreditsAreFree(offering.credits)) return undefined;
      return {
        confirmedFree: true,
        source: 'workbuddy.v3_config',
        ruleId: 'workbuddy.explicit_x0_credits',
      };
    },
    async refreshModels(signal?: AbortSignal): Promise<void> {
      const session = await resolveWorkBuddySession(store, signal ?? AbortSignal.timeout(30_000), fetchImpl);
      if (!session) return;
      catalogExpires = 0;
      catalogRetryAt = 0;
      await fetchCatalog(session, signal);
    },
    async fetchQuotaSnapshot(session: WorkBuddySession, signal?: AbortSignal): Promise<unknown> {
      const headers = meterAuthHeaders(session, WORKBUDDY_USER_AGENT);
      const summaryResponse = await fetchImpl(userResourceSummaryUrl(store.build), {
        method: 'POST',
        headers,
        body: '{}',
        signal,
      });
      if (!summaryResponse.ok) {
        await summaryResponse.body?.cancel();
        throw new Error('WorkBuddy quota request failed');
      }
      const summaryPayload = await summaryResponse.json() as Record<string, unknown>;
      const summaryData = summaryPayload.data;
      const packages = summaryData && typeof summaryData === 'object' && !Array.isArray(summaryData)
        ? (summaryData as Record<string, unknown>).Packages
        : undefined;
      if (Array.isArray(packages) && packages.length > 0) return summaryPayload;
      if (!session.enterpriseId?.trim()) return summaryPayload;
      const usageResponse = await fetchImpl(enterpriseUserUsageUrl(store.build), {
        method: 'POST',
        headers,
        body: '{}',
        signal,
      });
      if (!usageResponse.ok) {
        await usageResponse.body?.cancel();
        throw new Error('WorkBuddy enterprise quota request failed');
      }
      return await usageResponse.json();
    },
    async persistBrowserAuth(auth: WorkBuddyStoredAuth): Promise<void> {
      await writePersistedAuth(store, auth);
    },
  };
}

export type { WorkBuddyBuild };
