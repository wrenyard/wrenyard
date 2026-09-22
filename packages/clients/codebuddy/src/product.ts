import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { ClientStatus, InspectOptions } from '@wrenyard/agent-client';
import { findExecutable } from '@wrenyard/agent-client';
import { codeBuddyAccountContext, codeBuddyAccountUserId, codeBuddyAuthPath, codeBuddyHome, parseCodeBuddyAuth, type CodeBuddyAccountContext, type CodeBuddyEnvironment } from './account.ts';
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
    // The product must belong to the installation actually selected: the
    // resolved executable's own package is tried first, and a configured
    // executable pins the search to that installation instead of letting a
    // stale global npm PATH entry answer for it.
    const productJson = await readFirstProduct(await productPaths(env, platform, executable, Boolean(options?.executable?.trim())));
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
    // The installed client loads exactly ONE environment overlay beside
    // product.json (`product.<environment>.json`, lower-cased). Only that
    // overlay supplies the environment's models — overlays of other
    // environments are never merged in, and an environment without an overlay
    // (external/unknown) keeps the base product file.
    const overlay = environmentOverlay(environment);
    let modelsJson = productJson.value;
    if (overlay) {
        const overlayJson = await readJson(join(dirname(productJson.path), overlay));
        if (!overlayJson)
            return { product: { status: 'unavailable', reason: `${overlay} is missing or unreadable`, ...base, entries: [] }, account: auth.account ? codeBuddyAccountContext(auth.parsed!, environment) : undefined, authentication: auth.authentication };
        modelsJson = overlayJson;
    }
    // The selected overlay is the environment's own installed model list and the
    // fallback. The account's cached server product configuration — what the CLI
    // itself fetched and offers for the signed-in account — is newer than the
    // shipped overlay, so when it is selectable its rows replace the overlay's
    // entirely; the two lists are never merged.
    const cached = await readCachedServerModels(env, home, auth.parsed ? codeBuddyAccountUserId(auth.parsed) : undefined);
    return {
        product: { status: 'ready', ...base, entries: cached ?? parseModels(modelsJson) },
        ...(auth.parsed && auth.parsed.accessToken ? { account: codeBuddyAccountContext(auth.parsed, environment) } : {}),
        authentication: auth.authentication,
    };
}
/**
 * The single `product.<environment>.json` overlay the installed CLI reads for a
 * resolved environment. `external` and `unknown` declare no overlay, so they
 * keep the base product file.
 */
function environmentOverlay(environment: CodeBuddyEnvironment): string | undefined {
    if (environment === 'ioa' || environment === 'internal' || environment === 'cloudhosted')
        return `product.${environment}.json`;
    return undefined;
}
async function resolveExecutable(options?: InspectOptions): Promise<string | undefined> {
    const status = await findExecutable(['codebuddy'], options);
    return status.installation.state === 'installed' ? status.installation.executable : undefined;
}
/**
 * Product candidates owned by one already-resolved executable. A symlinked bin
 * resolves into `<package>/bin` (package root is one level up); an npm-global
 * `.cmd` shim is a real file beside `node_modules`, so the package layout
 * relative to the executable's own directory is tried too. The executable is
 * always absolute and already realpath-normalized by discovery.
 */
function executableProductPaths(executable: string | undefined): string[] {
    const resolved = executable?.trim();
    if (!resolved)
        return [];
    if (resolved.endsWith('.json'))
        return [resolved];
    const directory = dirname(resolved);
    return [
        join(directory, '..', 'product.json'),
        join(directory, 'product.json'),
        join(directory, 'node_modules', '@tencent-ai', 'codebuddy-code', 'product.json'),
    ];
}
/**
 * Candidate product files in strict priority order:
 * 1. the resolved executable's own installation,
 * 2. an explicit `ACC_PRODUCT_CONFIG_PATH` override,
 * 3. the remaining PATH entries — only when no executable was configured, and
 *    never ahead of the selected installation.
 */
async function productPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, executable: string | undefined, pinned: boolean): Promise<string[]> {
    const candidates: string[] = [];
    const add = (path: string | undefined) => {
        const normalized = path?.trim();
        if (normalized && !candidates.includes(normalized))
            candidates.push(normalized);
    };
    for (const candidate of executableProductPaths(executable))
        add(candidate);
    add(env.ACC_PRODUCT_CONFIG_PATH);
    if (!pinned) {
        for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
            if (platform === 'win32')
                add(join(directory, 'node_modules', '@tencent-ai', 'codebuddy-code', 'product.json'));
            add(join(directory, platform === 'win32' ? 'codebuddy.cmd' : 'codebuddy'));
        }
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
/**
 * The cache key and entry layout of the installed CLI's cloud product
 * configuration, persisted by `CloudProductManagerImpl` through the CLI's file
 * local storage: `<configDir>/local_storage/entry_<md5(key)>.info` holds an
 * array of `{ userId, data, ts }` records (oldest first, capped at 20). The
 * record belonging to the signed-in account is the one whose `userId` equals
 * `account.uid`.
 */
const CODEBUDDY_CLOUD_PRODUCT_CACHE_KEY = 'cloud_product_config_cache';
function codeBuddyCloudProductCachePath(env: NodeJS.ProcessEnv, home: string): string {
    const configDir = env.CODEBUDDY_CONFIG_DIR?.trim() || join(home, '.codebuddy');
    const digest = createHash('md5').update(CODEBUDDY_CLOUD_PRODUCT_CACHE_KEY).digest('hex');
    return join(configDir, 'local_storage', `entry_${digest}.info`);
}
/**
 * The model rows of the signed-in account's cached server product
 * configuration, or undefined when none is selectable (absent file, unreadable
 * or corrupt payload, no record for this account, or no model rows) so the
 * caller keeps the installed overlay.
 *
 * The CLI resolves the models it offers from the product's `cli` agent: every
 * row of that agent's `models` list is looked up by id in the configuration's
 * model metadata, and an unresolvable row is dropped. The rows carry the same
 * fields the installed overlay does, so they are normalized by the same parser.
 */
async function readCachedServerModels(env: NodeJS.ProcessEnv, home: string, userId: string | undefined): Promise<CodeBuddyProductModelEntry[] | undefined> {
    if (!userId)
        return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(codeBuddyCloudProductCachePath(env, home), 'utf8'));
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed))
        return undefined;
    const record = parsed.find((item) => isRecord(item) && item.userId === userId);
    const data = record && isRecord(record.data) ? record.data : undefined;
    if (!data)
        return undefined;
    const entries = parseModels({ models: cachedAgentRows(data) });
    return entries.length ? entries : undefined;
}
function cachedAgentRows(data: Record<string, unknown>): unknown[] {
    const agents = (Array.isArray(data.agents) ? data.agents : []).filter(isRecord);
    // The CLI session's models come from the agent that product identifies as
    // its CLI agent; the default-tagged agent is the same one it falls back to.
    const agent = agents.find((entry) => entry.name === 'cli') ?? agents.find((entry) => Array.isArray(entry.tags) && entry.tags.includes('default'));
    if (!agent || !Array.isArray(agent.models))
        return [];
    const known = new Map<string, Record<string, unknown>>();
    for (const item of Array.isArray(data.models) ? data.models : []) {
        if (isRecord(item) && typeof item.id === 'string')
            known.set(item.id, item);
    }
    const rows: unknown[] = [];
    for (const item of agent.models) {
        const row = typeof item === 'string' ? known.get(item) : isRecord(item) ? item : undefined;
        if (row)
            rows.push(row);
    }
    return rows;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
