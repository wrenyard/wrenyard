import { kimiCodingUpstreamWireModel } from './kimi-coding/runtime.ts';
import { resolveCodeBuddyProductModelId } from './codebuddy/models.ts';
import { deepSeekEnvApiKey } from './deepseek/runtime.ts';
import type { ProviderDefinition, ProviderRequestHookContext, ProviderResponseHookContext, ProviderResponseHookResult, ProviderExecuteContext } from './base/index.ts';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveWrenyardConfigRoot } from '@wrenyard/paths';
import type { Catalog, DispatchPlan } from './base/catalog.ts';
import { BUILTIN_PROVIDERS, deriveTaskDispatchPlans, resolveHistoricalProviderModelId } from './catalog.ts';
// The verified provider-scoped migration helper lives at the catalog boundary so
// quota/metadata consumers can use it without importing this runtime module.
export { resolveHistoricalOfferedModelId, resolveHistoricalProviderModelId } from './catalog.ts';
import { codeBuddy, providerImplementations, providerQuotas } from './builtins.ts';
import type { CodeBuddyActiveSnapshot } from './codebuddy/index.ts';
import type { Provider } from './base/index.ts';
import {
  applyChatGptNativeHeaders,
  bindChatGptGatewayCredential,
  chatGptGatewayAccountId,
  type ChatGptGatewayAuthAdapter,
  type ChatGptGatewayCredential,
} from './chatgpt/runtime.ts';

export type { CodeBuddyActiveSnapshot, CodeBuddyClientIdentity, CodeBuddyEnvironment } from './codebuddy/runtime.ts';
export type { ChatGptGatewayAuthAdapter, ChatGptGatewayCredential } from './chatgpt/runtime.ts';
export { applyChatGptPromptCacheKey } from './chatgpt/runtime.ts';

import { freeQuotaPool } from './base/quota-helpers.ts';
import type { ProviderCredential, RoutingFreeSupplyFact } from './base/provider.ts';
export type { ProviderCredential, RoutingFreeSupplyFact } from './base/provider.ts';

// Bind request customization to the instance that supplied this credential.
const credentialProviders = new WeakMap<ProviderCredential, Provider>();

export interface ProviderRuntime {
  /** Current offering bindings, including runtime-only provider models. */
  quotaPools?(provider: string, model: string): readonly string[];
  credential(provider: ProviderDefinition): Promise<ProviderCredential | undefined>;
  resolveUpstreamModel(provider: ProviderDefinition, model: string, credential?: ProviderCredential): string;
  publicResponseModel(provider: ProviderDefinition, model: string, upstreamModel: string, publicModel: string): string;
  /**
   * Run the provider's declared request hook. Generic: the Gateway supplies the
   * context and never knows which supplier (if any) handles it. A provider
   * without a hook is a no-op.
   */
  beforeRequest?(provider: ProviderDefinition, context: ProviderRequestHookContext): Promise<void>;
  /**
   * Run the provider's declared response hook and return its correction, if
   * any. Generic, like {@link beforeRequest}.
   */
  afterResponse?(
    provider: ProviderDefinition,
    context: ProviderResponseHookContext,
  ): Promise<ProviderResponseHookResult | undefined>;
  executeRequest?(provider: ProviderDefinition, context: ProviderExecuteContext): Promise<Response>;
  configureApiKey(provider: ProviderDefinition, key: string): Promise<void>;
  /**
   * Optional one-shot credential refresh for the single ChatGPT/Codex gateway
   * auth path. Implemented only through the injected client adapter; every
   * other provider is rejected. Resolves to the new credential on success and
   * throws when refresh is unavailable, so a caller can fall back to the
   * original failure without retrying.
   */
  refreshCredential?(provider: ProviderDefinition, credential: ProviderCredential, signal: AbortSignal): Promise<ProviderCredential>;
  /** Exact-model free-supply classification for an already-loaded credential.
   * Unknown credentials/models and paid subscriptions never qualify. */
  freeSupply?(provider: ProviderDefinition, model: string, credential: ProviderCredential): RoutingFreeSupplyFact | undefined;
  /**
   * One-shot immutable active-credential snapshot for the CodeBuddy provider.
   * Performs exactly one auth-file read and binds the resulting credential,
   * normalized environment, optional versioned stable scope, canonical-to-wire
   * model resolution and model-scoped free eligibility to that single read.
   * Non-CodeBuddy providers and absent credentials resolve to undefined.
   * Optional so existing non-CodeBuddy runtime callers remain compatible.
   */
  /** @deprecated Use the CodeBuddy instance snapshot() method. */
  codeBuddySnapshot?(provider: ProviderDefinition): Promise<CodeBuddyActiveSnapshot | undefined>;
}

export interface BuiltinProviderRuntimeOptions {
  providers?: readonly Provider[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  realpath?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string, options: { encoding: 'utf8'; mode: number }) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  mkdir?: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  /**
   * Injected Codex ChatGPT gateway auth, implemented by @wrenyard/client-codex
   * and wired by the daemon. Its absence leaves ChatGPT without a gateway
   * credential; no other provider consults it.
   */
  codexGatewayAuth?: ChatGptGatewayAuthAdapter;
}

/** Reverse only explicit, unambiguous wire identities from the provider SSOT. */
export function canonicalizeObservedProviderModelId(provider: string, model: string): string {
  const implementation = providerImplementations.get(provider);
  // Verified reverse mappings (a registered id, a private upstream binding, an
  // explicit alias, or an exact reasoning-effort UID) are merged first for every
  // provider, so a provider callback can never skip a mapping the provider
  // itself declares. The live implementation definition is used when one exists,
  // so a dynamically discovered Devin/OpenCode Zen catalog is canonicalized
  // rather than the static seed; unknown and ambiguous spellings keep their own
  // text.
  const verified = resolveHistoricalProviderModelId(provider, model, implementation?.definition);
  if (verified !== undefined) return verified;
  // Historical wire identities do not depend on the currently installed offerings.
  if (provider === 'codebuddy') return resolveCodeBuddyProductModelId(model) ?? model;
  if (implementation) return implementation.canonicalizeModel(model);
  return model;
}

/**
 * Confirmed-free evaluation for managed free-pool providers. Only an
 * already-loaded, non-empty authenticated managed credential together with a
 * declared free model ever qualifies; list pricing is deliberately independent
 * from this provider/account entitlement.
 */
function evaluateManagedFreeSupply(
  provider: ProviderDefinition,
  model: string,
  credential: ProviderCredential | undefined,
): RoutingFreeSupplyFact | undefined {
  if (!credential || !credential.value.trim()) return undefined;
  if (provider.credentialResolver !== 'managed') return undefined;
  const definition = provider.models.find((entry) => entry.id === model);
  if (!definition) return undefined;
  if (definition.free !== true) return undefined;
  return {
    confirmedFree: true,
    source: `${provider.id}.catalog`,
    ruleId: `${provider.id}.free_model_confirmed_free`,
  };
}

/**
 * Credential-free native route classification, shared by every surface that
 * must branch explicitly on a model being free.
 *
 * True ONLY when every one of these facts holds: the provider is
 * `opencode-zen`, that provider declares the `opencode` native client, the
 * exact model exists on it with `free === true`, the route client is
 * `opencode`, the route mode is `native`, and — when the model declares
 * `supportedClients` — that list contains `opencode`.
 *
 * Free status is an explicit classification carried by the model: a zero
 * `pricing` value, a `-free` id suffix, or any other name heuristic NEVER
 * qualifies. Paid OpenCode Zen/Go models, non-free models, other clients and
 * every gateway-mode route are rejected.
 *
 * Only the admission decision is expressed here. Live upstream health and any
 * numeric quota are unknown at this point and are never fabricated.
 */
export function isCredentialFreeNativeRoute(
  provider: ProviderDefinition,
  model: string,
  route: { readonly client: string; readonly mode: string },
): boolean {
  if (provider.id !== 'opencode-zen') return false;
  if (!(provider.nativeClients ?? []).includes('opencode')) return false;
  if (route.client !== 'opencode' || route.mode !== 'native') return false;
  const definition = provider.models.find((entry) => entry.id === model);
  if (!definition || definition.free !== true) return false;
  if (definition.supportedClients !== undefined && !definition.supportedClients.includes('opencode')) return false;
  return true;
}

/**
 * Canonical managed-provider credential store:
 * `<WRENYARD_CONFIG_HOME or ~/.config/wrenyard>/providers/auth.json`.
 */
function managedAuthPath(env: NodeJS.ProcessEnv, home: string): string {
  const root = resolveWrenyardConfigRoot(env, home);
  return join(root, 'providers', 'auth.json');
}

/** Reads one managed API-key entry, accepting only an explicit `api` type. */
function apiKeyEntry(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as { type?: unknown; key?: unknown };
  if (entry.type !== 'api') return undefined;
  return nonEmptyString(entry.key);
}

/**
 * Resolve the persisted API key for a managed provider from its canonical id.
 * Only an API-typed entry is exposed, so a subscription OAuth entry is never
 * returned as an API key.
 */
function resolveManagedApiKey(entries: Record<string, unknown>, providerId: string): string | undefined {
  return apiKeyEntry(entries[providerId]);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function createBuiltinProviderRuntime(options: BuiltinProviderRuntimeOptions = {}): ProviderRuntime {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const readFile = options.readFile ?? ((path: string, encoding: 'utf8') => fs.readFile(path, encoding));
  const writeFile = options.writeFile ?? ((path, data, fileOptions) => fs.writeFile(path, data, fileOptions));
  const rename = options.rename ?? ((oldPath, newPath) => fs.rename(oldPath, newPath));
  const mkdir = options.mkdir ?? ((path, directoryOptions) => fs.mkdir(path, directoryOptions));
  const activeCodeBuddy = codeBuddy;
  const implementations = new Map(providerImplementations);
  implementations.set(activeCodeBuddy.id, activeCodeBuddy);
  for (const provider of options.providers ?? []) implementations.set(provider.id, provider);
  const lastCredentials = new Map<string, ProviderCredential>();
  return {
    /**
     * Pools a provider model should be admitted against. A confirmed-free model
     * draws on its provider's free pool only, so a paid-pool fault never
     * applies to its route; when the live evidence ends, the model falls back
     * to its declared paid bindings.
     */
    quotaPools(provider, model) {
      const implementation = implementations.get(provider);
      const quota = implementation?.quota ?? providerQuotas.get(provider);
      const declared = (quota?.bindings.find(binding => binding.modelId === model)?.pools ?? quota?.defaultPools ?? [])
        .map(pool => pool.quotaPoolId);
      const credential = lastCredentials.get(provider);
      if (credential === undefined) return declared;
      try {
        const definition = implementation?.definition ?? BUILTIN_PROVIDERS.find((entry) => entry.id === provider);
        const freeFact = implementation?.freeSupply(model, credential)
          ?? (definition !== undefined ? evaluateManagedFreeSupply(definition, model, credential) : undefined);
        return freeFact?.confirmedFree === true ? [freeQuotaPool(provider).quotaPoolId] : declared;
      } catch {
        return declared;
      }
    },
    async credential(provider) {
      // ChatGPT/Codex is the only provider whose gateway credential comes from
      // the injected native Codex reader. It carries the ChatGPT account id
      // bound to the returned credential; every other provider keeps its
      // existing implementation or managed-store path unchanged.
      if (provider.id === 'chatgpt' && provider.credentialResolver === 'codex') {
        const adapter = options.codexGatewayAuth;
        if (!adapter) {
          lastCredentials.delete(provider.id);
          return undefined;
        }
        // An absent, malformed, or rejected native login is simply an
        // unavailable credential, exactly like an empty managed store. The
        // gateway probes credential() for every provider, so a thrown error
        // here would break every other protocol's /models directory.
        let gateway: ChatGptGatewayCredential | undefined;
        try {
          gateway = await adapter.read();
        } catch {
          lastCredentials.delete(provider.id);
          return undefined;
        }
        const accessToken = nonEmptyString(gateway?.accessToken);
        const accountId = nonEmptyString(gateway?.accountId);
        if (accessToken === undefined || accountId === undefined) {
          lastCredentials.delete(provider.id);
          return undefined;
        }
        const credential = Object.freeze({ value: accessToken });
        bindChatGptGatewayCredential(credential, accountId);
        lastCredentials.set(provider.id, credential);
        return credential;
      }
      const implementation = implementations.get(provider.id);
      if (implementation) {
        const credential = await implementation.credential();
        if (credential) {
          credentialProviders.set(credential, implementation);
          lastCredentials.set(provider.id, credential);
        } else {
          lastCredentials.delete(provider.id);
        }
        return credential;
      }
      if (provider.credentialResolver === 'managed') {
        const path = managedAuthPath(env, home);
        let managed: string | undefined;
        try {
          const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
          managed = resolveManagedApiKey(parsed ?? {}, provider.id);
        } catch {
          managed = undefined;
        }
        if (managed !== undefined) {
          const credential = { value: managed };
          lastCredentials.set(provider.id, credential);
          return credential;
        }
        // DeepSeek keeps an existing environment-configured key working even
        // before auth.json is written. A managed configure always stores the
        // canonical entry, which the lookup above returns first, so this is a
        // read-only compatibility fallback and never masks a managed key.
        if (provider.id === 'deepseek') {
          const envKey = deepSeekEnvApiKey(env);
          if (envKey !== undefined) {
            const credential = { value: envKey };
            lastCredentials.set(provider.id, credential);
            return credential;
          }
        }
        lastCredentials.delete(provider.id);
        return undefined;
      }
      lastCredentials.delete(provider.id);
      return undefined;
    },
    resolveUpstreamModel(provider, model, credential) {
      // Kimi Coding canonical ids translate to their official wire ids
      // unconditionally: the mapping depends only on the model, never on which
      // credential is active, so it must not be gated on a credential.
      if (provider.id === 'kimi-coding') return kimiCodingUpstreamWireModel(model);
      const resolved = implementations.get(provider.id)?.resolveModel(model, credential);
      if (resolved !== undefined && resolved !== model) return resolved;
      // The registered id is the public identity; the exact upstream spelling is
      // the offering's private binding. A provider implementation that returns
      // its input unchanged is not evidence against a declared wire id.
      const offering = provider.models.find((entry) => entry.id === model);
      return offering?.upstreamId ?? resolved ?? model;
    },
    publicResponseModel(provider, model, upstreamModel, publicModel) {
      // `publicModel` is the requested registered id; a historical qualified
      // route key is accepted only so an in-flight response can still be
      // normalized onto the same identity.
      const logicalModel = publicModel.startsWith(`${provider.id}/`)
        ? publicModel.slice(provider.id.length + 1)
        : publicModel;
      return model === upstreamModel || model === logicalModel ? publicModel : model;
    },
    freeSupply(provider, model, credential) {
      const implementation = implementations.get(provider.id);
      if (implementation) return implementation.freeSupply(model, credential);
      return evaluateManagedFreeSupply(provider, model, credential);
    },
    async configureApiKey(provider, key) {
      const implementation = implementations.get(provider.id);
      if (implementation?.configureApiKey) return implementation.configureApiKey(key);
      if (provider.credentialResolver !== 'managed') {
        throw new Error(`provider ${provider.id} does not accept a managed API key`);
      }
      const normalized = key.trim();
      if (!normalized || normalized.length > 4096) throw new Error('API key is invalid');
      const path = managedAuthPath(env, home);
      let entries: Record<string, { type?: string; key?: string }> = {};
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed as typeof entries;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('provider credential store is invalid');
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      entries[provider.id] = { type: 'api', key: normalized };
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
    async beforeRequest(provider, context) {
      await provider.beforeRequest?.(context);
    },
    async afterResponse(provider, context) {
      const result = await provider.afterResponse?.(context);
      return result ? result : undefined;
    },
    async executeRequest(provider, context) {
      const bound = credentialProviders.get(context.credential);
      if (bound && bound.id !== provider.id) throw new Error('provider credential binding mismatch');
      const execute = (bound?.definition ?? provider).executeRequest;
      if (!execute) throw new Error(`provider ${provider.id} has no request executor`);
      return execute(context);
    },
    async refreshCredential(provider, credential, signal) {
      // Only the ChatGPT/Codex gateway credential is refreshable, and only
      // through the injected client adapter: no credential material or refresh
      // transport is authored here.
      if (provider.id !== 'chatgpt' || provider.credentialResolver !== 'codex') {
        throw new Error(`provider ${provider.id} does not support credential refresh`);
      }
      const adapter = options.codexGatewayAuth;
      if (!adapter) throw new Error('ChatGPT credential refresh is unavailable');
      const accountId = chatGptGatewayAccountId(credential);
      if (accountId === undefined || credential.value === '') {
        throw new Error('ChatGPT credential is not refreshable');
      }
      const refreshed = await adapter.refresh({ accessToken: credential.value, accountId }, signal);
      const next = Object.freeze({ value: refreshed.accessToken });
      bindChatGptGatewayCredential(next, refreshed.accountId);
      return next;
    },
    async codeBuddySnapshot(provider) {
      if (provider.id !== activeCodeBuddy.id || provider.credentialResolver !== 'codebuddy') return undefined;
      const implementation = implementations.get(provider.id);
      if (!implementation || !('snapshot' in implementation) || typeof implementation.snapshot !== 'function') return undefined;
      const snapshot: CodeBuddyActiveSnapshot | undefined = await implementation.snapshot();
      if (snapshot) credentialProviders.set(snapshot.credential, implementation);
      return snapshot;
    },
  };
}

// Compile Catalog-derived task dispatch plans into runtime plans. Preserves the
// public canonical model id in plan.model and puts the private provider wire
// remap into plan.upstreamModel, respecting any upstreamModel already selected
// by an explicit thinking mapping. Caches credentials per provider; user alias
// loading is daemon composition and never happens here.
export async function resolveRuntimeTaskPlans(
  catalog: Catalog,
  runtime: ProviderRuntime,
): Promise<Readonly<Record<string, DispatchPlan>>> {
  const plans = deriveTaskDispatchPlans(catalog);
  const credentials = new Map<string, Promise<ProviderCredential | undefined>>();
  const resolveCredential = (provider: ProviderDefinition): Promise<ProviderCredential | undefined> => {
    let pending = credentials.get(provider.id);
    if (!pending) {
      pending = runtime.credential(provider);
      credentials.set(provider.id, pending);
    }
    return pending;
  };
  return Object.fromEntries(await Promise.all(Object.entries(plans).map(async ([target, plan]) => {
    const provider = catalog.provider(plan.provider);
    if (!provider) return [target, plan] as const;
    const credential = await resolveCredential(provider);
    // A thinking mapping may already have substituted the upstream model; that
    // exact selection wins over the provider-level runtime remap.
    if (plan.upstreamModel !== undefined) return [target, plan] as const;
    const upstreamModel = runtime.resolveUpstreamModel(provider, plan.model, credential);
    if (upstreamModel === plan.model) return [target, plan] as const;
    return [target, { ...plan, upstreamModel }] as const;
  })));
}

export function upstreamAuthHeaders(provider: ProviderDefinition, credential: ProviderCredential, protocol: string): Headers {
  const capability = provider.protocols?.find((entry) => entry.protocol === protocol);
  if (!capability) throw new Error(`provider ${provider.id} does not support ${protocol}`);
  const headers = new Headers();
  if (capability.authScheme === 'x-api-key') headers.set('x-api-key', credential.value);
  else headers.set('authorization', `Bearer ${credential.value}`);
  const implementation = credentialProviders.get(credential) ?? providerImplementations.get(provider.id);
  if (implementation?.id === provider.id) implementation.applyHeaders(headers, credential, capability.protocol);
  // The ChatGPT subscription endpoint additionally needs the Codex account
  // headers, applied only for a bound chatgpt credential and openai_responses.
  applyChatGptNativeHeaders(headers, provider, credential, capability.protocol);
  return headers;
}
