import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Catalog, DispatchPlan, ProviderDefinition } from '@wrenyard/catalog';
import { BUILTIN_PROVIDERS, deriveTaskDispatchPlans } from './catalog.ts';

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

/**
 * Immutable active-credential snapshot for an already-loaded CodeBuddy
 * credential. Created from exactly one auth-file read; the credential, the
 * normalized environment classification, an optional opaque versioned stable
 * scope, canonical-to-wire model resolution and model-scoped free eligibility
 * are all bound to that one read, so repeated mapping/free evaluations never
 * re-read files and cannot diverge. The credential field intentionally carries
 * the bearer value needed by existing runtime consumers; no raw account
 * identifier, domain, or user-facing identity is exposed, and the only
 * identity-derived value is an opaque digest under stableScope, present only
 * when a stable non-secret account id exists.
 */
export interface CodeBuddyActiveSnapshot {
  /** Fixed provider identity this snapshot was created for. */
  readonly provider: 'codebuddy'
  /** Loaded credential available for upstream authentication. */
  readonly credential: ProviderCredential
  /** Normalized CodeBuddy environment classification bound to this snapshot. */
  readonly environment: CodeBuddyEnvironment
  /**
   * Opaque versioned SHA-256 digest of normalized stable non-secret account
   * identity plus the auth domain and classified environment. Unaffected by
   * token refresh/expiry; undefined when no stable account id exists.
   */
  readonly stableScope: string | undefined
  /** Canonical-to-wire model resolution for this snapshot's environment. */
  resolveUpstreamModel(model: string): string
  /** Model-scoped confirmed-free evaluation for this snapshot's environment. */
  freeSupply(model: string): RoutingFreeSupplyFact | undefined
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

export type CodeBuddyEnvironment = 'internal' | 'ioa' | 'cloudhosted' | 'external' | 'unknown';

export interface CodeBuddyClientIdentity {
  /** product.json `platform`, e.g. `CLI`. */
  readonly platform: string;
  /** product.json `productName`, e.g. `CodeBuddy`. */
  readonly productName: string;
  /** Installed package version, used as both platform and product version. */
  readonly version: string;
  /** product.json `deploymentType`, defaulting to `SaaS`. */
  readonly deploymentType: string;
}

interface CodeBuddyAuthenticationAttributes {
  internalDomain?: unknown;
  iOADomain?: unknown;
  cloudHostedDomain?: unknown;
  externalDomain?: unknown;
}

const CODEBUDDY_IOA_UPSTREAM_MODELS: Readonly<Record<string, string>> = {
  'deepseek-v4.1-flash': 'deepseek-v4.1-flash-ioa',
  'hy4-preview': 'hy4-preview-ioa',
  'hy3': 'hy3-ioa',
  'minimax-m3': 'minimax-m3-ioa',
};

/**
 * Shared exact mapping lookup used both for upstream remapping and for
 * confirmed-free eligibility: a canonical model maps to its wire model and an
 * already-mapped wire id maps to itself. Because both code paths read the same
 * table through this one helper, mapping and free applicability cannot drift.
 */
function codeBuddyUpstreamWireModel(model: string): string {
  return CODEBUDDY_IOA_UPSTREAM_MODELS[model] ?? model;
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
  if (provider === 'codebuddy') {
    for (const [canonical, upstream] of Object.entries(CODEBUDDY_IOA_UPSTREAM_MODELS)) {
      if (upstream === model) return canonical;
    }
    return model;
  }
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
 * Canonical-to-wire resolution scoped to one already-classified environment.
 * Shared by the runtime methods and the active snapshot so neither code path
 * re-reads files and both always agree.
 */
function codeBuddyUpstreamResolve(environment: CodeBuddyEnvironment | undefined, model: string): string {
  if (environment !== 'ioa') return model;
  return codeBuddyUpstreamWireModel(model);
}

/**
 * Confirmed-free evaluation scoped to one already-classified environment and
 * one declared free model. Only the iOA environment qualifies; other environments
 * resolves to undefined. Shared by the runtime surface and the active
 * snapshot so free facts cannot diverge.
 */
function evaluateCodeBuddyFreeSupply(environment: CodeBuddyEnvironment | undefined, model: string): RoutingFreeSupplyFact | undefined {
  if (environment !== 'ioa') return undefined;
  const wireModel = codeBuddyUpstreamWireModel(model);
  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === 'codebuddy')?.models
    .find((entry) => codeBuddyUpstreamWireModel(entry.id) === wireModel);
  if (definition?.free !== true) return undefined;
  return {
    confirmedFree: true,
    source: 'codebuddy.credential_environment',
    ruleId: 'codebuddy.verified_hy_model_confirmed_free',
  };
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

function codeBuddyAuthPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const filename = 'Tencent-Cloud.coding-copilot.info';
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
  if (platform === 'win32') return join(env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
  return join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function codeBuddyDomainMatches(pattern: string, domain: string): boolean {
  if (pattern === domain) return true;
  if (!pattern.includes('*')) return false;
  const expression = pattern.replace(/\./gu, '\\.').replace(/\*/gu, '[^.]*');
  return new RegExp(`^${expression}$`, 'u').test(domain);
}

function codeBuddyDomainListMatches(value: unknown, domain: string): boolean {
  const patterns = Array.isArray(value) ? value : [value];
  return patterns.some((pattern) => typeof pattern === 'string' && codeBuddyDomainMatches(pattern, domain));
}

function classifyCodeBuddyEnvironment(attributes: CodeBuddyAuthenticationAttributes | undefined, domain: string | undefined): CodeBuddyEnvironment {
  if (!attributes || !domain) return 'unknown';
  if (codeBuddyDomainListMatches(attributes.internalDomain, domain)) return 'internal';
  if (codeBuddyDomainListMatches(attributes.iOADomain, domain)) return 'ioa';
  if (codeBuddyDomainListMatches(attributes.cloudHostedDomain, domain)) return 'cloudhosted';
  if (codeBuddyDomainListMatches(attributes.externalDomain, domain)) return 'external';
  return 'unknown';
}

interface ParsedCodeBuddyAuth {
  readonly accessToken: string | undefined;
  readonly domain: string | undefined;
  readonly authObject: Record<string, unknown> | undefined;
  readonly root: Record<string, unknown>;
}

/**
 * Normalized parse of one CodeBuddy auth file. Accepts both the nested `auth`
 * object shape and the legacy flat `auth.*` root keys; token and domain
 * handling mirrors the historical credential() loader exactly so a snapshot
 * can never observe a different token/domain than the runtime surface.
 */
function parseCodeBuddyAuth(parsed: Record<string, unknown>): ParsedCodeBuddyAuth {
  const auth = parsed.auth && typeof parsed.auth === 'object' && !Array.isArray(parsed.auth)
    ? parsed.auth as Record<string, unknown>
    : undefined;
  return {
    accessToken: nonEmptyString(auth?.accessToken) ?? nonEmptyString(parsed['auth.accessToken']),
    domain: nonEmptyString(auth?.domain) ?? nonEmptyString(parsed['auth.domain']),
    authObject: auth,
    root: parsed,
  };
}

interface CodeBuddyStableIdentity {
  readonly primaryId: string;
  enterpriseId?: string;
  accountType?: string;
  idp?: string;
}

/**
 * Stable non-secret account identifiers with fixed precedence and exact
 * normalization. Candidate account ids are uid, then uin, then
 * oneidAccountId; optional supporting identity (enterprise id, account type,
 * identity provider) qualifies the id deterministically. User-facing names,
 * avatars, and every token/session/time field are never read here.
 */
const CODEBUDDY_STABLE_ACCOUNT_ID_FIELDS = ['uid', 'uin', 'oneidAccountId'] as const;
const CODEBUDDY_STABLE_IDENTITY_FIELDS = ['enterpriseId', 'accountType', 'idp'] as const;

function codeBuddyStableAccountFieldValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function codeBuddyStableAccountField(key: string, authState: ParsedCodeBuddyAuth): string | undefined {
  const activeAccount = authState.root.account;
  if (activeAccount && typeof activeAccount === 'object' && !Array.isArray(activeAccount)) {
    const direct = codeBuddyStableAccountFieldValue((activeAccount as Record<string, unknown>)[key]);
    if (direct !== undefined) return direct;
  }
  const legacyAccount = authState.authObject?.account;
  if (legacyAccount && typeof legacyAccount === 'object' && !Array.isArray(legacyAccount)) {
    const nested = codeBuddyStableAccountFieldValue((legacyAccount as Record<string, unknown>)[key]);
    if (nested !== undefined) return nested;
  }
  const direct = codeBuddyStableAccountFieldValue(authState.authObject?.[key]);
  if (direct !== undefined) return direct;
  return codeBuddyStableAccountFieldValue(authState.root[`auth.${key}`]);
}

function codeBuddyStableAccountIdentity(authState: ParsedCodeBuddyAuth): CodeBuddyStableIdentity | undefined {
  let primaryId: string | undefined;
  for (const field of CODEBUDDY_STABLE_ACCOUNT_ID_FIELDS) {
    primaryId = codeBuddyStableAccountField(field, authState);
    if (primaryId !== undefined) break;
  }
  if (primaryId === undefined) return undefined;
  const identity: CodeBuddyStableIdentity = { primaryId };
  for (const field of CODEBUDDY_STABLE_IDENTITY_FIELDS) {
    const value = codeBuddyStableAccountField(field, authState);
    if (value !== undefined) identity[field] = value;
  }
  return identity;
}

const CODEBUDDY_STABLE_SCOPE_VERSION = 'cbv1';

/**
 * One-way versioned digest over normalized stable identity plus the auth
 * domain and classified environment. Access/refresh tokens, expiry and
 * user-facing names never enter the digest and no raw identifier/domain is
 * ever returned - only an opaque `cbv1:` prefixed hex digest. The caller
 * leaves scope undefined when no stable account id exists rather than
 * degrading to token/domain-only identity.
 */
function codeBuddyStableScope(
  identity: CodeBuddyStableIdentity,
  domain: string | undefined,
  environment: CodeBuddyEnvironment,
): string {
  const payload: Record<string, string> = { id: identity.primaryId };
  if (identity.enterpriseId !== undefined) payload.enterpriseId = identity.enterpriseId;
  if (identity.accountType !== undefined) payload.accountType = identity.accountType;
  if (identity.idp !== undefined) payload.idp = identity.idp;
  if (domain !== undefined) payload.domain = domain;
  payload.environment = environment;
  const canonical = `${CODEBUDDY_STABLE_SCOPE_VERSION}:${JSON.stringify(payload)}`;
  return `${CODEBUDDY_STABLE_SCOPE_VERSION}:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Private per-credential native CodeBuddy Gateway headers keyed by the
 * credential object identity (a WeakMap value, never an enumerable property),
 * so the active snapshot and the runtime credential share the same
 * atomically-read account context without ever exposing an identifier on the
 * public credential or snapshot shape. Populated only from the single
 * auth-file read already used to build each credential; never read anywhere
 * except the openai_chat auth-header path.
 */
const codeBuddyNativeHeaders = new WeakMap<ProviderCredential, Readonly<Record<string, string>>>();

/** Native Gateway header names, emitted only on a CodeBuddy openai_chat capability. */
const CODEBUDDY_NATIVE_HEADER_NAMES = ['X-User-Id', 'X-Enterprise-Id', 'X-Tenant-Id', 'X-Domain'] as const;

/**
 * Builds the optional native Gateway headers from one already-parsed
 * CodeBuddy auth read. Values come only from validated, nonempty fields
 * (account.uid, account.enterpriseId, auth.domain across both nested and
 * flat forms) and any value containing CR/LF is rejected to prevent header
 * injection. No fabricated values are produced; absent fields are omitted.
 */
function codeBuddyNativeAuthHeaders(authState: ParsedCodeBuddyAuth): Readonly<Record<string, string>> | undefined {
  const validated = (value: string | undefined): string | undefined => {
    if (value === undefined || /[\r\n]/u.test(value)) return undefined;
    return value;
  };
  const userId = validated(codeBuddyStableAccountField('uid', authState));
  const enterpriseId = validated(codeBuddyStableAccountField('enterpriseId', authState));
  const domain = validated(authState.domain);
  if (userId === undefined && enterpriseId === undefined && domain === undefined) return undefined;
  const headers: Record<string, string> = {};
  if (userId !== undefined) headers['X-User-Id'] = userId;
  if (enterpriseId !== undefined) {
    headers['X-Enterprise-Id'] = enterpriseId;
    headers['X-Tenant-Id'] = enterpriseId;
  }
  if (domain !== undefined) headers['X-Domain'] = domain;
  return headers;
}

/**
 * Binds one already-read credential, its normalized environment, an optional
 * versioned stable scope, and read-free mapping/free closures into a single
 * immutable snapshot.
 */
function freezeCodeBuddyActiveSnapshot(
  credential: ProviderCredential,
  environment: CodeBuddyEnvironment,
  identity: CodeBuddyStableIdentity | undefined,
  domain: string | undefined,
): CodeBuddyActiveSnapshot {
  const stableScope = identity === undefined ? undefined : codeBuddyStableScope(identity, domain, environment);
  const frozenCredential = Object.freeze(credential);
  return Object.freeze({
    provider: 'codebuddy',
    credential: frozenCredential,
    environment,
    stableScope,
    resolveUpstreamModel(model: string): string {
      return codeBuddyUpstreamResolve(environment, model);
    },
    freeSupply(model: string): RoutingFreeSupplyFact | undefined {
      return evaluateCodeBuddyFreeSupply(environment, model);
    },
  });
}

function codeBuddyProductCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  explicitPath: string | undefined,
): string[] {
  const candidates: string[] = [];
  const add = (path: string | undefined): void => {
    const normalized = path?.trim();
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  add(explicitPath);
  add(env.ACC_PRODUCT_CONFIG_PATH);
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (platform === 'win32') {
      add(join(directory, 'node_modules', '@tencent-ai', 'codebuddy-code', 'product.json'));
    }
    add(join(directory, platform === 'win32' ? 'codebuddy.cmd' : 'codebuddy'));
  }
  return candidates;
}

async function resolveCodeBuddyProductPaths(
  candidates: readonly string[],
  realpath: (path: string) => Promise<string>,
): Promise<string[]> {
  const productPaths: string[] = [];
  const addProductPath = (path: string): void => {
    if (!productPaths.includes(path)) productPaths.push(path);
  };
  for (const candidate of candidates) {
    if (candidate.endsWith('.json')) {
      addProductPath(candidate);
      continue;
    }
    try {
      addProductPath(join(dirname(await realpath(candidate)), '..', 'product.json'));
    } catch { /* unavailable PATH entry */ }
  }
  return productPaths;
}

async function loadCodeBuddyAuthenticationAttributes(
  candidates: readonly string[],
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
  realpath: (path: string) => Promise<string>,
): Promise<CodeBuddyAuthenticationAttributes | undefined> {
  for (const path of await resolveCodeBuddyProductPaths(candidates, realpath)) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const authentication = parsed.authentication;
      if (!authentication || typeof authentication !== 'object' || Array.isArray(authentication)) continue;
      const attributes = (authentication as Record<string, unknown>).attributes;
      if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) continue;
      return attributes as CodeBuddyAuthenticationAttributes;
    } catch { /* try the next installed product candidate */ }
  }
  return undefined;
}

/**
 * Installed CodeBuddy client product identity from one resolved product.json
 * and its sibling package.json. The official CLI resolves its client info the
 * same way: `platform`/`productName` come from the product configuration and
 * the version falls back to the installed package, where a publish-time custom
 * package version wins over the plain package version. Nothing here reads auth
 * state, so no credential or account identity is involved.
 */
async function loadCodeBuddyClientIdentity(
  candidates: readonly string[],
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
  realpath: (path: string) => Promise<string>,
): Promise<CodeBuddyClientIdentity | undefined> {
  for (const path of await resolveCodeBuddyProductPaths(candidates, realpath)) {
    try {
      const product = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const platform = nonEmptyString(product.platform);
      const productName = nonEmptyString(product.productName);
      if (platform === undefined || productName === undefined) continue;
      const deploymentType = nonEmptyString(product.deploymentType) ?? 'SaaS';
      let version = nonEmptyString(product.productVersion);
      if (version === undefined) {
        try {
          const manifest = JSON.parse(await readFile(join(dirname(path), 'package.json'), 'utf8')) as Record<string, unknown>;
          const publishConfig = manifest.publishConfig as { customPackage?: { version?: unknown } } | undefined;
          version = nonEmptyString(publishConfig?.customPackage?.version) ?? nonEmptyString(manifest.version);
        } catch { /* fall through to the next product candidate */ }
      }
      if (version === undefined) continue;
      return { platform, productName, version, deploymentType };
    } catch { /* try the next installed product candidate */ }
  }
  return undefined;
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
  const codeBuddyEnvironments = new WeakMap<ProviderCredential, CodeBuddyEnvironment>();
  return {
    async credential(provider) {
      let path: string;
      if (provider.credentialResolver === 'forge-managed') {
        path = runtimeAuthPath(env, home);
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
      if (provider.credentialResolver === 'codebuddy') {
        path = codeBuddyAuthPath(platform, env, home);
        try {
          const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
          const authState = parseCodeBuddyAuth(parsed);
          if (!authState.accessToken) return undefined;
          const attributes = await loadCodeBuddyAuthenticationAttributes(
            codeBuddyProductCandidates(env, platform, options.codeBuddyProductPath),
            readFile,
            realpath,
          );
          const credential = { value: authState.accessToken };
          codeBuddyEnvironments.set(credential, classifyCodeBuddyEnvironment(attributes, authState.domain));
          const nativeHeaders = codeBuddyNativeAuthHeaders(authState);
          if (nativeHeaders) codeBuddyNativeHeaders.set(credential, nativeHeaders);
          return credential;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    resolveUpstreamModel(provider, model, credential) {
      // Kimi Coding canonical ids translate to their official wire ids
      // unconditionally: the mapping depends only on the model, never on which
      // credential is active, so it must not be gated on a credential.
      if (provider.id === 'kimi-coding') return kimiCodingUpstreamWireModel(model);
      if (provider.id !== 'codebuddy' || !credential) return model;
      return codeBuddyUpstreamResolve(codeBuddyEnvironments.get(credential), model);
    },
    publicResponseModel(provider, model, upstreamModel, publicModel) {
      const logicalModel = publicModel.startsWith(`${provider.id}/`)
        ? publicModel.slice(provider.id.length + 1)
        : publicModel;
      return model === upstreamModel || model === logicalModel ? publicModel : model;
    },
    freeSupply(provider, model, credential) {
      if (provider.id === 'codebuddy') return evaluateCodeBuddyFreeSupply(codeBuddyEnvironments.get(credential), model);
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
    async codeBuddySnapshot(provider) {
      if (provider.id !== 'codebuddy' || provider.credentialResolver !== 'codebuddy') return undefined;
      try {
        const path = codeBuddyAuthPath(platform, env, home);
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const authState = parseCodeBuddyAuth(value as Record<string, unknown>);
        if (!authState.accessToken) return undefined;
        const attributes = await loadCodeBuddyAuthenticationAttributes(
          codeBuddyProductCandidates(env, platform, options.codeBuddyProductPath),
          readFile,
          realpath,
        );
        const environment = classifyCodeBuddyEnvironment(attributes, authState.domain);
        const credential = Object.freeze({ value: authState.accessToken });
        codeBuddyEnvironments.set(credential, environment);
        const nativeHeaders = codeBuddyNativeAuthHeaders(authState);
        if (nativeHeaders) codeBuddyNativeHeaders.set(credential, nativeHeaders);
        return freezeCodeBuddyActiveSnapshot(
          credential,
          environment,
          codeBuddyStableAccountIdentity(authState),
          authState.domain,
        );
      } catch {
        return undefined;
      }
    },
    async codeBuddyClientIdentity(provider) {
      if (provider.id !== 'codebuddy' || provider.credentialResolver !== 'codebuddy') return undefined;
      return loadCodeBuddyClientIdentity(
        codeBuddyProductCandidates(env, platform, options.codeBuddyProductPath),
        readFile,
        realpath,
      );
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
  if (provider.id === 'codebuddy' && provider.credentialResolver === 'codebuddy' && protocol === 'openai_chat') {
    const nativeHeaders = codeBuddyNativeHeaders.get(credential);
    if (nativeHeaders) {
      for (const name of CODEBUDDY_NATIVE_HEADER_NAMES) {
        const value = nativeHeaders[name];
        if (value !== undefined) headers.set(name, value);
      }
    }
  }
  return headers;
}
