import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import commitTask, {
  captureOriginTrackingGate,
  originTrackingUnchangedGate,
} from '../lib/standard/tasks/commit.mts'
import type { GateContext } from '../lib/core/task/types.mts'

/**
 * Focused unit tests for the commit task push-detection gates.
 *
 * The gates only depend on `ctx.state` (shared pre->post) and `ctx.shell`,
 * so the `run` functions are exercised directly with a stubbed shell that
 * simulates git ref resolution — no agent, no real git repo.
 */

/** Build a fake GateContext whose `origin/main` tracking SHA can be
 *  mutated between pre and post gate runs (simulating an agent push). */
function makeHarness(initialOriginSha: string | null): {
  ctx: GateContext
  setOrigin: (sha: string | null) => void
} {
  let origin = initialOriginSha
  const ctx = {
    task: { name: 'commit', sourcePath: 'lib/standard/tasks/commit.mts' },
    input: {},
    workDir: '/repo',
    workspaceRoot: '/workspace',
    project: 'app',
    taskId: 'task-1',
    state: {},
    shell: async (cmd: string) => {
      if (cmd === 'git symbolic-ref --short -q HEAD') {
        return { exitCode: 0, stdout: 'main\n', stderr: '' }
      }
      if (/^git rev-parse --verify --quiet /.test(cmd)) {
        return origin
          ? { exitCode: 0, stdout: `${origin}\n`, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '' }
      }
      throw new Error(`unexpected shell command: ${cmd}`)
    },
  } as unknown as GateContext
  return { ctx, setOrigin: (sha: string | null) => { origin = sha } }
}

describe('standard/tasks commit — push-detection gates', () => {
  it('defines pre and post gates and keeps need_push removed', async () => {
    assert.ok(commitTask.config.gates, 'commit task should define gates')
    assert.ok(commitTask.config.gates.pre, 'pre-gates should be present')
    assert.ok(commitTask.config.gates.post, 'post-gates should be present')
    assert.equal(commitTask.config.gates.pre[0].id, 'capture-origin-tracking')
    assert.equal(commitTask.config.gates.post[0].id, 'origin-tracking-unchanged')

    const prompt = await commitTask.config.prompt({ changes_to_commit: { 'src/example.ts': 'all' } })
    assert.doesNotMatch(prompt, /need_push/)
  })

  it('pre-gate records the tracking SHA; post-gate fails when it changed', async () => {
    const { ctx, setOrigin } = makeHarness('sha-aaa')

    const pre = await captureOriginTrackingGate.run(ctx)
    assert.equal(pre.ok, true)
    assert.equal(ctx.state.branch, 'main')
    assert.equal(ctx.state.originTrackingSha, 'sha-aaa')

    // Simulate the agent pushing: origin/main advanced while the agent ran.
    setOrigin('sha-bbb')
    const post = await originTrackingUnchangedGate.run(ctx)
    if (post.ok) {
      assert.fail('expected post-gate to fail when tracking SHA changed')
    }
    assert.match(post.remediation ?? '', /wrenyard project push/)
  })

  it('post-gate passes when the tracking SHA is unchanged', async () => {
    const { ctx, setOrigin } = makeHarness('sha-aaa')
    await captureOriginTrackingGate.run(ctx)

    // Local HEAD may advance; the origin tracking ref staying put is fine.
    setOrigin('sha-aaa')
    const post = await originTrackingUnchangedGate.run(ctx)
    assert.deepEqual(post, { ok: true })
  })

  it('post-gate passes when pre recorded null tracking sha and post is still null', async () => {
    const { ctx } = makeHarness(null)
    const pre = await captureOriginTrackingGate.run(ctx)
    assert.equal(pre.ok, true)
    assert.equal(ctx.state.originTrackingSha, null)

    // No origin tracking ref ever appears — null to null is a pass.
    const post = await originTrackingUnchangedGate.run(ctx)
    assert.deepEqual(post, { ok: true })
  })

  it('post-gate fails when the origin tracking ref first appears (pre null → post sha)', async () => {
    const { ctx, setOrigin } = makeHarness(null)
    const pre = await captureOriginTrackingGate.run(ctx)
    assert.equal(pre.ok, true)
    assert.equal(ctx.state.originTrackingSha, null)

    // Simulate the agent performing the first push that creates origin/main.
    setOrigin('sha-new')
    const post = await originTrackingUnchangedGate.run(ctx)
    if (post.ok) {
      assert.fail('expected post-gate to fail when the tracking ref first appears')
    }
    assert.match(post.remediation ?? '', /wrenyard project push/)
  })

  it('skips detection on detached HEAD', async () => {
    const ctx = {
      task: { name: 'commit', sourcePath: 'lib/standard/tasks/commit.mts' },
      input: {},
      workDir: '/repo',
      workspaceRoot: '/workspace',
      project: 'app',
      taskId: 'task-1',
      state: {},
      shell: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    } as unknown as GateContext

    const pre = await captureOriginTrackingGate.run(ctx)
    assert.equal(pre.ok, true)
    assert.equal(ctx.state.originTrackingSha, null)

    const post = await originTrackingUnchangedGate.run(ctx)
    assert.deepEqual(post, { ok: true })
  })
})
