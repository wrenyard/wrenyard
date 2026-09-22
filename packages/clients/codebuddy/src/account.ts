import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
export type CodeBuddyEnvironment = 'internal' | 'ioa' | 'cloudhosted' | 'external' | 'unknown';
export interface ParsedCodeBuddyAuth {
    readonly accessToken: string | undefined;
    readonly domain: string | undefined;
    readonly authObject: Record<string, unknown> | undefined;
    readonly root: Record<string, unknown>;
}
export interface CodeBuddyStableIdentity {
    readonly primaryId: string;
    enterpriseId?: string;
    accountType?: string;
    idp?: string;
}
export interface CodeBuddyAccountContext {
    readonly accessToken: string;
    readonly domain?: string;
    readonly stableScope?: string;
    readonly headers?: Readonly<Record<string, string>>;
}
const CODEBUDDY_STABLE_SCOPE_VERSION = 'cbv1';
const ACCOUNT_ID_FIELDS = ['uid', 'uin', 'oneidAccountId'] as const;
const IDENTITY_FIELDS = ['enterpriseId', 'accountType', 'idp'] as const;
export function codeBuddyAuthPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
    const filename = 'Tencent-Cloud.coding-copilot.info';
    if (platform === 'darwin')
        return join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
    if (platform === 'win32')
        return join(env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
    return join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
}
export function parseCodeBuddyAuth(parsed: Record<string, unknown>): ParsedCodeBuddyAuth {
    const auth = parsed.auth && typeof parsed.auth === 'object' && !Array.isArray(parsed.auth)
        ? parsed.auth as Record<string, unknown>
        : undefined;
    return {
        accessToken: nonEmpty(auth?.accessToken) ?? nonEmpty(parsed['auth.accessToken']),
        domain: nonEmpty(auth?.domain) ?? nonEmpty(parsed['auth.domain']),
        authObject: auth,
        root: parsed,
    };
}
export function codeBuddyStableAccountIdentity(authState: ParsedCodeBuddyAuth): CodeBuddyStableIdentity | undefined {
    let primaryId: string | undefined;
    for (const field of ACCOUNT_ID_FIELDS) {
        primaryId = accountField(field, authState);
        if (primaryId !== undefined)
            break;
    }
    if (primaryId === undefined)
        return undefined;
    const identity: CodeBuddyStableIdentity = { primaryId };
    for (const field of IDENTITY_FIELDS) {
        const value = accountField(field, authState);
        if (value !== undefined)
            identity[field] = value;
    }
    return identity;
}
export function codeBuddyAccountContext(authState: ParsedCodeBuddyAuth, environment: CodeBuddyEnvironment): CodeBuddyAccountContext | undefined {
    if (!authState.accessToken)
        return undefined;
    const identity = codeBuddyStableAccountIdentity(authState);
    return {
        accessToken: authState.accessToken,
        ...(authState.domain ? { domain: authState.domain } : {}),
        ...(identity ? { stableScope: stableScope(identity, authState.domain, environment) } : {}),
        ...(nativeHeaders(authState) ? { headers: nativeHeaders(authState) } : {}),
    };
}
export function codeBuddyHome(env: NodeJS.ProcessEnv): string {
    return env.HOME || env.USERPROFILE || homedir();
}
function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function fieldValue(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim())
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
function accountField(key: string, authState: ParsedCodeBuddyAuth): string | undefined {
    const activeAccount = authState.root.account;
    if (activeAccount && typeof activeAccount === 'object' && !Array.isArray(activeAccount)) {
        const direct = fieldValue((activeAccount as Record<string, unknown>)[key]);
        if (direct !== undefined)
            return direct;
    }
    const legacyAccount = authState.authObject?.account;
    if (legacyAccount && typeof legacyAccount === 'object' && !Array.isArray(legacyAccount)) {
        const nested = fieldValue((legacyAccount as Record<string, unknown>)[key]);
        if (nested !== undefined)
            return nested;
    }
    const direct = fieldValue(authState.authObject?.[key]);
    if (direct !== undefined)
        return direct;
    return fieldValue(authState.root[`auth.${key}`]);
}
function stableScope(identity: CodeBuddyStableIdentity, domain: string | undefined, environment: CodeBuddyEnvironment): string {
    const payload: Record<string, string> = { id: identity.primaryId };
    if (identity.enterpriseId !== undefined)
        payload.enterpriseId = identity.enterpriseId;
    if (identity.accountType !== undefined)
        payload.accountType = identity.accountType;
    if (identity.idp !== undefined)
        payload.idp = identity.idp;
    if (domain !== undefined)
        payload.domain = domain;
    payload.environment = environment;
    const canonical = `${CODEBUDDY_STABLE_SCOPE_VERSION}:${JSON.stringify(payload)}`;
    return `${CODEBUDDY_STABLE_SCOPE_VERSION}:${createHash('sha256').update(canonical).digest('hex')}`;
}
function nativeHeaders(authState: ParsedCodeBuddyAuth): Readonly<Record<string, string>> | undefined {
    const validated = (value: string | undefined): string | undefined => {
        if (value === undefined || /[\r\n]/u.test(value))
            return undefined;
        return value;
    };
    const userId = validated(accountField('uid', authState));
    const enterpriseId = validated(accountField('enterpriseId', authState));
    const domain = validated(authState.domain);
    if (userId === undefined && enterpriseId === undefined && domain === undefined)
        return undefined;
    const headers: Record<string, string> = {};
    if (userId !== undefined)
        headers['X-User-Id'] = userId;
    if (enterpriseId !== undefined) {
        headers['X-Enterprise-Id'] = enterpriseId;
        headers['X-Tenant-Id'] = enterpriseId;
    }
    if (domain !== undefined)
        headers['X-Domain'] = domain;
    return headers;
}
