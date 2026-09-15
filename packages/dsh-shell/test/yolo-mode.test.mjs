import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';

import plugin, {
  APPROVAL_POLICY,
  SANDBOX_MODE,
  normalizeSession,
  wrapPolicyResolver,
  wrapSessionAppend,
} from '../src/yolo-mode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Best-effort locator for the installed DSH session package. The workspace
 * root's pnpm store holds it; the DSH profile copy is not on this package's
 * resolution path. Returns null when no install is present so the real-API
 * regressions are skipped instead of failing on a machine without DSH.
 */
async function loadRealSession() {
  const pnpm = join(HERE, '..', '..', '..', 'node_modules', '.pnpm');
  let entries;
  try {
    entries = readdirSync(pnpm);
  } catch {
    return null;
  }
  const dir = entries.find((name) => name.startsWith('@deepseek-ai+dsh-session@'));
  if (!dir) return null;
  const entry = join(pnpm, dir, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
  try {
    const mod = await import(pathToFileURL(entry).href);
    return typeof mod.Session === 'function' ? mod.Session : null;
  } catch {
    return null;
  }
}

const RealSession = await loadRealSession();

function effective(events, type, field) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type && event.data && typeof event.data === 'object') {
      return event.data[field];
    }
  }
  return undefined;
}

/** Minimal Session-shaped double mirroring the installed append contract. */
function sessionWith(events) {
  const session = {
    events: [],
    append(type, data, ...opts) {
      const event = { type, data, ...(opts[0] ?? {}) };
      this.events.push(event);
      return event;
    },
  };
  for (const event of events) session.append(event.type, event.data);
  return session;
}

/** Minimal sandboxPolicy double mirroring the installed resolve precedence. */
function policyService(session, { defaultMode = 'read-only', workspaceRoot = '/fallback-root' } = {}) {
  return {
    defaultMode,
    workspaceRoot,
    resolve(request = {}) {
      const target = request.session ?? session;
      return {
        mode: request.mode ?? (target ? effective(target.events, 'sandbox/mode', 'mode') : undefined) ?? this.defaultMode,
        workspaceRoot: target?.header?.cwd ?? this.workspaceRoot,
        ...(target ? { sessionId: target.id ?? 'session-1' } : {}),
      };
    },
  };
}

test('restored readonly/edit settings are superseded by YOLO events', () => {
  const session = sessionWith([
    { type: 'sandbox/mode', data: { mode: 'read-only' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  ]);

  normalizeSession(session);

  assert.equal(effective(session.events, 'sandbox/mode', 'mode'), SANDBOX_MODE);
  assert.equal(effective(session.events, 'approval/policy', 'policy'), APPROVAL_POLICY);
});

test('append wrapper neutralizes restrictive mode and policy appended after creation', () => {
  const session = sessionWith([{ type: 'sandbox/mode', data: { mode: 'read-only' } }]);
  normalizeSession(session);

  // A later UI/session-settings write must not restore a restriction.
  session.append('sandbox/mode', { mode: 'read-only' });
  session.append('approval/policy', { policy: 'ask' });

  assert.equal(effective(session.events, 'sandbox/mode', 'mode'), SANDBOX_MODE);
  assert.equal(effective(session.events, 'approval/policy', 'policy'), APPROVAL_POLICY);
});

test('wrapSessionAppend may be installed without an initial normalization pass', () => {
  const session = sessionWith([{ type: 'sandbox/mode', data: { mode: 'read-only' } }]);
  wrapSessionAppend(session);

  session.append('sandbox/mode', { mode: 'read-only' });

  assert.equal(effective(session.events, 'sandbox/mode', 'mode'), SANDBOX_MODE);
  assert.equal(effective(session.events, 'approval/policy', 'policy'), undefined);
});

test('append wrapper preserves old seed history, other events, and opts', () => {
  const session = sessionWith([
    { type: 'sandbox/mode', data: { mode: 'read-only' } },
    { type: 'session/end-seed', data: {} },
  ]);
  const seed = session.events[0];
  normalizeSession(session);

  const surfaced = session.append('assistant/message', { text: 'hi' }, { surfaceOp: 'append' });
  const unrelated = session.append('turn/start', { turn: 1 });

  assert.equal(session.events[0], seed);
  assert.deepEqual(seed.data, { mode: 'read-only' });
  assert.equal(surfaced.surfaceOp, 'append');
  assert.deepEqual(unrelated.data, { turn: 1 });
});

test('normalization is idempotent and does not duplicate events', () => {
  const session = sessionWith([{ type: 'sandbox/mode', data: { mode: 'read-only' } }]);
  normalizeSession(session);
  const afterFirst = session.events.length;
  const wrappedAppend = session.append;

  normalizeSession(session);
  normalizeSession(session);

  assert.equal(session.events.length, afterFirst);
  assert.equal(session.append, wrappedAppend);
});

test('policy resolver forces YOLO mode over explicit per-call overrides', () => {
  const session = sessionWith([{ type: 'sandbox/mode', data: { mode: 'read-only' } }]);
  normalizeSession(session);
  const service = policyService(session);
  wrapPolicyResolver(service);

  assert.equal(service.resolve({ mode: 'read-only' }).mode, SANDBOX_MODE);
  assert.equal(service.resolve({ mode: 'workspace-write' }).mode, SANDBOX_MODE);
  assert.equal(service.resolve({ session }).mode, SANDBOX_MODE);
  assert.equal(service.resolve({ session, mode: 'read-only' }).mode, SANDBOX_MODE);
});

test('policy resolver preserves workspaceRoot, sessionId, and receiver', () => {
  const session = sessionWith([]);
  session.header = { cwd: '/workspace/root' };
  const service = policyService(session);
  const receiver = { marker: 'receiver' };
  service.resolve = function resolve(request = {}) {
    assert.equal(this, receiver);
    return { mode: request.mode ?? 'read-only', workspaceRoot: '/workspace/root', sessionId: 'abc', extra: 7 };
  };
  wrapPolicyResolver(service);

  const resolved = service.resolve.call(receiver, { mode: 'read-only' });
  assert.deepEqual(resolved, { mode: SANDBOX_MODE, workspaceRoot: '/workspace/root', sessionId: 'abc', extra: 7 });
});

test('policy resolver wrapping is idempotent', () => {
  const service = policyService(sessionWith([]));
  wrapPolicyResolver(service);
  const wrapped = service.resolve;
  wrapPolicyResolver(service);
  assert.equal(service.resolve, wrapped);
});

test('plugin normalizes created sessions, sweeps existing sessions, and wraps the resolver', () => {
  const existing = sessionWith([{ type: 'sandbox/mode', data: { mode: 'read-only' } }]);
  const service = policyService(existing);
  const registrations = [];
  plugin.apply({
    on(event, handler, options) {
      registrations.push({ event, handler, options });
    },
    get(name) {
      if (name === 'sandboxPolicy') return service;
      if (name === 'sessions') return { list: () => [existing] };
      return undefined;
    },
  });

  assert.deepEqual(registrations, [
    { event: 'session/created', handler: normalizeSession, options: { global: true } },
  ]);
  assert.equal(effective(existing.events, 'sandbox/mode', 'mode'), SANDBOX_MODE);
  assert.equal(service.resolve({ mode: 'read-only' }).mode, SANDBOX_MODE);

  const fresh = sessionWith([]);
  registrations[0].handler(fresh);
  fresh.append('sandbox/mode', { mode: 'workspace-write' });
  assert.equal(effective(fresh.events, 'sandbox/mode', 'mode'), SANDBOX_MODE);
});

test('plugin tolerates a context without sandboxPolicy or sessions services', () => {
  assert.doesNotThrow(() => plugin.apply({ on() {}, get() { return undefined; } }));
});

test('plugin declares mandatory sandboxPolicy and sessions lifecycle dependencies', () => {
  // Cordis must wait for both services before apply and remount when either is
  // replaced; an undeclared dependency lets ctx.get miss a live service.
  assert.deepEqual(plugin.inject, ['sandboxPolicy', 'sessions']);
});

test('normalizeSession rejects a session without the append surface', () => {
  assert.throws(() => normalizeSession(undefined), /append surface is unavailable/);
  assert.throws(() => normalizeSession({ events: [] }), /append surface is unavailable/);
});

test('real DSH Session: restrictive seed cannot survive later restricted writes', { skip: RealSession ? false : 'installed DSH session package not found' }, () => {
  const session = new RealSession('real-1', [
    { type: 'sandbox/mode', seq: 0, time: 1, data: { mode: 'read-only' } },
    { type: 'approval/policy', seq: 1, time: 2, data: { policy: 'ask' } },
  ]);
  normalizeSession(session);
  session.append('sandbox/mode', { mode: 'read-only' });
  session.append('approval/policy', { policy: 'ask' });

  assert.equal(effective(session.events, 'sandbox/mode', 'mode'), SANDBOX_MODE);
  assert.equal(effective(session.events, 'approval/policy', 'policy'), APPROVAL_POLICY);
});

test('real DSH Session: seed history is preserved and events stay frozen', { skip: RealSession ? false : 'installed DSH session package not found' }, () => {
  const seed = [
    { type: 'sandbox/mode', seq: 0, time: 1, data: { mode: 'read-only' } },
    { type: 'approval/policy', seq: 1, time: 2, data: { policy: 'ask' } },
  ];
  const session = new RealSession('real-2', seed);
  normalizeSession(session);

  assert.equal(session.events[0].data.mode, 'read-only');
  assert.equal(session.events[1].data.policy, 'ask');
  const appended = session.append('turn/start', { turn: 1 });
  assert.equal(Object.isFrozen(appended), true);
});

test('real DSH Session: normalization stays idempotent through the frozen snapshot', { skip: RealSession ? false : 'installed DSH session package not found' }, () => {
  const session = new RealSession('real-3', [
    { type: 'sandbox/mode', seq: 0, time: 1, data: { mode: 'read-only' } },
  ]);
  normalizeSession(session);
  const afterFirst = session.events.length;
  normalizeSession(session);
  normalizeSession(session);
  assert.equal(session.events.length, afterFirst);
});
