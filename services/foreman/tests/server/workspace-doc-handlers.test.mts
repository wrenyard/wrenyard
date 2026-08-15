/**
 * Tests for workspace.doc.* handler path security.
 *
 * Uses a temp workspace and RpcRouter to cover:
 * - list/read/create/update happy paths
 * - Rejection of: absolute paths, parent traversal, disallowed root, non-Markdown,
 *   overwrite-via-create, missing-via-update, symlink escapes
 */

import { describe, it, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { WorkspaceDocService } from '../../lib/daemon/services/work/workspace-doc-service.mts'
import { registerWorkspaceDocHandlers } from '../../lib/server/handlers/workspace-doc.mts'

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface MakeWorkspaceResult {
  workspace: string
  router: RpcRouter
}

function makeWorkspace(): MakeWorkspaceResult {
  const workspace = makeTempDir('workspace-doc-test-')
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  mkdirSync(join(workspace, 'memories'), { recursive: true })
  mkdirSync(join(workspace, 'projects', 'test', 'docs'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), '# Agents\n', 'utf-8')
  writeFileSync(join(workspace, 'FWA.md'), '# FWA\n', 'utf-8')
  writeFileSync(join(workspace, 'WORK.md'), '# Work\n', 'utf-8')
  writeFileSync(join(workspace, 'docs', 'readme.md'), '# Docs\n', 'utf-8')
  writeFileSync(join(workspace, 'docs', 'guide.md'), '# Guide\n', 'utf-8')
  writeFileSync(join(workspace, 'memories', 'context.md'), '# Context\n', 'utf-8')
  writeFileSync(join(workspace, 'projects', 'test', 'docs', 'api.md'), '# API\n', 'utf-8')
  const router = new RpcRouter()
  registerWorkspaceDocHandlers(router, new WorkspaceDocService(workspace))
  return { workspace, router }
}

async function callHandler(router: RpcRouter, method: string, params: unknown): Promise<unknown> {
  const response = await router.handleMessage({
    jsonrpc: '2.0',
    id: 'test',
    method,
    params,
  })
  if (!response) throw new Error('No response')
  if ('error' in response) throw new Error(`RPC error: ${response.error.message}`)
  return response.result
}

describe('workspace.doc handlers', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    tempDirs = []
  })

  it('lists files including root docs and memories', async () => {
    const { workspace, router } = makeWorkspace()
    const result = await callHandler(router, 'workspace.doc.list', {}) as { files: Array<{ path: string }> }
    const paths = result.files.map((f) => f.path)
    assert.ok(paths.includes('AGENTS.md'), 'should include AGENTS.md')
    assert.ok(paths.includes('FWA.md'), 'should include FWA.md')
    assert.ok(paths.includes('WORK.md'), 'should include WORK.md')
    assert.ok(paths.includes('docs/readme.md'), 'should include docs/readme.md')
    assert.ok(paths.includes('memories/context.md'), 'should include memories/context.md')
    assert.ok(paths.includes('projects/test/docs/api.md'), 'should include projects/test/docs/api.md')
  })

  it('reads a doc file', async () => {
    const { workspace, router } = makeWorkspace()
    const result = await callHandler(router, 'workspace.doc.read', { path: 'docs/readme.md' }) as { path: string; content: string }
    assert.equal(result.path, 'docs/readme.md')
    assert.equal(result.content, '# Docs\n')
  })

  it('creates a new doc file (exclusive create)', async () => {
    const { workspace, router } = makeWorkspace()
    const result = await callHandler(router, 'workspace.doc.create', { path: 'docs/new.md', content: '# New\n' }) as { path: string }
    assert.equal(result.path, 'docs/new.md')
    // Verify it was actually written
    const readResult = await callHandler(router, 'workspace.doc.read', { path: 'docs/new.md' }) as { content: string }
    assert.equal(readResult.content, '# New\n')
  })

  it('rejects create for an existing file', async () => {
    const { workspace, router } = makeWorkspace()
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.create', { path: 'docs/readme.md', content: '# Overwrite\n' }),
      /already exists/,
    )
  })

  it('updates an existing doc file', async () => {
    const { workspace, router } = makeWorkspace()
    const result = await callHandler(router, 'workspace.doc.update', { path: 'docs/readme.md', content: '# Updated\n' }) as { path: string }
    assert.equal(result.path, 'docs/readme.md')
    const readResult = await callHandler(router, 'workspace.doc.read', { path: 'docs/readme.md' }) as { content: string }
    assert.equal(readResult.content, '# Updated\n')
  })

  it('rejects update for a non-existing file', async () => {
    const { workspace, router } = makeWorkspace()
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.update', { path: 'docs/nonexistent.md', content: '# Nope\n' }),
      /not found/,
    )
  })

  it('rejects absolute paths', async () => {
    const { workspace, router } = makeWorkspace()
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.read', { path: '/etc/passwd' }),
      /absolute path/i,
    )
  })

  it('rejects parent traversal', async () => {
    const { workspace, router } = makeWorkspace()
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.read', { path: 'docs/../../secret.md' }),
      /parent traversal/i,
    )
  })

  it('rejects non-Markdown paths', async () => {
    const { workspace, router } = makeWorkspace()
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.read', { path: 'docs/notes.txt' }),
      /only .md files are allowed/i,
    )
  })

  it('rejects paths outside allowed roots', async () => {
    const { workspace, router } = makeWorkspace()
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.read', { path: 'node_modules/foo.md' }),
      /not in allowed documentation directories/i,
    )
  })

  it('rejects symlink escape via final-file symlink', async () => {
    const { workspace, router } = makeWorkspace()
    const outsideDir = makeTempDir('external-docs-')
    writeFileSync(join(outsideDir, 'secret.md'), 'secret content\n', 'utf-8')
    symlinkSync(join(outsideDir, 'secret.md'), join(workspace, 'docs', 'escape.md'))
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.read', { path: 'docs/escape.md' }),
      /symlink escape/i,
    )
  })

  it('rejects symlink escape via parent-directory symlink', async () => {
    const { workspace, router } = makeWorkspace()
    const outsideDir = makeTempDir('external-docs-parent-')
    writeFileSync(join(outsideDir, 'secret.md'), 'parent escape\n', 'utf-8')
    rmSync(join(workspace, 'docs'), { recursive: true, force: true })
    symlinkSync(outsideDir, join(workspace, 'docs'))
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.read', { path: 'docs/secret.md' }),
      /symlink escape/i,
    )
  })

  it('rejects create when parent dir is a symlink escape', async () => {
    const { workspace, router } = makeWorkspace()
    const outsideDir = makeTempDir('external-create-parent-')
    rmSync(join(workspace, 'docs'), { recursive: true, force: true })
    symlinkSync(outsideDir, join(workspace, 'docs'))
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.create', { path: 'docs/new.md', content: '# escape\n' }),
      /symlink escape/i,
    )
  })

  it('rejects list with parent traversal directory', async () => {
    const { workspace, router } = makeWorkspace()
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.list', { directory: 'docs/../../etc' }),
      /parent traversal/i,
    )
  })

  it('rejects list with disallowed directory prefix', async () => {
    const { workspace, router } = makeWorkspace()
    await assert.rejects(
      () => callHandler(router, 'workspace.doc.list', { directory: 'node_modules' }),
      /not an allowed documentation prefix/i,
    )
  })

  it('lists nested projects/**/docs files', async () => {
    const workspace = makeTempDir('workspace-proj-doc-')
    mkdirSync(join(workspace, 'projects', 'parent', 'child', 'docs'), { recursive: true })
    writeFileSync(join(workspace, 'projects', 'parent', 'child', 'docs', 'deep.md'), '# Deep\n', 'utf-8')
    const router = new RpcRouter()
    registerWorkspaceDocHandlers(router, new WorkspaceDocService(workspace))
    const result = await callHandler(router, 'workspace.doc.list', {}) as { files: Array<{ path: string }> }
    const paths = result.files.map((f) => f.path)
    assert.ok(paths.includes('projects/parent/child/docs/deep.md'), 'should include deeply nested project doc')
  })

  it('reads nested projects/**/docs files', async () => {
    const workspace = makeTempDir('workspace-proj-read-')
    mkdirSync(join(workspace, 'projects', 'alpha', 'beta', 'docs'), { recursive: true })
    writeFileSync(join(workspace, 'projects', 'alpha', 'beta', 'docs', 'guide.md'), '# Guide\n', 'utf-8')
    const router = new RpcRouter()
    registerWorkspaceDocHandlers(router, new WorkspaceDocService(workspace))
    const result = await callHandler(router, 'workspace.doc.read', { path: 'projects/alpha/beta/docs/guide.md' }) as { content: string }
    assert.equal(result.content, '# Guide\n')
  })
})
