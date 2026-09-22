import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  evaluateNativeRouteReadiness,
  projectModelAvailability,
} from '../../lib/daemon/execution/native-provider-readiness.mts'

test('conflicting duplicate Cursor model rows never grant model access', () => {
  assert.equal(projectModelAvailability({
    model: { status: 'blocked', reason: 'admin_blocked' },
    'other-model': { status: 'blocked', reason: 'admin_blocked' },
  }, 'cursor')?.model?.status, 'blocked')
  // A single id carrying conflicting statuses collapses to unknown.
  assert.equal(projectModelAvailability({
    model: { status: 'available', reason: undefined },
  }, 'cursor')?.model?.status, 'available')
})

test('native readiness is exact-provider and never promotes native auth into gateway support', () => {
  const snapshot = {
    sampledAtMs: 1,
    authByProvider: Object.freeze({ chatgpt: true, cursor: false }),
    cursorModelAvailability: Object.freeze({
      'composer-1': { status: 'available' as const },
    }),
  }
  assert.equal(evaluateNativeRouteReadiness(snapshot, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'available')
  assert.equal(evaluateNativeRouteReadiness(snapshot, {
    providerId: 'cursor', client: 'cursor', mode: 'native', nativeClients: ['cursor'], model: 'composer-1',
  }), 'missing')
  assert.equal(evaluateNativeRouteReadiness({
    sampledAtMs: 1,
    authByProvider: Object.freeze({}),
  }, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'unknown')
  assert.equal(evaluateNativeRouteReadiness(snapshot, {
    providerId: 'chatgpt', client: 'grok', mode: 'gateway', nativeClients: ['codex'],
  }), 'unsupported')
  assert.equal(evaluateNativeRouteReadiness(snapshot, {
    providerId: 'forge-managed', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'unsupported', 'a shared native client cannot promote an unsupported credential resolver')
  assert.equal(evaluateNativeRouteReadiness(snapshot, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: [],
  }), 'unsupported', 'a credential resolver cannot bypass the provider native-client allowlist')
})

const cursorNative = {
  providerId: 'cursor' as const,
  client: 'cursor',
  mode: 'native' as const,
  nativeClients: ['cursor'],
}

test('authenticated Cursor requires exact available model status', () => {
  const blocked = {
    sampledAtMs: 1,
    authByProvider: Object.freeze({ chatgpt: true, cursor: true }),
    cursorModelAvailability: Object.freeze({
      'arbitrary-team-model': { status: 'blocked' as const, reason: 'admin_blocked' as const },
    }),
  }
  assert.equal(evaluateNativeRouteReadiness(blocked, {
    ...cursorNative, model: 'arbitrary-team-model',
  }), 'blocked')
  const allowed = {
    sampledAtMs: 2,
    authByProvider: Object.freeze({ chatgpt: true, cursor: true }),
    cursorModelAvailability: Object.freeze({
      'arbitrary-team-model': { status: 'available' as const },
      'non-default-model': { status: 'available' as const },
    }),
  }
  assert.equal(evaluateNativeRouteReadiness(allowed, {
    ...cursorNative, model: 'arbitrary-team-model',
  }), 'available')
  assert.equal(evaluateNativeRouteReadiness(allowed, {
    ...cursorNative, model: 'non-default-model',
  }), 'available')
  assert.equal(evaluateNativeRouteReadiness(allowed, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'available', 'ChatGPT stays auth-only')
  const unblocked = {
    sampledAtMs: 3,
    authByProvider: Object.freeze({ chatgpt: true, cursor: true }),
    cursorModelAvailability: Object.freeze({
      'arbitrary-team-model': { status: 'available' as const },
    }),
  }
  assert.equal(evaluateNativeRouteReadiness(unblocked, {
    ...cursorNative, model: 'arbitrary-team-model',
  }), 'available')
})

test('absent malformed or unknown Cursor model data is not available', () => {
  const authed = {
    sampledAtMs: 1,
    authByProvider: Object.freeze({ cursor: true }),
  }
  assert.equal(evaluateNativeRouteReadiness(authed, {
    ...cursorNative, model: 'composer-1',
  }), 'unknown')
  assert.equal(evaluateNativeRouteReadiness({
    ...authed,
    cursorModelAvailability: Object.freeze({
      'composer-1': { status: 'unknown' as const },
    }),
  }, { ...cursorNative, model: 'composer-1' }), 'unknown')
  assert.equal(evaluateNativeRouteReadiness({
    ...authed,
    cursorModelAvailability: Object.freeze({
      'other-model': { status: 'available' as const },
    }),
  }, { ...cursorNative, model: 'composer-1' }), 'unknown')
  // A malformed per-model row is dropped, never promoted to available.
  const projected = projectModelAvailability({ 'composer-1': { status: 'nope' } }, 'cursor')
  assert.deepEqual({ ...projected }, {})
  assert.equal(evaluateNativeRouteReadiness({
    sampledAtMs: 1,
    authByProvider: Object.freeze({ cursor: true }),
    cursorModelAvailability: projected,
  }, { ...cursorNative, model: 'composer-1' }), 'unknown')
})

test('Cursor model availability keeps only safe ids status and reason', () => {
  const projected = projectModelAvailability({
    'ok-model': { status: 'available', leak: 'nope' },
    'blocked-model': { status: 'blocked', reason: 'admin_blocked', raw: 'team_settings_blocked' },
    'bad status': { status: 'nope' },
    ' ': { status: 'available' },
  }, 'cursor')
  assert.deepEqual({ ...projected }, {
    'ok-model': { status: 'available' },
    'blocked-model': { status: 'blocked', reason: 'admin_blocked' },
  })
  assert.equal(JSON.stringify(projected).includes('leak'), false)
  assert.equal(JSON.stringify(projected).includes('team_settings_blocked'), false)
})

test('Cursor wire Grok availability is projected to canonical model identity', () => {
  const parsed = projectModelAvailability({
    'cursor-grok-4.6-high': { status: 'blocked', reason: 'admin_blocked' },
  }, 'cursor')
  assert.deepEqual(parsed?.['grok-4.6'], { status: 'blocked', reason: 'admin_blocked' })
  assert.equal(parsed?.['cursor-grok-4.6-high'], undefined)
  const conflict = projectModelAvailability({
    'cursor-grok-4.6-high': { status: 'available' },
    'grok-4.6': { status: 'blocked' },
  }, 'cursor')
  assert.equal(conflict?.['grok-4.6']?.status, 'unknown')
})
