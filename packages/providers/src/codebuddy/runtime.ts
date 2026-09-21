import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import type { ProviderDefinition } from '@wrenyard/catalog';
import {
  codeBuddyAuthPath,
  codeBuddyStableAccountField,
  codeBuddyStableAccountIdentity,
  parseCodeBuddyAuth,
  type CodeBuddyStableIdentity,
  type ParsedCodeBuddyAuth,
} from './auth.ts';
import { codeBuddyProvider } from './models.ts';

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

export interface CodeBuddyCredential {
  value: string;
}

export interface CodeBuddyFreeSupplyFact {
  readonly confirmedFree: true
  readonly source: string
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
  readonly provider: 'codebuddy'
  readonly credential: CodeBuddyCredential
  readonly environment: CodeBuddyEnvironment
  readonly stableScope: string | undefined
  resolveUpstreamModel(model: string): string
  freeSupply(model: string): CodeBuddyFreeSupplyFact | undefined
}

export interface CodeBuddyRuntimeOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  codeBuddyProductPath?: string;
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  realpath: (path: string) => Promise<string>;
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

export function canonicalizeCodeBuddyObservedModelId(model: string): string {
  for (const [canonical, upstream] of Object.entries(CODEBUDDY_IOA_UPSTREAM_MODELS)) {
    if (upstream === model) return canonical;
  }
  return model;
}

function codeBuddyUpstreamResolve(environment: CodeBuddyEnvironment | undefined, model: string): string {
  if (environment !== 'ioa') return model;
  return codeBuddyUpstreamWireModel(model);
}

function evaluateCodeBuddyFreeSupply(
  environment: CodeBuddyEnvironment | undefined,
  model: string,
): CodeBuddyFreeSupplyFact | undefined {
  if (environment !== 'ioa') return undefined;
  const wireModel = codeBuddyUpstreamWireModel(model);
  const definition = codeBuddyProvider.models.find((entry) => codeBuddyUpstreamWireModel(entry.id) === wireModel);
  if (definition?.free !== true) return undefined;
  return {
    confirmedFree: true,
    source: 'codebuddy.credential_environment',
    ruleId: 'codebuddy.verified_hy_model_confirmed_free',
  };
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

function classifyCodeBuddyEnvironment(
  attributes: CodeBuddyAuthenticationAttributes | undefined,
  domain: string | undefined,
): CodeBuddyEnvironment {
  if (!attributes || !domain) return 'unknown';
  if (codeBuddyDomainListMatches(attributes.internalDomain, domain)) return 'internal';
  if (codeBuddyDomainListMatches(attributes.iOADomain, domain)) return 'ioa';
  if (codeBuddyDomainListMatches(attributes.cloudHostedDomain, domain)) return 'cloudhosted';
  if (codeBuddyDomainListMatches(attributes.externalDomain, domain)) return 'external';
  return 'unknown';
}

const CODEBUDDY_STABLE_SCOPE_VERSION = 'cbv1';

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
const codeBuddyNativeHeaders = new WeakMap<CodeBuddyCredential, Readonly<Record<string, string>>>();

const CODEBUDDY_NATIVE_HEADER_NAMES = ['X-User-Id', 'X-Enterprise-Id', 'X-Tenant-Id', 'X-Domain'] as const;

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

function freezeCodeBuddyActiveSnapshot(
  credential: CodeBuddyCredential,
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
    freeSupply(model: string): CodeBuddyFreeSupplyFact | undefined {
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

function bindCredentialHeaders(
  credential: CodeBuddyCredential,
  environment: CodeBuddyEnvironment,
  environments: WeakMap<CodeBuddyCredential, CodeBuddyEnvironment>,
  authState: ParsedCodeBuddyAuth,
): void {
  environments.set(credential, environment);
  const nativeHeaders = codeBuddyNativeAuthHeaders(authState);
  if (nativeHeaders) codeBuddyNativeHeaders.set(credential, nativeHeaders);
}

export function applyCodeBuddyNativeHeaders(
  headers: Headers,
  provider: Pick<ProviderDefinition, 'id' | 'credentialResolver'>,
  credential: CodeBuddyCredential,
  protocol: string,
): void {
  if (provider.id !== 'codebuddy' || provider.credentialResolver !== 'codebuddy' || protocol !== 'openai_chat') return;
  const nativeHeaders = codeBuddyNativeHeaders.get(credential);
  if (!nativeHeaders) return;
  for (const name of CODEBUDDY_NATIVE_HEADER_NAMES) {
    const value = nativeHeaders[name];
    if (value !== undefined) headers.set(name, value);
  }
}

export function createCodeBuddyRuntime(options: CodeBuddyRuntimeOptions) {
  const { env, home, platform, readFile, realpath } = options;
  const codeBuddyEnvironments = new WeakMap<CodeBuddyCredential, CodeBuddyEnvironment>();
  const productCandidates = () => codeBuddyProductCandidates(env, platform, options.codeBuddyProductPath);

  return {
    async credential(provider: Pick<ProviderDefinition, 'credentialResolver'>): Promise<CodeBuddyCredential | undefined> {
      if (provider.credentialResolver !== 'codebuddy') return undefined;
      try {
        const parsed = JSON.parse(await readFile(codeBuddyAuthPath(platform, env, home), 'utf8')) as Record<string, unknown>;
        const authState = parseCodeBuddyAuth(parsed);
        if (!authState.accessToken) return undefined;
        const attributes = await loadCodeBuddyAuthenticationAttributes(productCandidates(), readFile, realpath);
        const credential = { value: authState.accessToken };
        bindCredentialHeaders(
          credential,
          classifyCodeBuddyEnvironment(attributes, authState.domain),
          codeBuddyEnvironments,
          authState,
        );
        return credential;
      } catch {
        return undefined;
      }
    },
    resolveUpstreamModel(
      provider: Pick<ProviderDefinition, 'id'>,
      model: string,
      credential?: CodeBuddyCredential,
    ): string | undefined {
      if (provider.id !== 'codebuddy') return undefined;
      if (!credential) return model;
      return codeBuddyUpstreamResolve(codeBuddyEnvironments.get(credential), model);
    },
    freeSupply(
      provider: Pick<ProviderDefinition, 'id'>,
      model: string,
      credential: CodeBuddyCredential,
    ): CodeBuddyFreeSupplyFact | undefined {
      if (provider.id !== 'codebuddy') return undefined;
      return evaluateCodeBuddyFreeSupply(codeBuddyEnvironments.get(credential), model);
    },
    async codeBuddySnapshot(provider: Pick<ProviderDefinition, 'id' | 'credentialResolver'>): Promise<CodeBuddyActiveSnapshot | undefined> {
      if (provider.id !== 'codebuddy' || provider.credentialResolver !== 'codebuddy') return undefined;
      try {
        const value: unknown = JSON.parse(await readFile(codeBuddyAuthPath(platform, env, home), 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const authState = parseCodeBuddyAuth(value as Record<string, unknown>);
        if (!authState.accessToken) return undefined;
        const attributes = await loadCodeBuddyAuthenticationAttributes(productCandidates(), readFile, realpath);
        const environment = classifyCodeBuddyEnvironment(attributes, authState.domain);
        const credential = Object.freeze({ value: authState.accessToken });
        bindCredentialHeaders(credential, environment, codeBuddyEnvironments, authState);
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
    async codeBuddyClientIdentity(provider: Pick<ProviderDefinition, 'id' | 'credentialResolver'>): Promise<CodeBuddyClientIdentity | undefined> {
      if (provider.id !== 'codebuddy' || provider.credentialResolver !== 'codebuddy') return undefined;
      return loadCodeBuddyClientIdentity(productCandidates(), readFile, realpath);
    },
  };
}
