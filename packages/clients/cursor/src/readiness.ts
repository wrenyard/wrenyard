import { readCursorCredential, type CursorCredentialOptions } from './credentials.ts';
import type { Executor } from '@wrenyard/execution';
import type {
    NativeClientReadiness,
    NativeModelAvailability,
    NativeModelAvailabilityReason,
    NativeModelAvailabilityStatus,
    ReadinessOptions,
} from '@wrenyard/agent-client';

const AVAILABLE_MODELS_ENDPOINT = 'https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels';
const AVAILABLE_MODELS_BODY = '{"useModelParameters":true,"includeHiddenModels":true,"doNotUseMarkdown":true}';
const MAX_AVAILABILITY_BODY_BYTES = 2 << 20;
const MAX_AVAILABILITY_TIMEOUT_MS = 3_000;
const MAX_MODEL_ID_LENGTH = 120;

const STATUS_AVAILABLE: NativeModelAvailabilityStatus = 'available';
const STATUS_BLOCKED: NativeModelAvailabilityStatus = 'blocked';
const STATUS_UNKNOWN: NativeModelAvailabilityStatus = 'unknown';

const REASON_ADMIN_BLOCKED: NativeModelAvailabilityReason = 'admin_blocked';
const REASON_CONSENT_REQUIRED: NativeModelAvailabilityReason = 'consent_required';
const REASON_MODEL_DISABLED: NativeModelAvailabilityReason = 'model_disabled';
const REASON_UNSUPPORTED: NativeModelAvailabilityReason = 'unsupported';

interface AvailableModel {
    name?: unknown;
    serverModelName?: unknown;
    legacySlugs?: unknown;
    idAliases?: unknown;
    variants?: unknown;
    supportsAgent?: unknown;
    degradationStatus?: unknown;
    reasonForZdrConsentBlock?: unknown;
}

/**
 * Observe the Cursor native login and, when authenticated, issue exactly one
 * non-inference AvailableModels read. A missing token is missing; any failure
 * or malformed payload yields no modelAvailability map at all (never an
 * optimistic all-available map). Only safe status/model ids leave this module.
 */
export async function readCursorReadiness(
    execution: Executor,
    options?: ReadinessOptions,
): Promise<NativeClientReadiness> {
    const credentialOptions: CursorCredentialOptions = {
        home: options?.home,
        env: options?.env,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
    };
    let token: string;
    try {
        token = await readCursorCredential(execution, credentialOptions);
    } catch {
        return { authentication: 'unknown' };
    }
    if (token.trim() === '') return { authentication: 'missing' };

    const availability = await readCursorModelAvailability(token, options);
    return {
        authentication: 'ready',
        ...(availability === undefined ? {} : { modelAvailability: availability }),
    };
}

async function readCursorModelAvailability(
    token: string,
    options?: ReadinessOptions,
): Promise<Readonly<Record<string, NativeModelAvailability>> | undefined> {
    const requested = options?.timeoutMs;
    const timeout = typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0
        ? Math.min(requested, MAX_AVAILABILITY_TIMEOUT_MS)
        : MAX_AVAILABILITY_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
        response = await fetch(AVAILABLE_MODELS_ENDPOINT, {
            method: 'POST',
            body: AVAILABLE_MODELS_BODY,
            headers: {
                'content-type': 'application/json',
                'connect-protocol-version': '1',
                authorization: 'Bearer ' + token,
            },
            redirect: 'error',
            signal,
        });
    } catch {
        return undefined;
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
    }
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_AVAILABILITY_BODY_BYTES) {
                await reader.cancel().catch(() => undefined);
                return undefined;
            }
            chunks.push(value);
        }
    } catch {
        return undefined;
    } finally {
        reader.releaseLock();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const models = (parsed as { models?: unknown }).models;
    if (!Array.isArray(models)) return undefined;
    return projectAvailability(models);
}

function projectAvailability(models: readonly unknown[]): Readonly<Record<string, NativeModelAvailability>> {
    const projected: Record<string, NativeModelAvailability> = Object.create(null) as Record<string, NativeModelAvailability>;
    for (const entry of models) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const model = entry as AvailableModel;
        const availability = classifyModel(model);
        for (const id of modelIds(model)) {
            const existing = projected[id];
            projected[id] = existing === undefined ? availability : mergeConservative(existing, availability);
        }
    }
    return Object.freeze(projected);
}

function classifyModel(model: AvailableModel): NativeModelAvailability {
    const consent = typeof model.reasonForZdrConsentBlock === 'string' ? model.reasonForZdrConsentBlock.trim() : '';
    if (consent !== '') {
        return {
            status: STATUS_BLOCKED,
            reason: consent === 'team_settings_blocked' ? REASON_ADMIN_BLOCKED : REASON_CONSENT_REQUIRED,
        };
    }
    if (degradationDisabled(model.degradationStatus)) {
        return { status: STATUS_BLOCKED, reason: REASON_MODEL_DISABLED };
    }
    if (model.supportsAgent === false) return { status: STATUS_BLOCKED, reason: REASON_UNSUPPORTED };
    if (model.supportsAgent !== true) return { status: STATUS_UNKNOWN };
    return { status: STATUS_AVAILABLE };
}

function degradationDisabled(raw: unknown): boolean {
    if (raw === undefined || raw === null) return false;
    if (typeof raw === 'string') return raw === 'DEGRADATION_STATUS_DISABLED' || raw === '2';
    return raw === 2;
}

function modelIds(model: AvailableModel): string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    const add = (value: unknown): void => {
        if (typeof value !== 'string') return;
        const id = safeModelId(value);
        if (id === undefined || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };
    add(model.name);
    add(model.serverModelName);
    for (const slug of stringArray(model.legacySlugs)) add(slug);
    for (const alias of stringArray(model.idAliases)) add(alias);
    for (const variant of variantIds(model.variants)) add(variant);
    return ids;
}

function variantIds(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) {
        const ids: string[] = [];
        for (const entry of raw) {
            if (typeof entry === 'string') {
                ids.push(entry);
            } else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
                const variant = entry as { legacySlug?: unknown; variantStringRepresentation?: unknown };
                if (typeof variant.legacySlug === 'string') ids.push(variant.legacySlug);
                if (typeof variant.variantStringRepresentation === 'string') ids.push(variant.variantStringRepresentation);
            }
        }
        return ids;
    }
    return [];
}

function stringArray(raw: unknown): string[] {
    return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

function mergeConservative(
    existing: NativeModelAvailability,
    incoming: NativeModelAvailability,
): NativeModelAvailability {
    const rank = (status: NativeModelAvailabilityStatus): number => {
        if (status === STATUS_BLOCKED) return 3;
        if (status === STATUS_UNKNOWN) return 2;
        if (status === STATUS_AVAILABLE) return 1;
        return 2;
    };
    const existingRank = rank(existing.status);
    const incomingRank = rank(incoming.status);
    if (existingRank > incomingRank) return existing;
    if (incomingRank > existingRank) return incoming;
    if (existing.status === STATUS_BLOCKED && incoming.status === STATUS_BLOCKED && existing.reason !== incoming.reason) {
        return { status: STATUS_UNKNOWN };
    }
    if (existing.status !== incoming.status || existing.reason !== incoming.reason) return { status: STATUS_UNKNOWN };
    return existing;
}

function safeModelId(id: string): string | undefined {
    if (id === '' || id.length > MAX_MODEL_ID_LENGTH || id.trim() !== id) return undefined;
    if (/[\u0000-\u001f\u007f]/.test(id)) return undefined;
    return id;
}
