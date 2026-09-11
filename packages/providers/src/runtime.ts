import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Catalog, DispatchPlan, ProviderDefinition } from '@wrenyard/catalog';
import { deriveTaskDispatchPlans } from './catalog.ts';

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
 * one exact model. Only the iOA environment plus the exact HY3/HY4 canonical
 * or wire ids ever qualify; every other model, environment and provider
 * resolves to undefined. Shared by the runtime surface and the active
 * snapshot so free facts cannot diverge.
 */
function evaluateCodeBuddyFreeSupply(environment: CodeBuddyEnvironment | undefined, model: string): RoutingFreeSupplyFact | undefined {
  if (environment !== 'ioa') return undefined;
  const wireModel = codeBuddyUpstreamWireModel(model);
  if (wireModel !== 'hy3-ioa' && wireModel !== 'hy4-preview-ioa') return undefined;
  return {
    confirmedFree: true,
    source: 'codebuddy.credential_environment',
    ruleId: 'codebuddy.verified_hy_model_confirmed_free',
  };
}

/**
 * Confirmed-free evaluation for forge-managed free-pool providers. Only an
 * already-loaded, non-empty authenticated managed credential together with one
 * of the exact declared zero-price model ids ever qualifies; the model must
 * belong to the provider's registered models and reference all three token
 * prices exactly zero. opencode-go, anonymous/empty credentials, undeclared
 * paid models, arbitrary ``:free`` names, and any model missing a zero price
 * resolve to undefined.
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
  const pricing = definition.pricing;
  if (
    !pricing ||
    pricing.inputUsdPerMillion !== 0 ||
    pricing.cachedInputUsdPerMillion !== 0 ||
    pricing.outputUsdPerMillion !== 0
  ) {
    return undefined;
  }
  if (provider.id === 'opencode-zen') {
    if (model !== 'mimo-v2.5-free' && model !== 'ling-3.0-flash-fin-free') return undefined;
    return {
      confirmedFree: true,
      source: 'opencode.zen.official',
      ruleId: 'opencode-zen.free_model_confirmed_free',
    };
  }
  if (provider.id === 'openrouter') {
    if (model !== 'nex-agi/nex-n2.5-mini:free' && model !== 'cohere/north-mini-code:free') return undefined;
    return {
      confirmedFree: true,
      source: 'openrouter.official',
      ruleId: 'openrouter.free_model_confirmed_free',
    };
  }
  return undefined;
}

function runtimeAuthPath(env: NodeJS.ProcessEnv, home: string): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  return join(dataHome, 'wrenyard', 'runtime', 'auth.json');
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

async function loadCodeBuddyAuthenticationAttributes(
  candidates: readonly string[],
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
  realpath: (path: string) => Promise<string>,
): Promise<CodeBuddyAuthenticationAttributes | undefined> {
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
  for (const path of productPaths) {
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
        try {
          const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, { key?: unknown }>;
          const value = nonEmptyString(parsed?.[provider.id]?.key);
          return value ? { value } : undefined;
        } catch {
          return undefined;
        }
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
  };
}

// Compile Catalog-derived task dispatch plans into runtime plans. Preserves the
// public canonical model id in plan.model and puts the private CodeBuddy iOA
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
    if (plan.mode !== 'native') return [target, plan] as const;
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
