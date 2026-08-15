import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isProjectInScope } from '../../lib/core/fwa/project-scope.mts'

void describe('project-scope', () => {
  void it('accepts exact root', () => {
    assert.equal(isProjectInScope('proj-a', 'proj-a'), true)
  })

  void it('accepts subtree', () => {
    assert.equal(isProjectInScope('proj-a/ops', 'proj-a'), true)
  })

  void it('rejects sibling prefix', () => {
    assert.equal(isProjectInScope('proj-a-extra', 'proj-a'), false)
  })

  void it('rejects unrelated project', () => {
    assert.equal(isProjectInScope('proj-b', 'proj-a'), false)
  })

  void it('rejects empty candidate', () => {
    assert.throws(() => isProjectInScope('', 'root'), /non-empty/)
  })

  void it('rejects empty root', () => {
    assert.throws(() => isProjectInScope('proj', ''), /non-empty/)
  })
})
