import type { ModelDefinition, ProviderDefinition, Provider, ProviderCredential, ProviderContext } from '../base/index.ts';
import { effortLadder } from '../base/model-defaults.ts';
import { readDevinCredentials, type DevinCredentials } from './credentials.ts';
import { fetchDevinModels, type DevinModel } from './models.ts';
import { executeDevin, CHAT_RPC, jsonError } from './protocol.ts';
import { quota } from './quota.ts';

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
  // Models and effort mappings publish together from one snapshot, and the last
  // good snapshot keeps serving across refresh failures, so a transient catalog
  // refresh can never blank the published gateway catalog mid-session.
  const clearCatalog = () => { definition.models = []; definition.reasoningEffortMappings = undefined; };
  const publish = (snapshot: Snapshot) => {
    const mappings: Record<string, { codebuddy: ReturnType<typeof effortLadder>; grok: ReturnType<typeof effortLadder> }> = {};
    for (const group of snapshot.models) {
      // Native settings serialize real effort levels; the gateway disable
      // switch ('none') and the provider-default sentinel stay unmapped.
      const levels = group.reasoningEfforts.filter((effort) => effort !== 'none' && effort !== 'default');
      if (levels.length === 0) continue;
      mappings[group.id] = { codebuddy: effortLadder(levels), grok: effortLadder(levels) };
    }
    definition.models = snapshot.models;
    definition.reasoningEffortMappings = mappings;
  };
  const definition: ProviderDefinition = {
    id: 'devin', displayName: 'Devin', setupHint: 'Run devin auth login, then refresh model supply.',
    credentialResolver: 'devin', models: [], skipCanonicalMetadataFallback: true,
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://server.codeium.com' + CHAT_RPC, authScheme: 'bearer' }],
    convertReasoningEffort(model, effort) {
      const variant = current?.models.find(m => m.id === model)?.variants[effort];
      if (!variant) throw new Error(`Devin model ${model} does not support reasoning effort ${effort}`);
      return { model: variant.id };
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
