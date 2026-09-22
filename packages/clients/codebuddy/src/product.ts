import { readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { ClientStatus, InspectOptions } from '@wrenyard/agent-client';
import { findExecutable } from '@wrenyard/agent-client';
import { codeBuddyAccountContext, codeBuddyAuthPath, codeBuddyHome, parseCodeBuddyAuth, type CodeBuddyAccountContext, type CodeBuddyEnvironment } from './account.ts';
export interface CodeBuddyProductModelEntry {
    readonly id: string;
    readonly name?: string;
    readonly credits?: string;
    readonly maxInputTokens?: number;
    readonly maxOutputTokens?: number;
    readonly supportsImages?: boolean;
    readonly supportsReasoning?: boolean;
}
export interface CodeBuddyProductIdentity {
    readonly platform: string;
    readonly productName: string;
    readonly version: string;
    readonly deploymentType: string;
}
export interface CodeBuddyProductSnapshot {
    readonly status: 'ready' | 'unavailable';
    readonly reason?: string;
    readonly environment: CodeBuddyEnvironment;
    readonly executable?: string;
    readonly version?: string;
    readonly installationRoot?: string;
    readonly identity?: CodeBuddyProductIdentity;
    readonly entries: readonly CodeBuddyProductModelEntry[];
}
export interface CodeBuddyInstall {
    readonly product: CodeBuddyProductSnapshot;
    readonly account?: CodeBuddyAccountContext;
    readonly authentication: ClientStatus['authentication'];
}
export async function readCodeBuddyInstall(options?: InspectOptions): Promise<CodeBuddyInstall> {
    const env = options?.env ?? process.env;
    const platform = process.platform;
    const home = codeBuddyHome(env);
    const executable = await resolveExecutable(options);
    const productJson = await readFirstProduct(await productPaths(env, platform, options?.executable));
    if (!productJson) {
        const auth = await readAuth(platform, env, home);
        return {
            product: { status: 'unavailable', reason: executable ? 'product file is missing' : 'CodeBuddy is not installed', environment: 'unknown', ...(executable ? { executable } : {}), entries: [] },
            ...(auth.parsed?.accessToken ? { account: codeBuddyAccountContext(auth.parsed, 'unknown') } : {}),
            authentication: auth.authentication,
        };
    }
    const auth = await readAuth(platform, env, home);
    const environment = classify(authenticationAttributes(productJson.value), auth.parsed?.domain);
    const identity = await readIdentity(productJson.path, productJson.value);
    const base = {
        environment,
        ...(executable ? { executable } : {}),
        ...(identity ? { version: identity.version, identity, installationRoot: dirname(productJson.path) } : { installationRoot: dirname(productJson.path) }),
    };
    if (environment === 'ioa') {
        const ioaPath = join(dirname(productJson.path), 'product.ioa.json');
        const ioa = await readJson(ioaPath);
        if (!ioa)
            return { product: { status: 'unavailable', reason: 'product.ioa.json is missing or unreadable', ...base, entries: [] }, account: auth.account ? codeBuddyAccountContext(auth.parsed!, environment) : undefined, authentication: auth.authentication };
    }
    const modelsPath = environment === 'ioa' ? join(dirname(productJson.path), 'product.ioa.json') : productJson.path;
    const modelsJson = modelsPath === productJson.path ? productJson.value : await readJson(modelsPath);
    return {
        product: { status: 'ready', ...base, entries: parseModels(modelsJson ?? {}) },
        ...(auth.parsed && auth.parsed.accessToken ? { account: codeBuddyAccountContext(auth.parsed, environment) } : {}),
        authentication: auth.authentication,
    };
}
async function resolveExecutable(options?: InspectOptions): Promise<string | undefined> {
    const status = await findExecutable(['codebuddy'], options);
    return status.installation.state === 'installed' ? status.installation.executable : undefined;
}
async function productPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, explicit?: string): Promise<string[]> {
    const candidates: string[] = [];
    const add = (path: string | undefined) => {
        const normalized = path?.trim();
        if (normalized && !candidates.includes(normalized))
            candidates.push(normalized);
    };
    add(explicit);
    add(env.ACC_PRODUCT_CONFIG_PATH);
    for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
        if (platform === 'win32')
            add(join(directory, 'node_modules', '@tencent-ai', 'codebuddy-code', 'product.json'));
        add(join(directory, platform === 'win32' ? 'codebuddy.cmd' : 'codebuddy'));
    }
    const productPaths: string[] = [];
    for (const candidate of candidates) {
        if (candidate.endsWith('.json')) {
            if (!productPaths.includes(candidate))
                productPaths.push(candidate);
            continue;
        }
        try {
            const { realpath } = await import('node:fs/promises');
            const path = join(dirname(await realpath(candidate)), '..', 'product.json');
            if (!productPaths.includes(path))
                productPaths.push(path);
        }
        catch { /* unavailable PATH entry */ }
    }
    return productPaths;
}
async function readFirstProduct(paths: readonly string[]): Promise<{ path: string; value: Record<string, unknown> } | undefined> {
    for (const path of paths) {
        const value = await readJson(path);
        if (value)
            return { path, value };
    }
    return undefined;
}
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        return parsed as Record<string, unknown>;
    }
    catch {
        return undefined;
    }
}
async function readAuth(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): Promise<{
    authentication: ClientStatus['authentication'];
    parsed?: ReturnType<typeof parseCodeBuddyAuth>;
    account?: boolean;
}> {
    try {
        const parsed = parseCodeBuddyAuth(JSON.parse(await readFile(codeBuddyAuthPath(platform, env, home), 'utf8')) as Record<string, unknown>);
        return { authentication: parsed.accessToken ? 'ready' : 'missing', parsed, account: Boolean(parsed.accessToken) };
    }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT')
            return { authentication: 'missing' };
        return { authentication: 'unknown' };
    }
}
async function readIdentity(productPath: string, product: Record<string, unknown>): Promise<CodeBuddyProductIdentity | undefined> {
    const platform = nonEmpty(product.platform);
    const productName = nonEmpty(product.productName);
    if (!platform || !productName)
        return undefined;
    let version = nonEmpty(product.productVersion);
    if (!version) {
        const manifest = await readJson(join(dirname(productPath), 'package.json'));
        const publishConfig = manifest?.publishConfig as { customPackage?: { version?: unknown } } | undefined;
        version = nonEmpty(publishConfig?.customPackage?.version) ?? nonEmpty(manifest?.version);
    }
    if (!version)
        return undefined;
    return { platform, productName, version, deploymentType: nonEmpty(product.deploymentType) ?? 'SaaS' };
}
function classify(attributes: Record<string, unknown> | undefined, domain: string | undefined): CodeBuddyEnvironment {
    if (!attributes || !domain)
        return 'unknown';
    if (domainList(attributes.internalDomain, domain))
        return 'internal';
    if (domainList(attributes.iOADomain, domain))
        return 'ioa';
    if (domainList(attributes.cloudHostedDomain, domain))
        return 'cloudhosted';
    if (domainList(attributes.externalDomain, domain))
        return 'external';
    return 'unknown';
}
function authenticationAttributes(product: Record<string, unknown>): Record<string, unknown> | undefined {
    const authentication = product.authentication;
    if (!authentication || typeof authentication !== 'object' || Array.isArray(authentication))
        return undefined;
    const attributes = (authentication as Record<string, unknown>).attributes;
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes))
        return undefined;
    return attributes as Record<string, unknown>;
}
function domainList(value: unknown, domain: string): boolean {
    const patterns = Array.isArray(value) ? value : [value];
    return patterns.some((pattern) => typeof pattern === 'string' && domainMatches(pattern, domain));
}
function domainMatches(pattern: string, domain: string): boolean {
    if (pattern === domain)
        return true;
    if (!pattern.includes('*'))
        return false;
    const expression = pattern.replace(/\./gu, '\\.').replace(/\*/gu, '[^.]*');
    return new RegExp(`^${expression}$`, 'u').test(domain);
}
function parseModels(value: Record<string, unknown>): CodeBuddyProductModelEntry[] {
    const models = value.models;
    if (!Array.isArray(models))
        return [];
    const entries: CodeBuddyProductModelEntry[] = [];
    const seen = new Set<string>();
    for (const item of models) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!id || seen.has(id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
            continue;
        seen.add(id);
        entries.push({
            id,
            ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
            ...(typeof record.credits === 'string' ? { credits: record.credits } : {}),
            ...(positive(record.maxInputTokens) ? { maxInputTokens: record.maxInputTokens } : {}),
            ...(positive(record.maxOutputTokens) ? { maxOutputTokens: record.maxOutputTokens } : {}),
            ...(typeof record.supportsImages === 'boolean' ? { supportsImages: record.supportsImages } : {}),
            ...(typeof record.supportsReasoning === 'boolean' ? { supportsReasoning: record.supportsReasoning } : {}),
        });
    }
    return entries;
}
function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function positive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
