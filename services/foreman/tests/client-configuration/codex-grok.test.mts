import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CodexSharedAdapter } from '../../lib/client-configuration/adapters/codex-shared.mts'
import { GrokBuildAdapter } from '../../lib/client-configuration/adapters/grok-build.mts'
import { MemoryClientOwnershipStore } from '../../lib/client-configuration/ownership-store.mts'
import type { GatewayClientConnection } from '../../lib/client-configuration/types.mts'

const connection: GatewayClientConnection = {
  openaiChatBaseUrl: 'http://127.0.0.1:8787/gateway/openai-chat/v1',
  openaiResponsesBaseUrl: 'http://127.0.0.1:8787/gateway/openai-responses/v1',
  anthropicBaseUrl: 'http://127.0.0.1:8787/gateway/anthropic/v1',
  credential: 'gateway-secret',
  credentialHelperPath: '/opt/wrenyard/bin/gateway-credential',
  credentialHelperCommand: ['wrenyard', 'client', 'gateway-credential'],
  models: [
    { id: 'sol', publicId: 'openai/sol', provider: 'openai', displayName: 'Sol', protocols: ['openai_responses'], contextWindow: 1_000_000 },
    { id: 'glm', publicId: 'zhipu/glm', provider: 'zhipu', displayName: 'GLM', protocols: ['openai_chat', 'anthropic_messages'], contextWindow: 200_000 },
  ],
}

test('Codex shared apply changes only owned fields and leaves auth.json byte-for-byte untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-codex-'))
  const configPath = join(root, 'config.toml')
  const catalogPath = join(root, 'state', 'codex-models.json')
  const authPath = join(root, 'auth.json')
  const originalAuth = '{"tokens":{"access_token":"native"}}\n'
  await writeFile(configPath, 'approval_policy = "on-request"\n\n[features]\nweb_search = true\n')
  await writeFile(authPath, originalAuth)
  const adapter = new CodexSharedAdapter({ configPath, catalogPath, store: new MemoryClientOwnershipStore() })
  const plan = await adapter.plan(connection, { models: ['openai/sol'], defaultModel: 'openai/sol' })
  assert.equal(await readFile(configPath, 'utf8'), 'approval_policy = "on-request"\n\n[features]\nweb_search = true\n')
  await adapter.apply(plan, connection)
  const configured = await readFile(configPath, 'utf8')
  assert.match(configured, /^model_provider = "wrenyard"/m)
  assert.match(configured, /model_catalog_json = /)
  assert.match(configured, /\[model_providers\.wrenyard\]/)
  assert.match(configured, /auth = \{ command = \["wrenyard", "client", "gateway-credential"\] \}/)
  assert.match(configured, /approval_policy = "on-request"/)
  assert.match(configured, /\[features\]\nweb_search = true/)
  assert.equal(await readFile(authPath, 'utf8'), originalAuth)
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { models: Array<{ slug: string }> }
  assert.deepEqual(catalog.models.map((model) => model.slug), ['openai/sol'])
  assert.equal(JSON.stringify(catalog).includes('gateway-secret'), false)
})

test('Codex restore preserves later non-owned edits and refuses owned drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-codex-'))
  const configPath = join(root, 'config.toml')
  const catalogPath = join(root, 'models.json')
  const store = new MemoryClientOwnershipStore()
  await writeFile(configPath, 'model = "native"\napproval_policy = "never"\n')
  const adapter = new CodexSharedAdapter({ configPath, catalogPath, store })
  await adapter.apply(await adapter.plan(connection, { models: ['openai/sol'], defaultModel: 'openai/sol' }), connection)
  await writeFile(
    configPath,
    (await readFile(configPath, 'utf8')).replace(
      '[model_providers.wrenyard]',
      'sandbox_mode = "workspace-write"\n\n[model_providers.wrenyard]',
    ),
  )
  const restore = await adapter.planRestore()
  await adapter.restore(restore)
  const restored = await readFile(configPath, 'utf8')
  assert.match(restored, /model = "native"/)
  assert.match(restored, /approval_policy = "never"/)
  assert.match(restored, /sandbox_mode = "workspace-write"/)
  assert.doesNotMatch(restored, /model_providers\.wrenyard/)

  await adapter.apply(await adapter.plan(connection, { models: ['openai/sol'], defaultModel: 'openai/sol' }), connection)
  await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('model = "openai/sol"', 'model = "foreign/model"'))
  const drifted = await adapter.plan(connection, { models: ['openai/sol'], defaultModel: 'openai/sol' })
  await assert.rejects(() => adapter.apply(drifted, connection), /outside Wrenyard/)
})

test('Grok apply is additive and preserves native defaults, auth and custom models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-grok-'))
  const configPath = join(root, 'config.toml')
  const original = [
    '[models]',
    'default = "grok-native"',
    'allowed_models = ["grok-native"]',
    '',
    '[auth]',
    'mode = "oauth"',
    '',
    '[model.custom]',
    'model = "custom/model"',
    '',
  ].join('\n')
  await writeFile(configPath, original)
  const store = new MemoryClientOwnershipStore()
  const adapter = new GrokBuildAdapter({ configPath, store })
  const plan = await adapter.plan(connection, {
    models: ['zhipu/glm'],
    defaultModel: 'zhipu/glm',
    protocols: { 'zhipu/glm': 'anthropic_messages' },
  })
  await adapter.apply(plan, connection)
  const configured = await readFile(configPath, 'utf8')
  assert.match(configured, /\[models\]\ndefault = "grok-native"/)
  assert.match(configured, /allowed_models = \["grok-native"\]/)
  assert.match(configured, /\[auth\]\nmode = "oauth"/)
  assert.match(configured, /\[model\.custom\]/)
  assert.match(configured, /\[model\."wrenyard:zhipu\/glm"\]/)
  assert.match(configured, /api_backend = "messages"/)
  assert.match(configured, /extra_headers = \{ x-api-key = "gateway-secret", anthropic-version = "2023-06-01" \}/)

  const restore = await adapter.planRestore()
  await adapter.restore(restore)
  assert.equal((await readFile(configPath, 'utf8')).trim(), original.trim())
})

test('Grok model updates remove only previous Wrenyard tables and stop on owned drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-grok-'))
  const configPath = join(root, 'config.toml')
  const store = new MemoryClientOwnershipStore()
  await writeFile(configPath, '[cli]\ninstaller = "internal"\n')
  const adapter = new GrokBuildAdapter({ configPath, store })
  const first = await adapter.plan(connection, { models: ['openai/sol'], defaultModel: 'openai/sol' })
  await adapter.apply(first, connection)
  assert.match(await readFile(configPath, 'utf8'), /api_backend = "responses"/)
  const second = await adapter.plan(connection, { models: ['zhipu/glm'], defaultModel: 'zhipu/glm' })
  await adapter.apply(second, connection)
  const updated = await readFile(configPath, 'utf8')
  assert.doesNotMatch(updated, /wrenyard:openai\/sol/)
  assert.match(updated, /wrenyard:zhipu\/glm/)
  assert.match(updated, /api_backend = "chat_completions"/)
  await writeFile(configPath, updated.replace('Wrenyard · zhipu · GLM', 'Foreign name'))
  const drifted = await adapter.plan(connection, { models: ['zhipu/glm'], defaultModel: 'zhipu/glm' })
  await assert.rejects(() => adapter.apply(drifted, connection), /outside Wrenyard/)
})
