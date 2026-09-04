import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Catalog, DispatchPlan, ProviderDefinition } from '@wrenyard/catalog';
import { resolveBuiltinDispatchPlans } from './catalog.ts';

export interface ProviderCredential {
  value: string;
}

export interface ProviderRuntime {
  credential(provider: ProviderDefinition): Promise<ProviderCredential | undefined>;
  resolveUpstreamModel(provider: ProviderDefinition, model: string, credential?: ProviderCredential): string;
  publicResponseModel(provider: ProviderDefinition, model: string, upstreamModel: string, publicModel: string): string;
  configureApiKey(provider: ProviderDefinition, key: string): Promise<void>;
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

type CodeBuddyEnvironment = 'internal' | 'ioa' | 'cloudhosted' | 'external' | 'unknown';

interface CodeBuddyAuthenticationAttributes {
  internalDomain?: unknown;
  iOADomain?: unknown;
  cloudHostedDomain?: unknown;
  externalDomain?: unknown;
}

const CODEBUDDY_IOA_UPSTREAM_MODELS: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek-v4-flash-ioa',
  'deepseek-v4-pro': 'deepseek-v4-pro-ioa',
  'hy4-preview': 'hy4-preview-ioa',
  'minimax-m3': 'minimax-m3-ioa',
};

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
          const auth = parsed.auth && typeof parsed.auth === 'object' && !Array.isArray(parsed.auth)
            ? parsed.auth as Record<string, unknown>
            : undefined;
          const nested = nonEmptyString(auth?.accessToken);
          const value = nested ?? nonEmptyString(parsed['auth.accessToken']);
          if (!value) return undefined;
          const domain = nonEmptyString(auth?.domain) ?? nonEmptyString(parsed['auth.domain']);
          const attributes = await loadCodeBuddyAuthenticationAttributes(
            codeBuddyProductCandidates(env, platform, options.codeBuddyProductPath),
            readFile,
            realpath,
          );
          const credential = { value };
          codeBuddyEnvironments.set(credential, classifyCodeBuddyEnvironment(attributes, domain));
          return credential;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    resolveUpstreamModel(provider, model, credential) {
      if (provider.id !== 'codebuddy' || !credential || codeBuddyEnvironments.get(credential) !== 'ioa') return model;
      return CODEBUDDY_IOA_UPSTREAM_MODELS[model] ?? model;
    },
    publicResponseModel(provider, model, upstreamModel, publicModel) {
      const logicalModel = publicModel.startsWith(`${provider.id}/`)
        ? publicModel.slice(provider.id.length + 1)
        : publicModel;
      return model === upstreamModel || model === logicalModel ? publicModel : model;
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
  };
}

export async function resolveBuiltinRuntimeDispatchPlans(
  catalog: Catalog,
  runtime: ProviderRuntime,
): Promise<Readonly<Record<string, DispatchPlan>>> {
  const plans = resolveBuiltinDispatchPlans(catalog);
  const credentials = new Map<string, Promise<ProviderCredential | undefined>>();
  const resolveCredential = (provider: ProviderDefinition): Promise<ProviderCredential | undefined> => {
    let pending = credentials.get(provider.id);
    if (!pending) {
      pending = runtime.credential(provider);
      credentials.set(provider.id, pending);
    }
    return pending;
  };
  return Object.fromEntries(await Promise.all(Object.entries(plans).map(async ([profile, plan]) => {
    if (plan.mode !== 'native') return [profile, plan] as const;
    const provider = catalog.provider(plan.provider);
    if (!provider) return [profile, plan] as const;
    const credential = await resolveCredential(provider);
    return [profile, { ...plan, model: runtime.resolveUpstreamModel(provider, plan.model, credential) }] as const;
  })));
}

export function upstreamAuthHeaders(provider: ProviderDefinition, credential: ProviderCredential, protocol: string): Headers {
  const capability = provider.protocols?.find((entry) => entry.protocol === protocol);
  if (!capability) throw new Error(`provider ${provider.id} does not support ${protocol}`);
  const headers = new Headers();
  if (capability.authScheme === 'x-api-key') headers.set('x-api-key', credential.value);
  else headers.set('authorization', `Bearer ${credential.value}`);
  return headers;
}
