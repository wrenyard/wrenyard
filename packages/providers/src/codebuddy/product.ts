import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { codeBuddyAuthPath, parseCodeBuddyAuth } from './auth.ts';

export type CodeBuddyEnvironment = 'internal' | 'ioa' | 'cloudhosted' | 'external' | 'unknown';

export interface CodeBuddyAuthenticationAttributes {
  internalDomain?: unknown;
  iOADomain?: unknown;
  cloudHostedDomain?: unknown;
  externalDomain?: unknown;
}

export interface CodeBuddyProductModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly credits?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly supportsImages?: boolean;
  readonly supportsReasoning?: boolean;
}

export interface LoadedCodeBuddyProductModels {
  readonly environment: CodeBuddyEnvironment;
  readonly productPath: string | undefined;
  readonly entries: readonly CodeBuddyProductModelEntry[];
  readonly upstreamByCanonical: Readonly<Record<string, string>>;
}

const IOA_SUFFIX = '-ioa';

export function codeBuddyCanonicalModelId(productId: string): string {
  return productId.endsWith(IOA_SUFFIX) ? productId.slice(0, -IOA_SUFFIX.length) : productId;
}

export function codeBuddyProductModelsPath(productJsonPath: string, environment: CodeBuddyEnvironment): string {
  if (environment === 'ioa') return join(dirname(productJsonPath), 'product.ioa.json');
  return productJsonPath;
}

export function codeBuddyProductCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  explicitPath?: string,
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

export async function resolveCodeBuddyProductPaths(
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

function resolveCodeBuddyProductPathsSync(candidates: readonly string[]): string[] {
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
      addProductPath(join(dirname(realpathSync(candidate)), '..', 'product.json'));
    } catch { /* unavailable PATH entry */ }
  }
  return productPaths;
}

export function classifyCodeBuddyEnvironment(
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

export function parseCodeBuddyProductModels(value: unknown): CodeBuddyProductModelEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const models = (value as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  const entries: CodeBuddyProductModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
    seen.add(id);
    entries.push({
      id,
      ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
      ...(typeof record.credits === 'string' ? { credits: record.credits } : {}),
      ...(finitePositive(record.maxInputTokens) ? { maxInputTokens: record.maxInputTokens as number } : {}),
      ...(finitePositive(record.maxOutputTokens) ? { maxOutputTokens: record.maxOutputTokens as number } : {}),
      ...(typeof record.supportsImages === 'boolean' ? { supportsImages: record.supportsImages } : {}),
      ...(typeof record.supportsReasoning === 'boolean' ? { supportsReasoning: record.supportsReasoning } : {}),
    });
  }
  return entries;
}

export function productCreditsAreFree(credits: string | undefined): boolean {
  if (!credits) return false;
  const match = /^x(\d+(?:\.\d+)?)/iu.exec(credits.trim());
  return match !== null && Number(match[1]) === 0;
}

/**
 * Read the installed CodeBuddy product catalog. iOA identity uses the sibling
 * `product.ioa.json` model list; every other classified environment uses
 * `product.json`. Missing files yield an empty product list so local custom
 * models still register.
 */
export function loadInstalledCodeBuddyProductModels(
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    platform?: NodeJS.Platform;
    productPath?: string;
  } = {},
): LoadedCodeBuddyProductModels {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const empty: LoadedCodeBuddyProductModels = {
    environment: 'unknown',
    productPath: undefined,
    entries: [],
    upstreamByCanonical: {},
  };
  const productJson = readFirstJsonObject(
    resolveCodeBuddyProductPathsSync(codeBuddyProductCandidates(env, platform, options.productPath)),
  );
  if (!productJson) return empty;
  const environment = classifyInstalledEnvironment(platform, env, home, productJson.value);
  const modelsPath = codeBuddyProductModelsPath(productJson.path, environment);
  const modelsJson = modelsPath === productJson.path
    ? productJson.value
    : (readJsonObject(modelsPath) ?? productJson.value);
  const entries = parseCodeBuddyProductModels(modelsJson);
  const upstreamByCanonical: Record<string, string> = {};
  for (const entry of entries) {
    const canonical = codeBuddyCanonicalModelId(entry.id);
    if (canonical !== entry.id) upstreamByCanonical[canonical] = entry.id;
  }
  return {
    environment,
    productPath: modelsPath,
    entries,
    upstreamByCanonical,
  };
}

function classifyInstalledEnvironment(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  product: Record<string, unknown>,
): CodeBuddyEnvironment {
  try {
    const auth = parseCodeBuddyAuth(JSON.parse(readFileSync(codeBuddyAuthPath(platform, env, home), 'utf8')) as Record<string, unknown>);
    return classifyCodeBuddyEnvironment(authenticationAttributes(product), auth.domain);
  } catch {
    return 'unknown';
  }
}

export function authenticationAttributes(
  product: Record<string, unknown>,
): CodeBuddyAuthenticationAttributes | undefined {
  const authentication = product.authentication;
  if (!authentication || typeof authentication !== 'object' || Array.isArray(authentication)) return undefined;
  const attributes = (authentication as Record<string, unknown>).attributes;
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return undefined;
  return attributes as CodeBuddyAuthenticationAttributes;
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

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readFirstJsonObject(paths: readonly string[]): { path: string; value: Record<string, unknown> } | undefined {
  for (const path of paths) {
    const value = readJsonObject(path);
    if (value) return { path, value };
  }
  return undefined;
}
