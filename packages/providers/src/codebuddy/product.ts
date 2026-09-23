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

const IOA_SUFFIX = '-ioa';
const LONG_CONTEXT_SUFFIX = '-1m';
const WIRE_SUFFIXES = [IOA_SUFFIX, LONG_CONTEXT_SUFFIX] as const;

/**
 * Strip the provider-private channel (`-ioa`) and long-context (`-1m`) wire
 * suffixes in either order, yielding the lookup identity of a product id.
 */
export function codeBuddyCanonicalModelId(productId: string): string {
  let id = productId;
  for (;;) {
    const suffix = WIRE_SUFFIXES.find((candidate) => id.endsWith(candidate));
    if (suffix === undefined) return id;
    id = id.slice(0, -suffix.length);
  }
}

/** True when a product id declares the long-context (`-1m`) variant, in either suffix order. */
export function codeBuddyHasLongContextVariant(productId: string): boolean {
  const base = productId.endsWith(IOA_SUFFIX) ? productId.slice(0, -IOA_SUFFIX.length) : productId;
  return base.endsWith(LONG_CONTEXT_SUFFIX);
}

export function classifyCodeBuddyEnvironment(
  attributes: CodeBuddyAuthenticationAttributes | undefined,
  domain: string | undefined,
): CodeBuddyEnvironment {
  if (!attributes || !domain) return 'unknown';
  if (domainListMatches(attributes.internalDomain, domain)) return 'internal';
  if (domainListMatches(attributes.iOADomain, domain)) return 'ioa';
  if (domainListMatches(attributes.cloudHostedDomain, domain)) return 'cloudhosted';
  if (domainListMatches(attributes.externalDomain, domain)) return 'external';
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

export function authenticationAttributes(
  product: Record<string, unknown>,
): CodeBuddyAuthenticationAttributes | undefined {
  const authentication = product.authentication;
  if (!authentication || typeof authentication !== 'object' || Array.isArray(authentication)) return undefined;
  const attributes = (authentication as Record<string, unknown>).attributes;
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return undefined;
  return attributes as CodeBuddyAuthenticationAttributes;
}

function domainMatches(pattern: string, domain: string): boolean {
  if (pattern === domain) return true;
  if (!pattern.includes('*')) return false;
  const expression = pattern.replace(/\./gu, '\\.').replace(/\*/gu, '[^.]*');
  return new RegExp(`^${expression}$`, 'u').test(domain);
}

function domainListMatches(value: unknown, domain: string): boolean {
  const patterns = Array.isArray(value) ? value : [value];
  return patterns.some((pattern) => typeof pattern === 'string' && domainMatches(pattern, domain));
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
