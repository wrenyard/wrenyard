import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ClaudeAppAdapter, WRENYARD_CLAUDE_PROFILE_ID } from '../../lib/client-configuration/adapters/claude-app.mts'
import { ClaudeCodeAdapter } from '../../lib/client-configuration/adapters/claude-code.mts'
import { MemoryClientOwnershipStore } from '../../lib/client-configuration/ownership-store.mts'
import type { GatewayClientConnection } from '../../lib/client-configuration/types.mts'

const connection: GatewayClientConnection = {
  openaiChatBaseUrl: 'http://127.0.0.1:8787/gateway/openai-chat/v1',
  openaiResponsesBaseUrl: 'http://127.0.0.1:8787/gateway/openai-responses/v1',
  anthropicBaseUrl: 'http://127.0.0.1:8787/gateway/anthropic/v1',
  credential: 'gateway-secret',
  credentialHelperPath: '/opt/wrenyard/bin/gateway-credential',
  credentialHelperCommand: ['/opt/wrenyard/bin/wrenyard', 'client', 'gateway-credential'],
  models: [
    {
      id: 'claude-opus', publicId: 'anthropic-api/claude-opus', provider: 'anthropic-api',
      displayName: 'Claude Opus', protocols: ['anthropic_messages'], claudeFamily: true,
      claudeTier: 'opus', supports1MContext: true,
    },
    {
      id: 'other', publicId: 'zhipu/glm', provider: 'zhipu', displayName: 'GLM',
      protocols: ['anthropic_messages'], claudeFamily: false,
    },
    {
      id: 'k3', publicId: 'kimi-coding/k3', provider: 'kimi-coding', displayName: 'Kimi K3',
      protocols: ['anthropic_messages'],
    },
    {
      id: 'deepseek', publicId: 'codebuddy/deepseek-v4-flash', provider: 'codebuddy', displayName: 'DeepSeek V4 Flash',
      protocols: ['openai_chat'],
    },
  ],
}

test('Claude Code changes only its three owned settings and restores them without touching login data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-claude-code-'))
  const settingsPath = join(root, 'settings.json')
  const credentialsPath = join(root, '.credentials.json')
  await writeFile(settingsPath, JSON.stringify({ env: { KEEP: 'yes' }, permissions: { allow: ['Read'] } }, null, 2))
  await writeFile(credentialsPath, '{"oauth":"native"}\n')
  const originalCredential = await readFile(credentialsPath, 'utf8')
  const adapter = new ClaudeCodeAdapter({
    settingsPath,
    store: new MemoryClientOwnershipStore(),
    capabilityProbe: async () => ({ supported: true }),
  })
  const plan = await adapter.plan(connection, {
    models: ['anthropic-api/claude-opus'],
    defaultModel: 'anthropic-api/claude-opus',
  })
  await adapter.apply(plan, connection)
  const configured = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>
  assert.equal(configured.env.KEEP, 'yes')
  assert.equal(configured.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787/gateway/anthropic')
  assert.equal(configured.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1')
  assert.equal(configured.apiKeyHelper, "'/opt/wrenyard/bin/wrenyard' 'client' 'gateway-credential'")
  assert.deepEqual(configured.permissions, { allow: ['Read'] })
  assert.equal('ANTHROPIC_AUTH_TOKEN' in configured.env, false)
  assert.equal(await readFile(credentialsPath, 'utf8'), originalCredential)

  configured.theme = 'dark'
  await writeFile(settingsPath, `${JSON.stringify(configured, null, 2)}\n`)
  await adapter.restore(await adapter.planRestore())
  const restored = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>
  assert.deepEqual(restored.env, { KEEP: 'yes' })
  assert.equal(restored.apiKeyHelper, undefined)
  assert.equal(restored.theme, 'dark')
})

test('Claude Code is capability-gated and rejects models without Anthropic Messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-claude-code-'))
  const unsupported = new ClaudeCodeAdapter({
    settingsPath: join(root, 'settings.json'),
    store: new MemoryClientOwnershipStore(),
    capabilityProbe: async () => ({ supported: false, detail: 'upgrade required' }),
  })
  await assert.rejects(() => unsupported.plan(connection, {
    models: ['anthropic-api/claude-opus'], defaultModel: 'anthropic-api/claude-opus',
  }), /upgrade required/)
  const supported = new ClaudeCodeAdapter({
    settingsPath: join(root, 'settings.json'),
    store: new MemoryClientOwnershipStore(),
    capabilityProbe: async () => ({ supported: true }),
  })
  await assert.rejects(() => supported.plan(connection, {
    models: ['codebuddy/deepseek-v4-flash'], defaultModel: 'codebuddy/deepseek-v4-flash',
  }), /not available/)
})

test('Claude adapters plan and apply non-Claude-family Anthropic Messages models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-claude-protocols-'))
  const selection = {
    models: ['kimi-coding/k3', 'zhipu/glm'],
    defaultModel: 'kimi-coding/k3',
  }
  const code = new ClaudeCodeAdapter({
    settingsPath: join(root, 'settings.json'),
    store: new MemoryClientOwnershipStore(),
    capabilityProbe: async () => ({ supported: true }),
  })
  const codePlan = await code.plan(connection, selection)
  assert.deepEqual(codePlan.models, selection.models)
  assert.deepEqual((await code.apply(codePlan, connection)).configuredModels, selection.models)

  const app = new ClaudeAppAdapter({
    metaPath: join(root, '_meta.json'),
    profilePath: join(root, `${WRENYARD_CLAUDE_PROFILE_ID}.json`),
    store: new MemoryClientOwnershipStore(),
    capabilityProbe: async () => ({ supported: true }),
  })
  const appPlan = await app.plan(connection, selection)
  assert.deepEqual(appPlan.models, selection.models)
  assert.deepEqual((await app.apply(appPlan, connection)).configuredModels, selection.models)
  const profile = JSON.parse(await readFile(join(root, `${WRENYARD_CLAUDE_PROFILE_ID}.json`), 'utf8')) as Record<string, any>
  assert.deepEqual(profile.inferenceModels, [
    { name: 'kimi-coding/k3', labelOverride: 'Kimi K3' },
    { name: 'zhipu/glm', labelOverride: 'GLM' },
  ])

  await assert.rejects(() => code.plan(connection, {
    models: ['codebuddy/deepseek-v4-flash'], defaultModel: 'codebuddy/deepseek-v4-flash',
  }), /not available/)
  await assert.rejects(() => app.plan(connection, {
    models: ['codebuddy/deepseek-v4-flash'], defaultModel: 'codebuddy/deepseek-v4-flash',
  }), /not available/)
})

test('Claude App applies one Wrenyard configLibrary profile and preserves foreign entries on restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-claude-app-'))
  const metaPath = join(root, '_meta.json')
  const profilePath = join(root, `${WRENYARD_CLAUDE_PROFILE_ID}.json`)
  await writeFile(metaPath, `${JSON.stringify({ appliedId: 'native', entries: [{ id: 'native', name: 'Native' }], keep: true }, null, 2)}\n`)
  const adapter = new ClaudeAppAdapter({
    metaPath,
    profilePath,
    store: new MemoryClientOwnershipStore(),
    capabilityProbe: async () => ({ supported: true }),
  })
  const plan = await adapter.plan(connection, {
    models: ['anthropic-api/claude-opus'], defaultModel: 'anthropic-api/claude-opus',
  })
  await adapter.apply(plan, connection)
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, any>
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Record<string, any>
  assert.equal(meta.appliedId, WRENYARD_CLAUDE_PROFILE_ID)
  assert.equal(meta.entries.some((entry: any) => entry.id === 'native'), true)
  assert.equal(meta.keep, true)
  assert.equal(profile.inferenceProvider, 'gateway')
  assert.equal(profile.inferenceCredentialKind, 'helper-script')
  assert.equal(profile.inferenceCredentialHelper, '/opt/wrenyard/bin/gateway-credential')
  assert.equal(profile.inferenceGatewayAuthScheme, 'x-api-key')
  assert.equal(profile.modelDiscoveryEnabled, false)
  assert.deepEqual(profile.inferenceModels, [{
    name: 'anthropic-api/claude-opus', labelOverride: 'Claude Opus', family: 'opus', supports1m: true,
  }])
  assert.equal(JSON.stringify(profile).includes('gateway-secret'), false)

  meta.entries.push({ id: 'later', name: 'Later' })
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  await adapter.restore(await adapter.planRestore())
  const restored = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, any>
  assert.equal(restored.appliedId, 'native')
  assert.equal(restored.entries.some((entry: any) => entry.id === 'later'), true)
  assert.equal(restored.entries.some((entry: any) => entry.id === WRENYARD_CLAUDE_PROFILE_ID), false)
  await assert.rejects(() => readFile(profilePath, 'utf8'), /ENOENT/)
})

test('Claude App refuses externally managed configuration and a foreign Wrenyard profile id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-claude-app-'))
  const metaPath = join(root, '_meta.json')
  const profilePath = join(root, `${WRENYARD_CLAUDE_PROFILE_ID}.json`)
  const managed = new ClaudeAppAdapter({
    metaPath, profilePath, store: new MemoryClientOwnershipStore(),
    capabilityProbe: async () => ({ supported: false, externallyManaged: true, detail: 'managed policy' }),
  })
  await assert.rejects(() => managed.plan(connection, {
    models: ['anthropic-api/claude-opus'], defaultModel: 'anthropic-api/claude-opus',
  }), /managed policy/)
  await writeFile(profilePath, '{}\n')
  const foreign = new ClaudeAppAdapter({
    metaPath, profilePath, store: new MemoryClientOwnershipStore(),
    capabilityProbe: async () => ({ supported: true }),
  })
  await assert.rejects(() => foreign.plan(connection, {
    models: ['anthropic-api/claude-opus'], defaultModel: 'anthropic-api/claude-opus',
  }), /already owned/)
})
