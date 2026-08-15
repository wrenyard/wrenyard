import assert from 'node:assert/strict'
import { test } from 'node:test'

import { helloTaskgraphFwaE2E } from './fixtures/hello-taskgraph-fwa-e2e.mts'

test('helloTaskgraphFwaE2E returns the TaskGraph E2E greeting', () => {
  assert.equal(helloTaskgraphFwaE2E(), 'hello from TaskGraph FWA E2E')
})
