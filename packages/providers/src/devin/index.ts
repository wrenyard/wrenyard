import type { ModelDefinition, ProviderDefinition, Provider, ProviderCredential, ProviderContext } from '../base/index.ts';
import { readDevinCredentials, type DevinCredentials } from './credentials.ts';
import { fetchDevinModels } from './models.ts';
import { executeDevin, CHAT_RPC, jsonError } from './protocol.ts';

export interface DevinOptions { context?: ProviderContext; fetch?: typeof fetch }
export interface DevinProvider extends Provider { refreshModels(): Promise<readonly ModelDefinition[]> }
interface Snapshot { credentials: DevinCredentials; models: ModelDefinition[]; expires: number }

export function createDevin(options: DevinOptions = {}): DevinProvider {
  let current: Snapshot | undefined;
  let identity: string | undefined;
  let generation = 0;
  let pending: { fingerprint: string; request: Promise<Snapshot> } | undefined;
  const bound = new WeakMap<ProviderCredential, Snapshot>();
  const invalidate = () => { generation++; current = undefined; definition.models = []; };
  const definition: ProviderDefinition = {
    id: 'devin', displayName: 'Devin', setupHint: 'Run devin auth login, then refresh model supply.',
    credentialResolver: 'devin', models: [], skipCanonicalMetadataFallback: true,
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://server.codeium.com' + CHAT_RPC, authScheme: 'bearer' }],
    convertReasoningEffort(_model, effort) {
      if (effort !== 'default') throw new Error('Select the exact Devin model variant and its default effort');
      return {};
    },
    async executeRequest(context) {
      const snapshot = bound.get(context.credential);
      const model = snapshot?.models.find(m => m.id === context.modelId);
      if (!snapshot || !model) return jsonError(401, 'Devin model credentials are unavailable; run devin auth login');
      if (context.protocol !== 'openai_chat') return jsonError(400, 'Devin only supports Chat Completions');
      return executeDevin({ endpoint: snapshot.credentials.server + CHAT_RPC, key: context.credential.value,
        uid: model.id, publicModel: context.publicModel, maxOutput: model.maxOutputTokens,
        body: context.body, signal: context.signal, fetch: context.fetch, reportUpstreamError: context.reportUpstreamError,
        onAuthFailure: () => { if (current === snapshot) invalidate(); },
      });
    },
  };
  async function credential(): Promise<ProviderCredential | undefined> {
    const credentials = await readDevinCredentials(options.context ?? {});
    if (!credentials) { identity = undefined; invalidate(); return undefined; }
    if (identity !== credentials.fingerprint) { identity = credentials.fingerprint; invalidate(); }
    const version = generation;
    if (!current || current.expires <= Date.now()) {
      if (!pending || pending.fingerprint !== credentials.fingerprint) {
        pending = { fingerprint: credentials.fingerprint, request: fetchDevinModels(credentials, options.fetch ?? globalThis.fetch)
          .then(models => ({ credentials, models, expires: Date.now() + 5 * 60_000 })) };
      }
      const loading = pending;
      try {
        const loaded = await loading.request;
        if (version !== generation) return undefined;
        current = loaded; definition.models = current.models;
      }
      catch { if (version === generation) invalidate(); return undefined; }
      finally { if (pending === loading) pending = undefined; }
    }
    const result = Object.freeze({ value: credentials.key });
    bound.set(result, current);
    return result;
  }
  return {
    id: 'devin', definition, clients: [], quota: { bindings: [], defaultPools: [] }, credential,
    async refreshModels() { await credential(); return definition.models; },
    resolveModel: model => model, canonicalizeModel: model => model, applyHeaders() {},
    freeSupply(model, credential) {
      const snapshot = bound.get(credential);
      return snapshot === current && snapshot && snapshot.expires > Date.now() && snapshot.models.some(m => m.id === model && m.free)
        ? { confirmedFree: true, source: 'devin.GetCliModelConfigs', ruleId: 'devin.cost_tier_4' } : undefined;
    },
  };
}
