import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeTaskGraphTaskOutput } from '../../lib/core/taskgraph/task-bridge.mts'

describe('TaskGraph task output normalization', () => {
  it('preserves object-root task output', () => {
    const output = {
      evidences: [{ id: 'test-1', observation: 'passed' }],
      assessments: [],
    }

    assert.equal(normalizeTaskGraphTaskOutput(output), output)
  })

  it('wraps array-root task output for object-root TaskGraph nodes', () => {
    const output = [
      {
        id: 'edit-1',
        source: { kind: 'file', value: 'README.md' },
        observation: 'updated',
      },
    ]

    assert.deepEqual(normalizeTaskGraphTaskOutput(output), { result: output })
  })

  it('rejects non-JSON task output', () => {
    assert.equal(normalizeTaskGraphTaskOutput(undefined), null)
    assert.equal(normalizeTaskGraphTaskOutput({ bad: BigInt(1) }), null)
  })
})
