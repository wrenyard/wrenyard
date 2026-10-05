import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  codexSourceAuthHome,
  readCodexGatewayCredential,
  refreshCodexGatewayCredential,
} from '../src/index.ts';

function chatGptAuth(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tokens: {
      access_token: 'access-1',
      account_id: 'acct-1',
      refresh_token: 'refresh-1',
      ...overrides,
    },
  });
}

async function tempDir(contents?: string, relative = 'auth.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wrenyard-codex-gateway-'));
  if (contents !== undefined) {
    const path = join(dir, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
  return dir;
}

test('reads the ChatGPT token and account id from WRENYARD_CODEX_AUTH_HOME', async (t) => {
  const dir = await tempDir(chatGptAuth());
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(
    await readCodexGatewayCredential({ env: { WRENYARD_CODEX_AUTH_HOME: dir } }),
    { accessToken: 'access-1', accountId: 'acct-1' },
  );
});

test('resolves CODEX_HOME and the home fallback exactly like native readiness', async (t) => {
  const codexHome = await tempDir(chatGptAuth());
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  assert.equal(codexSourceAuthHome({ CODEX_HOME: codexHome }), codexHome);
  assert.deepEqual(
    await readCodexGatewayCredential({ env: { CODEX_HOME: codexHome } }),
    { accessToken: 'access-1', accountId: 'acct-1' },
  );

  const home = await tempDir(chatGptAuth(), join('.codex', 'auth.json'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(codexSourceAuthHome({}, home), join(home, '.codex'));
  assert.deepEqual(
    await readCodexGatewayCredential({ env: {}, home }),
    { accessToken: 'access-1', accountId: 'acct-1' },
  );
  // An explicit WRENYARD_CODEX_AUTH_HOME wins over CODEX_HOME.
  assert.equal(codexSourceAuthHome({ WRENYARD_CODEX_AUTH_HOME: home, CODEX_HOME: codexHome }), home);
});

test('rejects an API-key-only login for the subscription endpoint', async (t) => {
  const dir = await tempDir(JSON.stringify({ OPENAI_API_KEY: 'sk-test-secret' }));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => readCodexGatewayCredential({ env: { WRENYARD_CODEX_AUTH_HOME: dir } }),
    /requires a ChatGPT login/u,
  );
});

test('rejects a ChatGPT token that carries no account id', async (t) => {
  const dir = await tempDir(JSON.stringify({ tokens: { access_token: 'access-1' } }));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => readCodexGatewayCredential({ env: { WRENYARD_CODEX_AUTH_HOME: dir } }),
    /no account id/u,
  );
});

test('missing, malformed, and credential-free auth files fail bounded', async (t) => {
  const missing = await tempDir();
  t.after(() => rm(missing, { recursive: true, force: true }));
  await assert.rejects(
    () => readCodexGatewayCredential({ env: { WRENYARD_CODEX_AUTH_HOME: missing } }),
    /auth\.json is unavailable/u,
  );

  const malformed = await tempDir('{ not json');
  t.after(() => rm(malformed, { recursive: true, force: true }));
  await assert.rejects(
    () => readCodexGatewayCredential({ env: { WRENYARD_CODEX_AUTH_HOME: malformed } }),
    /auth\.json is invalid/u,
  );

  const empty = await tempDir(JSON.stringify({ tokens: {} }));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await assert.rejects(
    () => readCodexGatewayCredential({ env: { WRENYARD_CODEX_AUTH_HOME: empty } }),
    /no usable credential/u,
  );
});

test('refresh reuses a token already rotated into the source file without spawning Codex', async (t) => {
  const dir = await tempDir(chatGptAuth());
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credential = await readCodexGatewayCredential({ env: { WRENYARD_CODEX_AUTH_HOME: dir } });

  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'access-2', account_id: 'acct-2', refresh_token: 'refresh-2' },
  }), 'utf8');

  // The injected executable is never used because the source token already changed.
  const refreshed = await refreshCodexGatewayCredential(credential, {
    env: { WRENYARD_CODEX_AUTH_HOME: dir },
    signal: new AbortController().signal,
    executable: '/nonexistent/codex',
  });
  assert.deepEqual(refreshed, { accessToken: 'access-2', accountId: 'acct-2' });
});

test('refresh stays bounded when the source auth file is unavailable', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => refreshCodexGatewayCredential(
      { accessToken: 'access-1', accountId: 'acct-1' },
      { env: { WRENYARD_CODEX_AUTH_HOME: dir }, signal: new AbortController().signal, executable: '/nonexistent/codex' },
    ),
    /auth\.json is unavailable/u,
  );
});
