import type { ModelDefinition, ProviderDefinition, Provider, ProviderCredential, ProviderContext, ProtocolCapability } from '../base/index.ts';
import { effortLadder } from '../base/model-defaults.ts';
import { validateOfferingSnapshot } from '../base/catalog.ts';
import { readDevinCredentials, type DevinCredentials } from './credentials.ts';
import { fetchDevinModels, type DevinModel } from './models.ts';
import { executeDevin, CHAT_RPC, jsonError } from './protocol.ts';
import { quota } from './quota.ts';

/**
 * Parse the reset instant Devin embeds in a free-model rate-limit message.
 * Prefers the absolute `(at HH:MM UTC)` marker (UTC calendar day of `nowMs`,
 * bumped to the next day once it has already passed); otherwise falls back to a
 * relative `reset in N hours [M minutes]` window measured from `nowMs`. Returns
 * an ISO 8601 instant, or `undefined` when the message carries no usable time.
 */
function parseDevinResetInstant(message: string, nowMs: number): string | undefined {
  const absolute = message.match(/\(at\s+(\d{1,2}):(\d{2})\s+UTC\)/i);
  if (absolute !== null) {
    const hours = Number(absolute[1]);
    const minutes = Number(absolute[2]);
    const now = new Date(nowMs);
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0, 0));
    // An instant already in the past belongs to the next UTC day.
    if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
    return reset.toISOString();
  }
  const relative = message.match(/reset in\s+(\d+)\s*hours?(?:\s+(\d+)\s*minutes?)?/i);
  if (relative !== null) {
    const hours = Number(relative[1]);
    const minutes = Number(relative[2] ?? 0);
    return new Date(nowMs + (hours * 60 + minutes) * 60_000).toISOString();
  }
  return undefined;
}

export interface DevinOptions { context?: ProviderContext; fetch?: typeof fetch }
export interface DevinProvider extends Provider { refreshModels(): Promise<readonly ModelDefinition[]> }
interface Snapshot { credentials: DevinCredentials; models: DevinModel[]; expires: number }

export function createDevin(options: DevinOptions = {}): DevinProvider {
  let current: Snapshot | undefined;
  let identity: string | undefined;
  let generation = 0;
  let retryAt = 0;
  let pending: { fingerprint: string; request: Promise<Snapshot> } | undefined;
  const bound = new WeakMap<ProviderCredential, Snapshot>();
  const chatProtocol: ProtocolCapability = {
    protocol: 'openai_chat',
    endpoint: 'https://server.codeium.com' + CHAT_RPC,
    authScheme: 'bearer',
  };
  // Models, upstream bindings and effort mappings publish together from one
  // snapshot, and the last good snapshot keeps serving across refresh failures,
  // so a transient catalog refresh can never blank the published gateway catalog
  // mid-session.
  const clearCatalog = () => {
    definition.models = [];
    definition.reasoningEffortMappings = undefined;
    chatProtocol.upstreamModels = undefined;
  };
  const publish = (snapshot: Snapshot) => {
    // A replacement snapshot obeys the same identity contract as startup:
    // registered ids only, one offering per identity.
    validateOfferingSnapshot('devin', snapshot.models);
    const mappings: Record<string, { codebuddy: ReturnType<typeof effortLadder>; grok: ReturnType<typeof effortLadder> }> = {};
    const upstreamModels: Record<string, string> = {};
    for (const group of snapshot.models) {
      // Native settings serialize real effort levels; the gateway disable
      // switch ('none') and the provider-default sentinel stay unmapped.
      const levels = group.reasoningEfforts.filter((effort) => effort !== 'none' && effort !== 'default');
      if (levels.length > 0) {
        mappings[group.id] = { codebuddy: effortLadder(levels), grok: effortLadder(levels) };
      }
      // The registered identity is the public id; the exact UID the account
      // reported stays a private request binding.
      if (group.upstreamId !== undefined && group.upstreamId !== group.id) {
        upstreamModels[group.id] = group.upstreamId;
      }
    }
    definition.models = snapshot.models;
    definition.reasoningEffortMappings = mappings;
    chatProtocol.upstreamModels = Object.freeze(upstreamModels);
  };
  const definition: ProviderDefinition = {
    id: 'devin', displayName: 'Devin', setupHint: 'Run devin auth login, then refresh model supply.',
    credentialResolver: 'devin', models: [],
    protocols: [chatProtocol],
    convertReasoningEffort(model, effort) {
      const variant = current?.models.find(m => m.id === model)?.variants[effort];
      if (!variant) throw new Error(`Devin model ${model} does not support reasoning effort ${effort}`);
      return { model: variant.id };
    },
    // Devin reports paid quota exhaustion as a Connect `failed_precondition`
    // whose message names the exhausted quota. That failure owns the paid pools
    // only, never a route or the provider, so the free pool stays usable. Every
    // other body falls through to the generic status classification.
    classifyUpstreamError({ body, status, nowMs }) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
      const root = body as Record<string, unknown>;
      const error = root.error !== null && typeof root.error === 'object' && !Array.isArray(root.error)
        ? root.error as Record<string, unknown>
        : root;
      // Free-model rate limit: Devin names the reset instant in the message, so
      // surface a pool-scoped quota exhaustion carrying that instant instead of
      // letting it fall through to a generic rate-limited fault with no reset.
      if (error.code === 'resource_exhausted' || (status === 429 && typeof error.message === 'string' && /free model rate limit/i.test(error.message))) {
        const message = typeof error.message === 'string' ? error.message : '';
        const until = parseDevinResetInstant(message, nowMs);
        return { state: 'quota_exhausted', scope: 'pool', quotaPoolId: 'devin/free', ...(until !== undefined ? { until } : {}) };
      }
      if (error.code !== 'failed_precondition') return undefined;
      if (typeof error.message !== 'string' || !/quota|exhausted/i.test(error.message)) return undefined;
      return { state: 'quota_exhausted', scope: 'pool' };
    },
    async executeRequest(context) {
      const snapshot = bound.get(context.credential);
      const group = snapshot?.models.find(m => m.id === context.modelId);
      if (!snapshot || !group) return jsonError(401, 'Devin model credentials are unavailable; run devin auth login');
      const model = Object.values(group.variants).find(m => m.id === context.body.model);
      if (!model) return jsonError(400, 'Select a supported Devin reasoning effort');
      if (context.protocol !== 'openai_chat') return jsonError(400, 'Devin only supports Chat Completions');
      return executeDevin({ endpoint: snapshot.credentials.server + CHAT_RPC, key: context.credential.value,
        uid: model.id, publicModel: context.publicModel, maxOutput: model.maxOutputTokens,
        body: context.body, signal: context.signal, fetch: context.fetch, reportUpstreamError: context.reportUpstreamError,
        onAuthFailure: () => { if (current === snapshot) snapshot.expires = 0; },
      });
    },
  };
  async function credential(): Promise<ProviderCredential | undefined> {
    const credentials = await readDevinCredentials(options.context ?? {});
    if (!credentials) { identity = undefined; generation++; current = undefined; clearCatalog(); return undefined; }
    if (identity !== credentials.fingerprint) { identity = credentials.fingerprint; generation++; current = undefined; clearCatalog(); }
    const version = generation;
    if ((current === undefined || current.credentials.fingerprint !== credentials.fingerprint
      || current.expires <= Date.now()) && Date.now() >= retryAt) {
      if (!pending || pending.fingerprint !== credentials.fingerprint) {
        pending = { fingerprint: credentials.fingerprint, request: fetchDevinModels(credentials, options.fetch ?? globalThis.fetch)
          .then(models => ({ credentials, models, expires: Date.now() + 5 * 60_000 })) };
      }
      const loading = pending;
      try {
        const loaded = await loading.request;
        if (version !== generation) return undefined;
        current = loaded;
        retryAt = 0;
        publish(loaded);
      } catch {
        // A failed discovery keeps the last good snapshot serving and retries
        // after a short backoff instead of blanking the published catalog.
        if (version === generation) retryAt = Date.now() + 30_000;
        if (!current) return undefined;
        current.expires = Math.max(current.expires, retryAt);
      } finally { if (pending === loading) pending = undefined; }
    }
    // A snapshot only ever serves the credentials it was fetched with: a rotated
    // identity never binds the previous account's models or mappings.
    if (!current || current.credentials.fingerprint !== credentials.fingerprint) return undefined;
    const result = Object.freeze({ value: credentials.key });
    bound.set(result, current);
    return result;
  }
  return {
    id: 'devin', definition, clients: [], quota, credential,
    async refreshModels() {
      retryAt = 0;
      if (current) current.expires = 0;
      await credential();
      return definition.models;
    },
    resolveModel: model => model, canonicalizeModel: model => model, applyHeaders() {},
    freeSupply(model, credential) {
      const snapshot = bound.get(credential);
      return snapshot === current && snapshot && snapshot.expires > Date.now() && snapshot.models.some(m => m.id === model && m.free)
        ? { confirmedFree: true, source: 'devin.GetCliModelConfigs', ruleId: 'devin.cost_tier_4' } : undefined;
    },
  };
}
