import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveWrenyardStateRoot } from '@wrenyard/paths';
import type { ProviderContext } from '../base/index.ts';
import type { WorkBuddyBuild, WorkBuddyBuildId } from './definition.ts';
import {
  ACCESS_TOKEN_SKEW_MS,
  AUTH_POLL_INTERVAL_MS,
  AUTH_POLL_TIMEOUT_MS,
  AUTH_STATE_HEADERS,
  LOGIN_ACCOUNT_HEADERS,
  authStateUrl,
  authTokenUrl,
  loginAccountUrl,
  refreshTokenUrl,
} from './protocol.ts';

export interface WorkBuddyStoredAuth {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly refreshExpiresAt?: number;
  readonly domain?: string;
  readonly tokenType?: string;
  readonly uid?: string;
  readonly enterpriseId?: string;
  readonly accountType?: string;
  readonly idp?: string;
  readonly plan?: string;
}

export interface WorkBuddySession extends WorkBuddyStoredAuth {
  readonly fingerprint: string;
}

export type WorkBuddyAccountKind = 'ioa' | 'personal' | 'enterprise' | 'unknown';

/**
 * Classifies the signed-in WorkBuddy account from verified auth metadata only.
 * iOA requires an explicit signal: idp === 'ioa_auth', or the auth domain
 * matching this build's known iOA domain reference. enterpriseId alone is
 * enterprise, not iOA; missing metadata is 'unknown', never 'personal'.
 */
export function classifyWorkBuddyAccount(source: {
  readonly uid?: string;
  readonly enterpriseId?: string;
  readonly domain?: string;
  readonly accountType?: string;
  readonly idp?: string;
}): WorkBuddyAccountKind {
  const enterpriseId = source.enterpriseId?.trim();
  const domain = source.domain?.trim();
  const idp = source.idp?.trim();
  if (idp === 'ioa_auth' || (domain !== undefined && WORKBUDDY_IOA_DOMAINS.includes(domain))) return 'ioa';
  if (enterpriseId) return 'enterprise';
  if (source.uid?.trim()) return 'personal';
  return 'unknown';
}

/**
 * The verified account identity of one login: the classified kind plus the raw
 * metadata that produced it. `accountType`/`idp` stay optional and verbatim —
 * they are routing and display facts, never credentials — so a login whose
 * account block reports neither keeps them absent instead of defaulting them.
 */
export interface WorkBuddyAccountIdentity {
  readonly kind: WorkBuddyAccountKind;
  readonly accountType?: string;
  readonly idp?: string;
}

export function classifyWorkBuddyAccountIdentity(source: {
  readonly uid?: string;
  readonly enterpriseId?: string;
  readonly domain?: string;
  readonly accountType?: string;
  readonly idp?: string;
}): WorkBuddyAccountIdentity {
  const accountType = source.accountType?.trim();
  const idp = source.idp?.trim();
  return {
    kind: classifyWorkBuddyAccount(source),
    ...(accountType ? { accountType } : {}),
    ...(idp ? { idp } : {}),
  };
}

/**
 * iOA login domains known to this build. WorkBuddy ships no product.json-style
 * authentication attributes; the reference is the CN build root's host, which
 * the iOA SSO account block reports as its domain.
 */
const WORKBUDDY_IOA_DOMAINS: readonly string[] = ['copilot.tencent.com'];

export interface WorkBuddyCredentialStore {
  readonly context: ProviderContext;
  readonly build: WorkBuddyBuild;
}

const KEEP_RENEWED_MS = 60_000;
const renewingByRefreshToken = new Map<string, Promise<WorkBuddyStoredAuth | undefined>>();
const renewedByRefreshToken = new Map<string, { at: number; next: WorkBuddyStoredAuth }>();

function persistencePath(context: ProviderContext, buildId: WorkBuddyBuildId): string {
  return join(resolveWrenyardStateRoot(context.env), 'providers', 'workbuddy', `${buildId}.json`);
}

export function desktopAuthPath(context: ProviderContext, build: WorkBuddyBuild): string {
  const home = context.home;
  const file = build.desktopInfoFile;
  if (context.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', file);
  }
  if (context.platform === 'win32') {
    const local = context.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth', file);
  }
  const dataHome = context.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  return join(dataHome, 'CodeBuddyExtension', 'Data', 'Public', 'auth', file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tokenEncrypted(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const marker = value.$wbEncrypted;
  return marker !== undefined && marker !== null && marker !== false;
}

function parseStoredAuth(raw: unknown): WorkBuddyStoredAuth | undefined {
  if (!isRecord(raw)) return undefined;
  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken.trim() : '';
  if (!accessToken) return undefined;
  const refreshToken = typeof raw.refreshToken === 'string' && raw.refreshToken.trim() ? raw.refreshToken.trim() : undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? { expiresAt: raw.expiresAt } : {}),
    ...(typeof raw.refreshExpiresAt === 'number' && Number.isFinite(raw.refreshExpiresAt) ? { refreshExpiresAt: raw.refreshExpiresAt } : {}),
    ...(typeof raw.domain === 'string' && raw.domain.trim() ? { domain: raw.domain.trim() } : {}),
    ...(typeof raw.tokenType === 'string' && raw.tokenType.trim() ? { tokenType: raw.tokenType.trim() } : {}),
    ...(typeof raw.uid === 'string' && raw.uid.trim() ? { uid: raw.uid.trim() } : {}),
    ...(typeof raw.enterpriseId === 'string' && raw.enterpriseId.trim() ? { enterpriseId: raw.enterpriseId.trim() } : {}),
    ...(typeof raw.accountType === 'string' && raw.accountType.trim() ? { accountType: raw.accountType.trim() } : {}),
    ...(typeof raw.idp === 'string' && raw.idp.trim() ? { idp: raw.idp.trim() } : {}),
    ...(typeof raw.plan === 'string' && raw.plan.trim() ? { plan: raw.plan.trim() } : {}),
  };
}

function fingerprint(auth: WorkBuddyStoredAuth): string {
  const parts = [auth.accessToken, auth.uid ?? '', auth.enterpriseId ?? '', auth.domain ?? ''];
  return parts.join('|');
}

function accessExpired(auth: WorkBuddyStoredAuth, nowMs: number): boolean {
  if (auth.expiresAt === undefined) return false;
  return auth.expiresAt <= nowMs + ACCESS_TOKEN_SKEW_MS;
}

function refreshExpired(auth: WorkBuddyStoredAuth, nowMs: number): boolean {
  if (auth.refreshExpiresAt === undefined) return false;
  return auth.refreshExpiresAt <= nowMs;
}

/**
 * Drops the in-process token-renewal caches. An explicit account switch hands
 * the next read a different login, so a renewal result or an in-flight renewal
 * of the previous login can never be reused for the new one.
 */
export function resetWorkBuddyAuthCaches(): void {
  renewingByRefreshToken.clear();
  renewedByRefreshToken.clear();
}

export async function deletePersistedAuth(store: WorkBuddyCredentialStore): Promise<void> {
  try {
    await unlink(persistencePath(store.context, store.build.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function readPersistedAuth(store: WorkBuddyCredentialStore): Promise<WorkBuddyStoredAuth | undefined> {
  const path = persistencePath(store.context, store.build.id);
  try {
    const parsed = JSON.parse(await store.context.readFile(path, 'utf8')) as unknown;
    return parseStoredAuth(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function writePersistedAuth(store: WorkBuddyCredentialStore, auth: WorkBuddyStoredAuth): Promise<void> {
  const path = persistencePath(store.context, store.build.id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export async function readDesktopAuth(store: WorkBuddyCredentialStore): Promise<
  | { kind: 'ok'; auth: WorkBuddyStoredAuth }
  | { kind: 'encrypted' }
  | { kind: 'missing' }
> {
  const path = desktopAuthPath(store.context, store.build);
  let content: string;
  try {
    content = await store.context.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: 'missing' };
  }
  if (!isRecord(parsed)) return { kind: 'missing' };
  const account = isRecord(parsed.account) ? parsed.account : undefined;
  const authBlock = isRecord(parsed.auth) ? parsed.auth : undefined;
  if (!authBlock) return { kind: 'missing' };
  if (tokenEncrypted(authBlock.accessToken) || tokenEncrypted(authBlock.refreshToken)) return { kind: 'encrypted' };
  const accessToken = typeof authBlock.accessToken === 'string' ? authBlock.accessToken.trim() : '';
  if (!accessToken) return { kind: 'missing' };
  const refreshToken = typeof authBlock.refreshToken === 'string' && authBlock.refreshToken.trim()
    ? authBlock.refreshToken.trim()
    : undefined;
  const expiresAt = coerceExpiry(authBlock.expiresAt, authBlock.expiresIn);
  const refreshExpiresAt = coerceExpiry(authBlock.refreshExpiresAt, authBlock.refreshExpiresIn);
  const domain = typeof authBlock.domain === 'string' ? authBlock.domain.trim() : undefined;
  const tokenType = typeof authBlock.tokenType === 'string' ? authBlock.tokenType.trim() : undefined;
  const uid = account && typeof account.uid === 'string' ? account.uid.trim() : undefined;
  const enterpriseId = account && typeof account.enterpriseId === 'string' ? account.enterpriseId.trim() : undefined;
  const accountType = account && typeof account.accountType === 'string' ? account.accountType.trim() : undefined;
  const idp = account && typeof account.idp === 'string' ? account.idp.trim() : undefined;
  const auth: WorkBuddyStoredAuth = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(refreshExpiresAt !== undefined ? { refreshExpiresAt } : {}),
    ...(domain ? { domain } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(uid ? { uid } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(accountType ? { accountType } : {}),
    ...(idp ? { idp } : {}),
  };
  if (accessExpired(auth, Date.now()) && !refreshToken) return { kind: 'missing' };
  return { kind: 'ok', auth };
}

function coerceExpiry(at: unknown, relativeSeconds: unknown): number | undefined {
  if (typeof at === 'number' && Number.isFinite(at)) return at > 1e12 ? at : Date.now() + at * 1000;
  if (typeof at === 'string' && at.trim()) {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof relativeSeconds === 'number' && Number.isFinite(relativeSeconds) && relativeSeconds > 0) {
    return Date.now() + relativeSeconds * 1000;
  }
  return undefined;
}

function nativeHeaderRecord(auth: WorkBuddyStoredAuth): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (auth.uid) headers['X-User-Id'] = auth.uid;
  if (auth.enterpriseId) {
    headers['X-Enterprise-Id'] = auth.enterpriseId;
    headers['X-Tenant-Id'] = auth.enterpriseId;
  }
  if (auth.domain) headers['X-Domain'] = auth.domain;
  return Object.freeze(headers);
}

export function sessionFromAuth(auth: WorkBuddyStoredAuth): WorkBuddySession {
  return Object.freeze({ ...auth, fingerprint: fingerprint(auth) });
}

export function nativeHeadersForSession(session: WorkBuddySession): Readonly<Record<string, string>> {
  return nativeHeaderRecord(session);
}

function envelopeData(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.code !== 0) return undefined;
  const data = payload.data;
  return isRecord(data) ? data : undefined;
}

function refreshDedupeKey(store: WorkBuddyCredentialStore, refreshToken: string): string {
  return `${store.build.id}\n${refreshToken}`;
}

function mergeRefreshedTokens(previous: WorkBuddyStoredAuth, next: WorkBuddyStoredAuth): WorkBuddyStoredAuth {
  return {
    accessToken: next.accessToken,
    ...(next.refreshToken ? { refreshToken: next.refreshToken } : previous.refreshToken ? { refreshToken: previous.refreshToken } : {}),
    ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : previous.expiresAt !== undefined ? { expiresAt: previous.expiresAt } : {}),
    ...(next.refreshExpiresAt !== undefined ? { refreshExpiresAt: next.refreshExpiresAt } : previous.refreshExpiresAt !== undefined ? { refreshExpiresAt: previous.refreshExpiresAt } : {}),
    ...(next.domain ? { domain: next.domain } : previous.domain ? { domain: previous.domain } : {}),
    ...(next.tokenType ? { tokenType: next.tokenType } : previous.tokenType ? { tokenType: previous.tokenType } : {}),
    ...(previous.uid ? { uid: previous.uid } : {}),
    ...(previous.enterpriseId ? { enterpriseId: previous.enterpriseId } : {}),
    ...(next.accountType ? { accountType: next.accountType } : previous.accountType ? { accountType: previous.accountType } : {}),
    ...(next.idp ? { idp: next.idp } : previous.idp ? { idp: previous.idp } : {}),
    ...(previous.plan ? { plan: previous.plan } : {}),
  };
}

async function renewWorkBuddyAuth(
  store: WorkBuddyCredentialStore,
  auth: WorkBuddyStoredAuth,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<WorkBuddyStoredAuth | undefined> {
  const refreshToken = auth.refreshToken;
  if (!refreshToken) return undefined;
  const key = refreshDedupeKey(store, refreshToken);
  const cached = renewedByRefreshToken.get(key);
  if (cached && Date.now() - cached.at < KEEP_RENEWED_MS) {
    return mergeRefreshedTokens(auth, cached.next);
  }
  let pending: Promise<WorkBuddyStoredAuth | undefined> | undefined = renewingByRefreshToken.get(key);
  if (!pending) {
    pending = (async (): Promise<WorkBuddyStoredAuth | undefined> => {
      const headers = new Headers({
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'Content-Type': 'application/json',
        ...LOGIN_ACCOUNT_HEADERS,
      });
      if (auth.domain) headers.set('X-Domain', auth.domain);
      if (auth.enterpriseId) {
        headers.set('X-Enterprise-Id', auth.enterpriseId);
        headers.set('X-Tenant-Id', auth.enterpriseId);
      }
      const response = await fetchImpl(refreshTokenUrl(store.build), {
        method: 'POST',
        headers,
        body: '{}',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (!accessExpired(auth, Date.now())) return auth;
        return undefined;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (!accessExpired(auth, Date.now())) return auth;
        return undefined;
      }
      const data = envelopeData(payload);
      if (!data) {
        if (!accessExpired(auth, Date.now())) return auth;
        return undefined;
      }
      const next = parseRefreshPayload(data, auth);
      renewedByRefreshToken.set(key, { next, at: Date.now() });
      await writePersistedAuth(store, next);
      return next;
    })().finally(() => {
      renewingByRefreshToken.delete(key);
    });
    renewingByRefreshToken.set(key, pending);
  }
  const renewed = await pending;
  if (!renewed) return undefined;
  return mergeRefreshedTokens(auth, renewed);
}

function parseRefreshPayload(data: Record<string, unknown>, previous: WorkBuddyStoredAuth): WorkBuddyStoredAuth {
  const accessToken = typeof data.accessToken === 'string' && data.accessToken.trim()
    ? data.accessToken.trim()
    : previous.accessToken;
  const refreshToken = typeof data.refreshToken === 'string' && data.refreshToken.trim()
    ? data.refreshToken.trim()
    : previous.refreshToken;
  const domain = typeof data.domain === 'string' && data.domain.trim() ? data.domain.trim() : previous.domain;
  const tokenType = typeof data.tokenType === 'string' && data.tokenType.trim() ? data.tokenType.trim() : previous.tokenType;
  const expiresAt = coerceExpiry(data.expiresAt, data.expiresIn) ?? previous.expiresAt;
  const refreshExpiresAt = coerceExpiry(data.refreshExpiresAt, data.refreshExpiresIn) ?? previous.refreshExpiresAt;
  const accountType = typeof data.accountType === 'string' && data.accountType.trim()
    ? data.accountType.trim()
    : previous.accountType;
  const idp = typeof data.idp === 'string' && data.idp.trim() ? data.idp.trim() : previous.idp;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(refreshExpiresAt !== undefined ? { refreshExpiresAt } : {}),
    ...(domain ? { domain } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(previous.uid ? { uid: previous.uid } : {}),
    ...(previous.enterpriseId ? { enterpriseId: previous.enterpriseId } : {}),
    ...(accountType ? { accountType } : {}),
    ...(idp ? { idp } : {}),
    ...(previous.plan ? { plan: previous.plan } : {}),
  };
}

export async function refreshWorkBuddyAuth(
  store: WorkBuddyCredentialStore,
  auth: WorkBuddyStoredAuth,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<WorkBuddyStoredAuth | undefined> {
  if (!auth.refreshToken) {
    if (!accessExpired(auth, Date.now())) return auth;
    return undefined;
  }
  if (refreshExpired(auth, Date.now())) {
    if (!accessExpired(auth, Date.now())) return auth;
    return undefined;
  }
  return renewWorkBuddyAuth(store, auth, signal, fetchImpl);
}

export async function resolveWorkBuddySession(
  store: WorkBuddyCredentialStore,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<WorkBuddySession | undefined> {
  const now = Date.now();
  let auth = await readPersistedAuth(store);
  if (auth && accessExpired(auth, now)) {
    auth = await refreshWorkBuddyAuth(store, auth, signal, fetchImpl) ?? undefined;
  }
  if (!auth) {
    const desktop = await readDesktopAuth(store);
    if (desktop.kind === 'ok') {
      auth = desktop.auth;
      if (accessExpired(auth, now)) {
        auth = await refreshWorkBuddyAuth(store, auth, signal, fetchImpl) ?? undefined;
      }
    } else {
      auth = undefined;
    }
  }
  if (!auth || !auth.accessToken.trim()) return undefined;
  if (accessExpired(auth, now) && !auth.refreshToken) return undefined;
  return sessionFromAuth(auth);
}

export function defaultProviderContext(env: NodeJS.ProcessEnv = process.env): ProviderContext {
  return {
    env,
    home: env.HOME ?? env.USERPROFILE ?? homedir(),
    platform: process.platform,
    readFile: (path, encoding) => readFile(path, encoding),
    realpath: async (path) => path,
  };
}

export interface WorkBuddyAuthStart {
  readonly state: string;
  readonly authUrl: string;
}

export async function startWorkBuddyBrowserAuth(
  store: WorkBuddyCredentialStore,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<WorkBuddyAuthStart> {
  const response = await fetchImpl(authStateUrl(store.build), {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json', ...AUTH_STATE_HEADERS }),
    body: '{}',
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('WorkBuddy auth state request failed');
  }
  const payload = await response.json();
  const data = envelopeData(payload);
  const state = data && typeof data.state === 'string' ? data.state : undefined;
  const authUrl = data && typeof data.authUrl === 'string' ? data.authUrl : undefined;
  if (!state || !authUrl || !authUrl.startsWith('https://')) throw new Error('WorkBuddy auth state response was invalid');
  return { state, authUrl };
}

export async function pollWorkBuddyBrowserToken(
  store: WorkBuddyCredentialStore,
  state: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<WorkBuddyStoredAuth | undefined> {
  const deadline = Date.now() + AUTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    const response = await fetchImpl(authTokenUrl(store.build, state), { method: 'GET', signal });
    if (response.status === 408 || response.status === 429) {
      await response.body?.cancel();
      await sleep(AUTH_POLL_INTERVAL_MS, signal);
      continue;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      await sleep(AUTH_POLL_INTERVAL_MS, signal);
      continue;
    }
    if (isRecord(payload) && payload.code === 11217) {
      await sleep(AUTH_POLL_INTERVAL_MS, signal);
      continue;
    }
    const data = envelopeData(payload);
    const accessToken = data && typeof data.accessToken === 'string' ? data.accessToken.trim() : '';
    if (!accessToken) {
      await sleep(AUTH_POLL_INTERVAL_MS, signal);
      continue;
    }
    const refreshToken = data && typeof data.refreshToken === 'string' && data.refreshToken.trim()
      ? data.refreshToken.trim()
      : undefined;
    const domain = data && typeof data.domain === 'string' ? data.domain.trim() : undefined;
    const tokenType = data && typeof data.tokenType === 'string' ? data.tokenType.trim() : undefined;
    const expiresAt = data ? coerceExpiry(data.expiresAt, data.expiresIn) : undefined;
    const refreshExpiresAt = data ? coerceExpiry(data.refreshExpiresAt, data.refreshExpiresIn) : undefined;
    let auth: WorkBuddyStoredAuth = {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(refreshExpiresAt !== undefined ? { refreshExpiresAt } : {}),
      ...(domain ? { domain } : {}),
      ...(tokenType ? { tokenType } : {}),
    };
    auth = await finalizeWorkBuddyLoginAccount(store, state, auth, signal, fetchImpl);
    await writePersistedAuth(store, auth);
    return auth;
  }
  return undefined;
}

async function finalizeWorkBuddyLoginAccount(
  store: WorkBuddyCredentialStore,
  state: string,
  auth: WorkBuddyStoredAuth,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<WorkBuddyStoredAuth> {
  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    ...LOGIN_ACCOUNT_HEADERS,
  });
  if (auth.domain) headers.set('X-Domain', auth.domain);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchImpl(loginAccountUrl(store.build, state), { method: 'GET', headers, signal });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) throw new Error('WorkBuddy login account request failed');
      return auth;
    }
    if (isRecord(payload) && payload.code === 12151) {
      await sleep(AUTH_POLL_INTERVAL_MS, signal);
      continue;
    }
    const data = envelopeData(payload);
    if (!data) {
      if (!response.ok) throw new Error('WorkBuddy login account request failed');
      return auth;
    }
    const uid = typeof data.uid === 'string' ? data.uid.trim() : undefined;
    const enterpriseId = typeof data.enterpriseId === 'string' ? data.enterpriseId.trim() : undefined;
    const domain = typeof data.domain === 'string' ? data.domain.trim() : auth.domain;
    const accountType = typeof data.accountType === 'string' ? data.accountType.trim() : undefined;
    const idp = typeof data.idp === 'string' ? data.idp.trim() : undefined;
    return {
      ...auth,
      ...(uid ? { uid } : {}),
      ...(enterpriseId ? { enterpriseId } : {}),
      ...(accountType ? { accountType } : {}),
      ...(idp ? { idp } : {}),
      ...(domain ? { domain } : {}),
    };
  }
  return auth;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function meterAuthHeaders(auth: WorkBuddyStoredAuth, userAgent: string): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': userAgent,
    Authorization: `Bearer ${auth.accessToken}`,
    'X-User-Id': auth.uid ?? '',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
  });
  if (auth.domain) headers.set('X-Domain', auth.domain);
  const native = nativeHeaderRecord(auth);
  for (const [name, value] of Object.entries(native)) {
    if (name !== 'X-User-Id') headers.set(name, value);
  }
  return headers;
}

export function authHeadersForRefresh(store: WorkBuddyCredentialStore, auth: WorkBuddyStoredAuth): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    ...LOGIN_ACCOUNT_HEADERS,
  });
  if (auth.domain) headers.set('X-Domain', auth.domain);
  const native = nativeHeaderRecord(auth);
  for (const [name, value] of Object.entries(native)) headers.set(name, value);
  return headers;
}
