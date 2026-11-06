import { expect, it } from 'vitest'

import { createBuiltinCatalog } from '@wrenyard/providers'
import { parseRunSyntax } from '@wrenyard/providers/catalog'

import { resolvePlan } from '../lib/daemon/execution/worker-plan.mts'

// Source: docs/specs/2026-11-05-standard-protocol-access.md (R7, approved case).
it('builds the launch plan for the wrenyard provider without the catalog', () => {
  const target = parseRunSyntax('wrenyard/model-b:pi')

  const plan = resolvePlan(createBuiltinCatalog(), target, 'high')

  expect(plan).toEqual({
    client: 'pi',
    provider: 'wrenyard',
    model: 'model-b',
    mode: 'gateway',
    protocol: 'openai_chat',
    reasoningEffort: 'high',
  })
})
