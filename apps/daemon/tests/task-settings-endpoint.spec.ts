import { expect, it } from 'vitest'

import type { TaskDispatchResolver } from '@wrenyard/task'

import { TaskSettingsService } from '../lib/daemon/services/task-settings-service.mts'

const routerThatMustNotRun = {
  resolve: async () => {
    throw new Error('automatic selection must not run with a configured endpoint')
  },
  eligible: async () => {
    throw new Error('automatic selection must not run with a configured endpoint')
  },
  diagnose: async () => {
    throw new Error('automatic selection must not run with a configured endpoint')
  },
  displayLabels: () => {
    throw new Error('automatic selection must not run with a configured endpoint')
  },
} satisfies TaskDispatchResolver

// Source: docs/specs/2026-11-05-standard-protocol-access.md (R7, approved case).
it('selects the configured worker model when an endpoint is set', async () => {
  const config = {
    endpoint: { url: 'https://models.example/api/v4', token: 'test-key' },
    models: { worker: { model: 'model-b', reasoningEffort: 'high' } },
  }
  const settings = new TaskSettingsService({
    workspaceRoot: '/unused',
    configPath: '/unused',
    store: { read: () => config, write() {} },
    resolver: routerThatMustNotRun,
  })

  const run = await settings.resolveForRun({ taskName: 'edit' })

  expect(run.exactAgentRuntime).toBe('wrenyard/model-b:pi')
})
