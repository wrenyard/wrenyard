import { kimiCodingUpstreamWireModel } from './kimi-coding/runtime.ts';
import { deepSeekEnvApiKey } from './deepseek/runtime.ts';
import type { ProviderDefinition } from './base/index.ts';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Catalog, DispatchPlan } from './base/catalog.ts';
import { BUILTIN_PROVIDERS, deriveTaskDispatchPlans } from './catalog.ts';
import { codeBuddy, providerImplementations } from './builtins.ts';
import type { CodeBuddyActiveSnapshot, CodeBuddyClientIdentity } from './codebuddy/index.ts';
import type { Provider } from './base/index.ts';

export type { CodeBuddyActiveSnapshot, CodeBuddyClientIdentity, CodeBuddyEnvironment } from './codebuddy/runtime.ts';

import type { ProviderCredential, RoutingFreeSupplyFact } from './base/provider.ts';
export type { ProviderCredential, RoutingFreeSupplyFact } from './base/provider.ts';

// Bind request customization to the instance that supplied this credential.
const credentialProviders = new WeakMap<ProviderCredential, Provider>();

export interface ProviderRuntime {
  credential(provider: ProviderDefinition): Promise<ProviderCredential | undefined>;
  resolveUpstreamModel(provider: ProviderDefinition, model: string, credential?: ProviderCredential): string;
  publicResponseModel(provider: ProviderDefinition, model: string, upstreamModel: string, publicModel: string): string;
  configureApiKey(provider: ProviderDefinition, key: string): Promise<void>;
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
  /**
   * Installed CodeBuddy client product identity, resolved from the same
   * installed CLI package that already supplies the environment domain
   * attributes. Non-CodeBuddy providers and an absent installation resolve to
   * undefined. Carries no credential, account identity or domain.
   */
  /** @deprecated Use the CodeBuddy instance clientIdentity() method. */
  codeBuddyClientIdentity?(provider: ProviderDefinition): Promise<CodeBuddyClientIdentity | undefined>;
}

export interface BuiltinProviderRuntimeOptions {
  providers?: readonly Provider[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  codeBuddyProductPath?: string;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  realpath?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string, options: { encoding: 'utf8'; mode: number }) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  mkdir?: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
}

/** Reverse only explicit, unambiguous wire identities from the provider SSOT. */
export function canonicalizeObservedProviderModelId(provider: string, model: string): string {
  const implementation = providerImplementations.get(provider);
  if (implementation) return implementation.canonicalizeModel(model);
  const definition = BUILTIN_PROVIDERS.find((entry) => entry.id === provider);
  if (!definition) return model;
  const matches = new Set<string>();
  const alias = definition.modelAliases?.[model];
  if (alias) matches.add(alias);
  for (const [canonical, clients] of Object.entries(definition.thinkingMappings ?? {})) {
    for (const levels of Object.values(clients)) {
      if (Object.values(levels).some((mapping) => mapping?.model === model)) matches.add(canonical);
    }
  }
  return matches.size === 1 ? [...matches][0]! : model;
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
 * Canonical managed-provider credential store:
 * `<XDG_CONFIG_HOME or ~/.config>/wrenyard/providers/auth.json`.
 */
function managedAuthPath(env: NodeJS.ProcessEnv, home: string): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(configHome, 'wrenyard', 'providers', 'auth.json');
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
  return {
    async credential(provider) {
      const implementation = implementations.get(provider.id);
      if (implementation) {
        const credential = await implementation.credential();
        if (credential) credentialProviders.set(credential, implementation);
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
        if (managed !== undefined) return { value: managed };
        // DeepSeek keeps an existing environment-configured key working even
        // before auth.json is written. A managed configure always stores the
        // canonical entry, which the lookup above returns first, so this is a
        // read-only compatibility fallback and never masks a managed key.
        if (provider.id === 'deepseek') {
          const envKey = deepSeekEnvApiKey(env);
          if (envKey !== undefined) return { value: envKey };
        }
        return undefined;
      }
      return undefined;
    },
    resolveUpstreamModel(provider, model, credential) {
      // Kimi Coding canonical ids translate to their official wire ids
      // unconditionally: the mapping depends only on the model, never on which
      // credential is active, so it must not be gated on a credential.
      if (provider.id === 'kimi-coding') return kimiCodingUpstreamWireModel(model);
      return implementations.get(provider.id)?.resolveModel(model, credential) ?? model;
    },
    publicResponseModel(provider, model, upstreamModel, publicModel) {
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
    async codeBuddySnapshot(provider) {
      if (provider.id !== activeCodeBuddy.id || provider.credentialResolver !== 'codebuddy') return undefined;
      const implementation = implementations.get(provider.id);
      if (!implementation || !('snapshot' in implementation) || typeof implementation.snapshot !== 'function') return undefined;
      const snapshot: CodeBuddyActiveSnapshot | undefined = await implementation.snapshot();
      if (snapshot) credentialProviders.set(snapshot.credential, implementation);
      return snapshot;
    },
    async codeBuddyClientIdentity(provider) {
      if (provider.id !== activeCodeBuddy.id || provider.credentialResolver !== 'codebuddy') return undefined;
      const implementation = implementations.get(provider.id);
      if (!implementation || !('clientIdentity' in implementation) || typeof implementation.clientIdentity !== 'function') return undefined;
      return implementation.clientIdentity();
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
  return headers;
}
