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
    /** The row's `reasoning` declaration: adjustable levels, the disable switch, or one fixed level. */
    readonly reasoning?: CodeBuddyReasoningDeclaration;
}
/** A `/v3/config` row's reasoning declaration, kept as the endpoint states it. */
export interface CodeBuddyReasoningDeclaration {
    readonly supportedEfforts?: readonly string[];
    readonly canDisableThinking?: boolean;
    /** A single level the row always runs at, when it declares no adjustable ladder. */
    readonly effort?: string;
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
    const account = auth.parsed && auth.parsed.accessToken ? codeBuddyAccountContext(auth.parsed, environment) : undefined;
    const base = {
        environment,
        ...(executable ? { executable } : {}),
        ...(identity ? { version: identity.version, identity, installationRoot: dirname(productJson.path) } : { installationRoot: dirname(productJson.path) }),
    };
    // The installed client loads exactly ONE environment overlay beside
    // product.json (`product.<environment>.json`, lower-cased). Only that
    // overlay supplies the environment's own endpoint; overlays of other
    // environments are never merged in, and an environment without an overlay
    // (external/unknown) keeps the base product file. Neither file supplies the
    // model list any more.
    const overlay = environmentOverlay(environment);
    let endpointJson = productJson.value;
    if (overlay) {
        const overlayJson = await readJson(join(dirname(productJson.path), overlay));
        if (!overlayJson)
            return { product: { status: 'unavailable', reason: `${overlay} is missing or unreadable`, ...base, entries: [] }, ...(account ? { account } : {}), authentication: auth.authentication };
        endpointJson = overlayJson;
    }
    // The offerable models are the signed-in account's live `/v3/config` result
    // for the selected environment's endpoint — the same endpoint and request
    // the installed client itself uses. The product files contribute only the
    // endpoint (overlay first, base file as fallback) plus the installation,
    // auth, environment and version metadata. A failed request never falls back
    // to a bundled or cached model list; it reports an unavailable snapshot.
    const models = await readConfigModels(productEndpoint(endpointJson) ?? productEndpoint(productJson.value), account, identity, options);
    if ('reason' in models)
        return { product: { status: 'unavailable', reason: models.reason, ...base, entries: [] }, ...(account ? { account } : {}), authentication: auth.authentication };
    return {
        product: { status: 'ready', ...base, entries: models.entries },
        ...(account ? { account } : {}),
        authentication: auth.authentication,
    };
}
/**
 * The current signed-in account read straight from the CodeBuddy auth file for
 * a resolved environment. Unlike readCodeBuddyInstall this reads ONLY the auth
 * file — no product file, no `/v3/config` request — so a caller can refresh a
 * rotated token cheaply on every credential use, and a quota-only caller never
 * triggers a model discovery request. A missing file (ENOENT) or an auth state
 * without an access token yields undefined; any other read or JSON parse error
 * propagates so the caller can tell a transient unreadable file from a
 * signed-out account.
 */
export async function readCodeBuddyAccount(environment: CodeBuddyEnvironment, options?: InspectOptions): Promise<CodeBuddyAccountContext | undefined> {
    const env = options?.env ?? process.env;
    const platform = process.platform;
    const home = codeBuddyHome(env);
    let content: string;
    try {
        content = await readFile(codeBuddyAuthPath(platform, env, home), 'utf8');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    }
    const parsed = parseCodeBuddyAuth(JSON.parse(content) as Record<string, unknown>);
    return codeBuddyAccountContext(parsed, environment);
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
/** The installed client's own deadline for one `/v3/config` request. */
const CODEBUDDY_CONFIG_TIMEOUT_MS = 5000;
/**
 * The service origin declared by an installed product file. The environment
 * overlay wins over the base file; the origin is used so a declared trailing
 * slash never doubles up with the request path, and a value that is not an
 * absolute HTTP(S) URL is rejected rather than sent a credential.
 */
function productEndpoint(product: Record<string, unknown>): string | undefined {
    const endpoint = nonEmpty(product.endpoint);
    if (!endpoint)
        return undefined;
    try {
        const url = new URL(endpoint);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
    }
    catch {
        return undefined;
    }
}
type CodeBuddyConfigModels = { readonly entries: CodeBuddyProductModelEntry[] } | { readonly reason: string };
/**
 * Fetch the account's offerable models from the effective endpoint. Every
 * failure — a signed-out account, a missing endpoint or version, a timeout, an
 * HTTP or transport error, a rejected response, or an unusable shape — becomes
 * a safe reason with NO model rows: the caller must never fall back to a
 * bundled or cached list. No response body, token, cookie or auth header value
 * is ever surfaced.
 */
async function readConfigModels(
    endpoint: string | undefined,
    account: CodeBuddyAccountContext | undefined,
    identity: CodeBuddyProductIdentity | undefined,
    options: InspectOptions | undefined,
): Promise<CodeBuddyConfigModels> {
    if (!account)
        return { reason: 'not signed in' };
    if (!endpoint)
        return { reason: 'product endpoint is missing' };
    const version = identity?.version;
    if (!version)
        return { reason: 'product version is unavailable' };
    const headers = new Headers({
        authorization: `Bearer ${account.accessToken}`,
        accept: 'application/json',
        'x-product': identity?.deploymentType ?? 'SaaS',
        // This endpoint rejects a request whose User-Agent omits the versioned
        // product tokens; the installed CLI sends exactly this pair.
        'user-agent': `CLI/${version} CodeBuddy/${version}`,
    });
    for (const [name, value] of Object.entries(account.headers ?? {}))
        headers.set(name, value);
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? CODEBUDDY_CONFIG_TIMEOUT_MS);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
        response = await fetch(`${endpoint}/v3/config`, { method: 'GET', headers, signal, redirect: 'error' });
    }
    catch (error) {
        return { reason: (error as Error)?.name === 'TimeoutError' ? 'configuration request timed out' : 'configuration request failed' };
    }
    if (!response.ok) {
        await response.body?.cancel();
        return { reason: response.status === 401 || response.status === 403 ? 'authentication required' : 'configuration request failed' };
    }
    let payload: unknown;
    try {
        payload = await response.json();
    }
    catch {
        return { reason: 'configuration response was malformed' };
    }
    const entries = configModelEntries(payload);
    if (!entries)
        return { reason: 'configuration response was rejected' };
    return entries.length ? { entries } : { reason: 'configuration offered no models' };
}
/**
 * The offerable model rows of a `/v3/config` envelope. The configuration's
 * `cli` agent names, in the endpoint's own order, the models the signed-in
 * account may run; every named row is resolved against the configuration's
 * model metadata. A missing, non-numeric or non-zero business code, a missing
 * `data`/`models` shape, or any other unexpected payload yields undefined so the
 * caller reports an unavailable snapshot instead of silently showing an empty
 * catalog.
 */
function configModelEntries(payload: unknown): CodeBuddyProductModelEntry[] | undefined {
    if (!isRecord(payload))
        return undefined;
    if (payload.code !== 0)
        return undefined;
    const data = isRecord(payload.data) ? payload.data : undefined;
    if (!data || !Array.isArray(data.models))
        return undefined;
    return parseModels({ models: cliAgentRows(data) });
}
function cliAgentRows(data: Record<string, unknown>): unknown[] {
    const agents = (Array.isArray(data.agents) ? data.agents : []).filter(isRecord);
    // The session's models come from the agent the product identifies as its CLI
    // agent; the default-tagged agent is the same one it falls back to.
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
            ...(parseReasoning(record.reasoning) ? { reasoning: parseReasoning(record.reasoning)! } : {}),
        });
    }
    return entries;
}
function parseReasoning(value: unknown): CodeBuddyReasoningDeclaration | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const supportedEfforts = Array.isArray(record.supportedEfforts)
        ? record.supportedEfforts.filter((level): level is string => typeof level === 'string' && level.trim() !== '').map((level) => level.trim())
        : [];
    const declaration = {
        ...(supportedEfforts.length > 0 ? { supportedEfforts } : {}),
        ...(typeof record.canDisableThinking === 'boolean' ? { canDisableThinking: record.canDisableThinking } : {}),
        ...(typeof record.effort === 'string' && record.effort.trim() !== '' ? { effort: record.effort.trim() } : {}),
    };
    return Object.keys(declaration).length > 0 ? declaration : undefined;
}
function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function positive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
