import { Executor, rpcSequence } from '@wrenyard/execution';
import { inspectCodex } from './installation.ts';

/**
 * Bounded ceiling for one `model/list` page. The listing is a small, local
 * app-server operation; a client that cannot answer within this window is
 * treated as unavailable rather than allowed to hang discovery.
 */
const MODEL_LIST_TIMEOUT_MS = 20_000;
/** Page size requested from the app-server. */
const MODEL_LIST_LIMIT = 100;
/** Hard page ceiling so a non-progressing `nextCursor` can never loop forever. */
const MAX_MODEL_PAGES = 16;

export interface CodexModelDiscoveryOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

/** A complete, non-empty listing: the wire model ids the client offers this account. */
export interface CodexModelsAvailable {
    readonly status: 'available';
    /** Wire ids the installed client listed for the signed-in account. */
    readonly models: readonly string[];
    /** The client-reported default wire id, when the listing named one. */
    readonly defaultModel?: string;
    /** Version of the client that produced the listing, for identity/invalidation. */
    readonly clientVersion?: string;
}

/**
 * The listing could not be read completely. Callers must treat this as
 * unknown, never as a deny-all: an unreachable, slow, malformed, empty, or
 * incomplete listing must not make any model ineligible.
 */
export interface CodexModelsUnknown {
    readonly status: 'unknown';
    readonly clientVersion?: string;
}

export type CodexModelDiscovery = CodexModelsAvailable | CodexModelsUnknown;

/**
 * Read the model list the installed Codex client offers the signed-in account
 * through the app-server `model/list` method, reusing the same
 * initialize / initialized / JSON-RPC lifecycle the account reader already
 * uses (no transport is reimplemented).
 *
 * Every page is requested with `includeHidden: true`, so a selectable hidden
 * model is never mistaken for unavailable. Only a complete, non-empty listing
 * is authoritative; anything less becomes `unknown`. Every process is released
 * on success, timeout, abort, and protocol failure alike (rpcSequence always
 * terminates the child). The client resolves the account itself: auth.json is
 * never read or printed here.
 */
export async function readCodexModels(options?: CodexModelDiscoveryOptions): Promise<CodexModelDiscovery> {
    const env = options?.env ?? process.env;
    const timeoutMs = positive(options?.timeoutMs) ?? MODEL_LIST_TIMEOUT_MS;
    const status = await inspectCodex({ env, signal: options?.signal, timeoutMs }).catch(() => undefined);
    if (!status || status.installation.state !== 'installed')
        return { status: 'unknown' };
    const executable = status.installation.executable;
    const clientVersion = status.installation.version;
    const unavailable = (): CodexModelsUnknown => (clientVersion ? { status: 'unknown', clientVersion } : { status: 'unknown' });

    const models: string[] = [];
    const seen = new Set<string>();
    let defaultModel: string | undefined;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const params: Record<string, unknown> = { includeHidden: true, limit: MODEL_LIST_LIMIT };
        if (cursor) params.cursor = cursor;
        let result: unknown;
        try {
            const results = await rpcSequence(new Executor(), {
                command: executable,
                args: ['app-server', '--stdio'],
                steps: [
                    { method: 'initialize', params: { clientInfo: { name: 'wrenyard', title: 'Wrenyard', version: '1' } } },
                    { method: 'initialized', notification: true },
                    { method: 'model/list', params },
                ],
            }, { env, signal: options?.signal, timeoutMs });
            result = results[2];
        } catch {
            return unavailable();
        }
        const listing = record(result);
        if (!listing || !Array.isArray(listing.data))
            return unavailable();
        for (const entry of listing.data) {
            const model = record(entry);
            if (!model) return unavailable();
            const ids = modelIds(model);
            if (ids.length === 0) return unavailable();
            for (const id of ids) {
                if (seen.has(id)) continue;
                seen.add(id);
                models.push(id);
            }
            if (model.isDefault === true && defaultModel === undefined) defaultModel = ids[0];
        }
        const next = nonEmptyString(listing.nextCursor);
        if (!next) break;
        if (next === cursor || page === MAX_MODEL_PAGES - 1) return unavailable();
        cursor = next;
    }
    if (models.length === 0) return unavailable();
    return {
        status: 'available',
        models,
        ...(defaultModel ? { defaultModel } : {}),
        ...(clientVersion ? { clientVersion } : {}),
    };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The wire ids an entry offers. The app-server names the wire id under `id`
 * and/or `model`; both are collected so a listed model is never missed.
 */
function modelIds(model: Record<string, unknown>): string[] {
    const ids: string[] = [];
    for (const key of ['id', 'model'] as const) {
        const id = nonEmptyString(model[key]);
        if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function positive(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
