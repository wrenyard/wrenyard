import { join } from 'node:path';

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function codeBuddyAuthPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const filename = 'Tencent-Cloud.coding-copilot.info';
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
  if (platform === 'win32') return join(env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
  return join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', filename);
}

export interface ParsedCodeBuddyAuth {
  readonly accessToken: string | undefined;
  readonly domain: string | undefined;
  readonly authObject: Record<string, unknown> | undefined;
  readonly root: Record<string, unknown>;
}

/**
 * Normalized parse of one CodeBuddy auth file. Accepts both the nested `auth`
 * object shape and the legacy flat `auth.*` root keys; token and domain
 * handling mirrors the historical credential() loader exactly so a snapshot
 * can never observe a different token/domain than the runtime surface.
 */
export function parseCodeBuddyAuth(parsed: Record<string, unknown>): ParsedCodeBuddyAuth {
  const auth = parsed.auth && typeof parsed.auth === 'object' && !Array.isArray(parsed.auth)
    ? parsed.auth as Record<string, unknown>
    : undefined;
  return {
    accessToken: nonEmptyString(auth?.accessToken) ?? nonEmptyString(parsed['auth.accessToken']),
    domain: nonEmptyString(auth?.domain) ?? nonEmptyString(parsed['auth.domain']),
    authObject: auth,
    root: parsed,
  };
}

export interface CodeBuddyStableIdentity {
  readonly primaryId: string;
  enterpriseId?: string;
  accountType?: string;
  idp?: string;
}

/**
 * Stable non-secret account identifiers with fixed precedence and exact
 * normalization. Candidate account ids are uid, then uin, then
 * oneidAccountId; optional supporting identity (enterprise id, account type,
 * identity provider) qualifies the id deterministically. User-facing names,
 * avatars, and every token/session/time field are never read here.
 */
const CODEBUDDY_STABLE_ACCOUNT_ID_FIELDS = ['uid', 'uin', 'oneidAccountId'] as const;
const CODEBUDDY_STABLE_IDENTITY_FIELDS = ['enterpriseId', 'accountType', 'idp'] as const;

function codeBuddyStableAccountFieldValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function codeBuddyStableAccountField(key: string, authState: ParsedCodeBuddyAuth): string | undefined {
  const activeAccount = authState.root.account;
  if (activeAccount && typeof activeAccount === 'object' && !Array.isArray(activeAccount)) {
    const direct = codeBuddyStableAccountFieldValue((activeAccount as Record<string, unknown>)[key]);
    if (direct !== undefined) return direct;
  }
  const legacyAccount = authState.authObject?.account;
  if (legacyAccount && typeof legacyAccount === 'object' && !Array.isArray(legacyAccount)) {
    const nested = codeBuddyStableAccountFieldValue((legacyAccount as Record<string, unknown>)[key]);
    if (nested !== undefined) return nested;
  }
  const direct = codeBuddyStableAccountFieldValue(authState.authObject?.[key]);
  if (direct !== undefined) return direct;
  return codeBuddyStableAccountFieldValue(authState.root[`auth.${key}`]);
}

export function codeBuddyStableAccountIdentity(authState: ParsedCodeBuddyAuth): CodeBuddyStableIdentity | undefined {
  let primaryId: string | undefined;
  for (const field of CODEBUDDY_STABLE_ACCOUNT_ID_FIELDS) {
    primaryId = codeBuddyStableAccountField(field, authState);
    if (primaryId !== undefined) break;
  }
  if (primaryId === undefined) return undefined;
  const identity: CodeBuddyStableIdentity = { primaryId };
  for (const field of CODEBUDDY_STABLE_IDENTITY_FIELDS) {
    const value = codeBuddyStableAccountField(field, authState);
    if (value !== undefined) identity[field] = value;
  }
  return identity;
}

export async function readCodeBuddyAuthFile(
  path: string,
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
): Promise<ParsedCodeBuddyAuth | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return parseCodeBuddyAuth(value as Record<string, unknown>);
  } catch {
    return undefined;
  }
}
