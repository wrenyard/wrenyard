import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Catalog } from '@wrenyard/catalog'
import { type ProviderRuntime } from '@wrenyard/providers'
import { resolveEffectiveTaskSettings } from '../../../lib/config/task-settings.mts'
import { createTaskDispatchResolver } from '../../../lib/core/task/dispatch-resolver.mts'

const runtime: ProviderRuntime = {
  credential: async () => ({ value: 'fixture-key' }),
  configureApiKey: async () => {},
  resolveUpstreamModel: (_provider, model) => model,
  publicResponseModel: (_provider, _model, _upstream, publicModel) => publicModel,
}

async function fixture(includeImage: boolean) {
  const catalog = new Catalog()
  catalog.registerClient({ id: 'opencode', gatewayProtocols: ['openai_chat'], taskCapable: true })
  const definitions = [
    { id: 'text', capabilities: ['text'] as const, tps: 200, price: 0.1 },
    { id: 'unknown', capabilities: undefined, tps: 200, price: 0.1 },
    ...(includeImage ? [{ id: 'vision', capabilities: ['text', 'image'] as const, tps: 90, price: 2 }] : []),
  ]
  catalog.registerProvider({
    id: 'fixture', displayName: 'Fixture', credentialResolver: 'forge-managed',
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://fixture.invalid/chat/completions', authScheme: 'bearer' }],
    models: definitions.map(({ id, capabilities, tps, price }) => ({
      id, displayName: id, capabilities, intelligence: 'mid',
      speed: { tps, source: 'fixture', checkedAt: '2026-09-10' },
      pricing: { inputUsdPerMillion: price, cachedInputUsdPerMillion: price, outputUsdPerMillion: price, source: 'fixture', checkedAt: '2026-09-10' },
    })),
  })
  return createTaskDispatchResolver({ catalog, runtime })
}

function imageRequirements() {
  return resolveEffectiveTaskSettings({
    builtin: { dispatch: { requiredCapabilities: ['image'], minimumTps: 60, maxOutputUsdPerMillion: 6 } },
    userGlobal: { dispatch: { requiredCapabilities: ['text'] } },
    userTask: { dispatch: { requiredCapabilities: [] } },
    invocation: { dispatch: { requiredCapabilities: [] } },
  }).dispatch
}

test('GOL-like image declaration survives overrides and excludes cheaper text/unknown inputs', async () => {
  const resolver = await fixture(true)
  const requirements = imageRequirements()
  const selected = resolver.resolve({ taskName: 'visual-test', requirements })
  assert.equal(selected.ok, true)
  assert.equal(selected.exactAgentRuntime, 'fixture/vision:oc')
  const eligible = resolver.eligible({ taskName: 'visual-test', requirements })
  assert.equal(eligible.ok, true)
  assert.deepEqual(eligible.choices.map((choice) => choice.model), ['vision'])
  for (const model of ['text', 'unknown']) {
    const explicit = resolver.resolveExplicit({ taskName: 'visual-test', exactRuntime: `fixture/${model}:oc`, requiredCapabilities: requirements.requiredCapabilities })
    assert.equal(explicit.ok, false, `${model} must not bypass image admission through explicit selection`)
  }
})

test('image task fails when only text and unknown-input models exist; ordinary text task still works', async () => {
  const resolver = await fixture(false)
  assert.equal(resolver.resolve({ taskName: 'visual-test', requirements: imageRequirements() }).ok, false)
  const text = resolver.resolve({ taskName: 'unit-test', requirements: { requiredCapabilities: ['text'] } })
  assert.equal(text.ok, true)
  assert.equal(text.exactAgentRuntime, 'fixture/text:oc')
})
