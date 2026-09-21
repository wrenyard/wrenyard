import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Catalog, DispatchPlan, ProviderDefinition } from '@wrenyard/catalog';
import { BUILTIN_PROVIDERS, deriveTaskDispatchPlans } from './catalog.ts';
import {
  applyCodeBuddyNativeHeaders,
  canonicalizeCodeBuddyObservedModelId,
  createCodeBuddyRuntime,
} from './codebuddy/runtime.ts';
import type { CodeBuddyActiveSnapshot, CodeBuddyClientIdentity, CodeBuddyCredential } from './codebuddy/runtime.ts';

export type { CodeBuddyActiveSnapshot, CodeBuddyClientIdentity, CodeBuddyEnvironment } from './codebuddy/runtime.ts';

export interface ProviderCredential {
  value: string;
}

/** Privacy-safe free-supply evidence for an exact model and loaded credential.
 * CodeBuddy environment rules and verified managed free-model rules are separate.
 * No credential or account identity is exposed in this fact. */
export interface RoutingFreeSupplyFact {
  readonly confirmedFree: true
  /** Stable source label for the classification evidence. */
  readonly source: string
  /** Stable policy rule id granting the confirmed-free classification. */
  readonly ruleId: string
}

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
  codeBuddySnapshot?(provider: ProviderDefinition): Promise<CodeBuddyActiveSnapshot | undefined>;
  /**
   * Installed CodeBuddy client product identity, resolved from the same
   * installed CLI package that already supplies the environment domain
   * attributes. Non-CodeBuddy providers and an absent installation resolve to
   * undefined. Carries no credential, account identity or domain.
   */
  codeBuddyClientIdentity?(provider: ProviderDefinition): Promise<CodeBuddyClientIdentity | undefined>;
}

export interface BuiltinProviderRuntimeOptions {
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

/**
 * Kimi Coding canonical-to-wire model ids. The official Kimi Coding route
 * only recognizes the wire id `kimi-for-coding`, so the canonical identity
 * `kimi-k2.8` must be translated before dispatch. Unlike CodeBuddy this is a
 * static, credential-independent translation: the same wire id is correct for
 * every Kimi credential, so no environment classification is involved.
 */
const KIMI_CODING_UPSTREAM_MODELS: Readonly<Record<string, string>> = {
  'kimi-k2.8': 'kimi-for-coding',
};

function kimiCodingUpstreamWireModel(model: string): string {
  return KIMI_CODING_UPSTREAM_MODELS[model] ?? model;
}

/** Reverse only explicit, unambiguous wire identities from the provider SSOT. */
export function canonicalizeObservedProviderModelId(provider: string, model: string): string {
  if (provider === 'codebuddy') return canonicalizeCodeBuddyObservedModelId(model);
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
 * Confirmed-free evaluation for forge-managed free-pool providers. Only an
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
  if (provider.credentialResolver !== 'forge-managed') return undefined;
  const definition = provider.models.find((entry) => entry.id === model);
  if (!definition) return undefined;
  if (definition.free !== true) return undefined;
  return {
    confirmedFree: true,
    source: `${provider.id}.catalog`,
    ruleId: `${provider.id}.free_model_confirmed_free`,
  };
}

function runtimeAuthPath(env: NodeJS.ProcessEnv, home: string): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  return join(dataHome, 'wrenyard', 'runtime', 'auth.json');
}

/**
 * Provider id renames whose persisted credential-store entries must keep
 * resolving after the rename. Only the exact legacy id is rewritten, and only
 * for a store entry that is an API key (`type: 'api'`): a subscription OAuth
 * entry is never promoted to an API key, and the modern `anthropic` provider
 * means the API provider on every read. New writes always use the canonical id.
 */
const LEGACY_CREDENTIAL_STORE_IDS: Readonly<Record<string, string>> = {
  'anthropic-api': 'anthropic',
};

function canonicalCredentialStoreId(providerId: string): string {
  return LEGACY_CREDENTIAL_STORE_IDS[providerId] ?? providerId;
}

/** The exact legacy store ids that rename onto the given canonical provider. */
function legacyCredentialStoreIds(providerId: string): string[] {
  return Object.entries(LEGACY_CREDENTIAL_STORE_IDS)
    .filter(([, canonical]) => canonical === providerId)
    .map(([legacy]) => legacy);
}

/** Reads one forge-managed API-key entry, accepting only an explicit `api` type. */
function apiKeyEntry(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as { type?: unknown; key?: unknown };
  if (entry.type !== 'api') return undefined;
  return nonEmptyString(entry.key);
}

/**
 * Resolve the persisted API key for a forge-managed provider. The canonical id
 * is tried first so an explicit new-id key always wins; only when it is absent
 * does an exact legacy id fall back, and only for an API-typed entry, so a
 * subscription OAuth entry is never exposed as an API key.
 */
function resolveManagedApiKey(entries: Record<string, unknown>, providerId: string): string | undefined {
  const canonical = canonicalCredentialStoreId(providerId);
  const direct = apiKeyEntry(entries[canonical]);
  if (direct !== undefined) return direct;
  // The requested id may itself be a legacy id, or a canonical id whose exact
  // legacy predecessor is still persisted from before the rename.
  const candidates = canonical === providerId ? legacyCredentialStoreIds(providerId) : [providerId];
  for (const candidate of candidates) {
    const value = apiKeyEntry(entries[candidate]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * DeepSeek environment compatibility keys, in precedence order. DeepSeek
 * inference is a forge-managed provider whose configured key lives in
 * auth.json, but a key exported through these names by an existing setup must
 * keep working. Read-only: this resolver never writes auth.json, so a managed
 * configure always wins over a pre-existing environment key.
 */
const DEEPSEEK_ENV_API_KEYS = ['FORGE_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'] as const;

function deepSeekEnvApiKey(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of DEEPSEEK_ENV_API_KEYS) {
    const value = nonEmptyString(env[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function createBuiltinProviderRuntime(options: BuiltinProviderRuntimeOptions = {}): ProviderRuntime {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const readFile = options.readFile ?? ((path: string, encoding: 'utf8') => fs.readFile(path, encoding));
  const realpath = options.realpath ?? ((path: string) => fs.realpath(path));
  const writeFile = options.writeFile ?? ((path, data, fileOptions) => fs.writeFile(path, data, fileOptions));
  const rename = options.rename ?? ((oldPath, newPath) => fs.rename(oldPath, newPath));
  const mkdir = options.mkdir ?? ((path, directoryOptions) => fs.mkdir(path, directoryOptions));
  const codeBuddy = createCodeBuddyRuntime({
    env,
    home,
    platform,
    codeBuddyProductPath: options.codeBuddyProductPath,
    readFile,
    realpath,
  });
  return {
    async credential(provider) {
      if (provider.credentialResolver === 'forge-managed') {
        const path = runtimeAuthPath(env, home);
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
      return codeBuddy.credential(provider);
    },
    resolveUpstreamModel(provider, model, credential) {
      // Kimi Coding canonical ids translate to their official wire ids
      // unconditionally: the mapping depends only on the model, never on which
      // credential is active, so it must not be gated on a credential.
      if (provider.id === 'kimi-coding') return kimiCodingUpstreamWireModel(model);
      return codeBuddy.resolveUpstreamModel(provider, model, credential) ?? model;
    },
    publicResponseModel(provider, model, upstreamModel, publicModel) {
      const logicalModel = publicModel.startsWith(`${provider.id}/`)
        ? publicModel.slice(provider.id.length + 1)
        : publicModel;
      return model === upstreamModel || model === logicalModel ? publicModel : model;
    },
    freeSupply(provider, model, credential) {
      if (provider.id === 'codebuddy') return codeBuddy.freeSupply(provider, model, credential);
      return evaluateManagedFreeSupply(provider, model, credential);
    },
    async configureApiKey(provider, key) {
      if (provider.credentialResolver !== 'forge-managed') {
        throw new Error(`provider ${provider.id} does not accept a managed API key`);
      }
      const normalized = key.trim();
      if (!normalized || normalized.length > 4096) throw new Error('API key is invalid');
      const path = runtimeAuthPath(env, home);
      let entries: Record<string, { type?: string; key?: string }> = {};
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed as typeof entries;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('provider credential store is invalid');
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // One-time canonicalization of a legacy id entry: only an API-typed entry
      // is moved to the canonical id, and never over an existing canonical key.
      for (const legacyId of legacyCredentialStoreIds(provider.id)) {
        if (!(legacyId in entries) || entries[legacyId]?.type !== 'api') continue;
        const canonicalEntry = entries[provider.id];
        if (canonicalEntry === undefined || canonicalEntry.type !== 'api') {
          entries[provider.id] = entries[legacyId]!;
        }
        delete entries[legacyId];
      }
      entries[provider.id] = { type: 'api', key: normalized };
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
    codeBuddySnapshot(provider) {
      return codeBuddy.codeBuddySnapshot(provider);
    },
    codeBuddyClientIdentity(provider) {
      return codeBuddy.codeBuddyClientIdentity(provider);
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
  applyCodeBuddyNativeHeaders(headers, provider, credential as CodeBuddyCredential, protocol);
  return headers;
}
