import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync, readFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { initDb, closeDb } from '../../lib/db/connection.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import { FwaSessionStore } from '../../lib/core/fwa/session-store.mts'
import { createWorkspaceDocPort } from '../../lib/daemon/services/fwa/workspace-doc-port.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'

let db: ForemanDatabase
let tmpDir: string

function canSymlink(): boolean {
  try {
    const target = join(tmpDir, '_symlink_test_target')
    const link = join(tmpDir, '_symlink_test_link')
    writeFileSync(target, '')
    symlinkSync(target, link)
    unlinkSync(link)
    unlinkSync(target)
    return true
  } catch {
    return false
  }
}

void describe('workspace-doc-port', () => {
  before(() => {
    db = initDb(':memory:')
    bootstrapSchema(db)
    tmpDir = mkdtempSync(join(tmpdir(), 'fwa-workspace-port-test-'))
  })

  after(() => {
    closeDb()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  void it('creates nested directory and file exclusively', async () => {
    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-create-1', ticket_id: 't-1', project_id: 'p-1', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-create-1', store })

    const result = await port.create('nested/a/b/file.txt', 'exclusive content')
    assert.equal(result.session_id, 's-create-1')
    const fullPath = join(tmpDir, 'nested/a/b/file.txt')
    assert.ok(existsSync(fullPath), 'file should exist after create')
    assert.equal(readFileSync(fullPath, 'utf-8'), 'exclusive content')
    rmSync(join(tmpDir, 'nested'), { recursive: true, force: true })
  })

  void it('rejects overwriting an existing file via create', async () => {
    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-overwrite-1', ticket_id: 't-2', project_id: 'p-2', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-overwrite-1', store })

    await port.create('existing.txt', 'first')
    await assert.rejects(
      () => port.create('existing.txt', 'second'),
      /file already exists|EEXIST/u,
    )
    assert.equal(readFileSync(join(tmpDir, 'existing.txt'), 'utf-8'), 'first', 'content should remain unchanged')
    unlinkSync(join(tmpDir, 'existing.txt'))
  })

  void it('reconstructs port for same session and deletes owned file', async () => {
    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-delete-own', ticket_id: 't-3', project_id: 'p-3', status: 'idle', graph_refs: [], task_refs: [] })

    const port1 = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-delete-own', store })
    await port1.create('owned-by-session.txt', 'owned')
    const fullPath = join(tmpDir, 'owned-by-session.txt')
    assert.ok(existsSync(fullPath))

    // Reconstruct port for same session
    const port2 = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-delete-own', store })
    const deleted = await port2.delete('owned-by-session.txt')
    assert.ok(deleted, 'delete should succeed')
    assert.equal(existsSync(fullPath), false, 'file should be deleted')
  })

  void it('rejects deletion by another session', async () => {
    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-owner', ticket_id: 't-4', project_id: 'p-4', status: 'idle', graph_refs: [], task_refs: [] })
    store.createSession({ id: 's-intruder', ticket_id: 't-5', project_id: 'p-5', status: 'idle', graph_refs: [], task_refs: [] })

    const ownerPort = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-owner', store })
    await ownerPort.create('intruder-test.txt', 'secret')

    const intruderPort = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-intruder', store })
    await assert.rejects(
      () => intruderPort.delete('intruder-test.txt'),
      /not created by this session/u,
    )
    assert.ok(existsSync(join(tmpDir, 'intruder-test.txt')), 'file should survive intruder delete attempt')
    unlinkSync(join(tmpDir, 'intruder-test.txt'))
  })

  void it('rejects operations outside workspace via absolute path', async () => {
    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-abs', ticket_id: 't-abs', project_id: 'p-abs', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-abs', store })

    await assert.rejects(() => port.read('/etc/passwd'), /must be relative/u)
    await assert.rejects(() => port.write('/etc/passwd', 'x'), /must be relative/u)
    await assert.rejects(() => port.create('/etc/passwd', 'x'), /must be relative/u)
    await assert.rejects(() => port.list('/etc'), /must be relative/u)
    await assert.rejects(() => port.delete('/etc/passwd'), /must be relative/u)
  })

  void it('rejects operations outside workspace via parent segments', async () => {
    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-parent', ticket_id: 't-parent', project_id: 'p-parent', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-parent', store })

    await assert.rejects(() => port.read('../etc/passwd'), /traverse above root/u)
    await assert.rejects(() => port.write('../outside.txt', 'x'), /traverse above root/u)
    await assert.rejects(() => port.create('../outside.txt', 'x'), /traverse above root/u)
    await assert.rejects(() => port.list('..'), /traverse above root/u)
    await assert.rejects(() => port.delete('../outside.txt'), /traverse above root/u)
  })

  void it('rejects operations outside workspace via deep parent segments', async () => {
    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-deep', ticket_id: 't-deep', project_id: 'p-deep', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-deep', store })

    await assert.rejects(() => port.read('safe/../../etc/passwd'), /traverse above root/u)
  })

  void it('rejects symlink escape via read', async () => {
    if (!canSymlink()) return

    const wsRoot = join(tmpDir, 'symlink-read-ws')
    mkdirSync(wsRoot, { recursive: true })
    const outsideDir = join(tmpDir, 'symlink-read-outside')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'secret.txt'), 'outside content')
    symlinkSync(outsideDir, join(wsRoot, 'escape-link'))

    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-sym-read', ticket_id: 't-sym-read', project_id: 'p-sym-read', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: wsRoot, sessionId: 's-sym-read', store })

    await assert.rejects(
      () => port.read('escape-link/secret.txt'),
      /outside workspace root/u,
    )
  })

  void it('rejects symlink escape via write', async () => {
    if (!canSymlink()) return

    const wsRoot = join(tmpDir, 'symlink-write-ws')
    mkdirSync(wsRoot, { recursive: true })
    const outsideDir = join(tmpDir, 'symlink-write-outside')
    mkdirSync(outsideDir, { recursive: true })
    symlinkSync(outsideDir, join(wsRoot, 'escape-link'))

    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-sym-write', ticket_id: 't-sym-write', project_id: 'p-sym-write', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: wsRoot, sessionId: 's-sym-write', store })

    await assert.rejects(
      () => port.write('escape-link/hacked.txt', 'hacked'),
      /outside workspace root/u,
    )
  })

  void it('rejects symlink escape via list', async () => {
    if (!canSymlink()) return

    const wsRoot = join(tmpDir, 'symlink-list-ws')
    mkdirSync(wsRoot, { recursive: true })
    const outsideDir = join(tmpDir, 'symlink-list-outside')
    mkdirSync(outsideDir, { recursive: true })
    symlinkSync(outsideDir, join(wsRoot, 'escape-list-link'))

    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-sym-list', ticket_id: 't-sym-list', project_id: 'p-sym-list', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: wsRoot, sessionId: 's-sym-list', store })

    await assert.rejects(
      () => port.list('escape-list-link'),
      /outside workspace root/u,
    )
  })

  void it('rejects symlink escape via delete of owned file', async () => {
    if (!canSymlink()) return

    const wsRoot = join(tmpDir, 'symlink-delete-ws')
    mkdirSync(wsRoot, { recursive: true })
    const outsideDir = join(tmpDir, 'symlink-delete-outside')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'target.txt'), 'target content')
    symlinkSync(outsideDir, join(wsRoot, 'escape-del-link'))

    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-sym-del', ticket_id: 't-sym-del', project_id: 'p-sym-del', status: 'idle', graph_refs: [], task_refs: [] })

    // Create and own the file through the symlink so ownership is recorded
    // But the write/create would fail because of containment...
    // Instead, directly record ownership to test the delete path
    mkdirSync(join(wsRoot, 'escape-del-link'), { recursive: true })
    store.recordDocOwnership('s-sym-del', 'escape-del-link')

    const port = createWorkspaceDocPort({ workspaceRoot: wsRoot, sessionId: 's-sym-del', store })
    await assert.rejects(
      () => port.delete('escape-del-link'),
      /outside workspace root|symbolic link/u,
    )
    // The outside target must remain unchanged
    assert.equal(existsSync(join(outsideDir, 'target.txt')), true, 'outside target should be untouched')
  })

  void it('rejects write when final path is a symbolic link', async () => {
    if (!canSymlink()) return

    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-sym-final-write', ticket_id: 't-sym-final-write', project_id: 'p-sym-final-write', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-sym-final-write', store })

    // Create a real file, then replace it with a symlink pointing outside
    await port.create('replaceable.txt', 'original')
    const linkTarget = join(tmpDir, 'symlink-target-outside')
    mkdirSync(linkTarget, { recursive: true })
    writeFileSync(join(linkTarget, 'outside-content.txt'), 'outside data')

    // Replace the owned file with a symlink
    unlinkSync(join(tmpDir, 'replaceable.txt'))
    symlinkSync(linkTarget, join(tmpDir, 'replaceable.txt'))

    // Write must reject without modifying the symlink target
    await assert.rejects(
      () => port.write('replaceable.txt', 'new content'),
      /symbolic link/u,
    )
    assert.equal(existsSync(join(linkTarget, 'outside-content.txt')), true, 'symlink target should be untouched')
  })

  void it('rejects delete when final path is a symbolic link', async () => {
    if (!canSymlink()) return

    const store = new FwaSessionStore(db)
    store.createSession({ id: 's-sym-final-del', ticket_id: 't-sym-final-del', project_id: 'p-sym-final-del', status: 'idle', graph_refs: [], task_refs: [] })
    const port = createWorkspaceDocPort({ workspaceRoot: tmpDir, sessionId: 's-sym-final-del', store })

    // Create a real file, record ownership, then replace with symlink
    await port.create('deleteable.txt', 'original')
    const linkTarget = join(tmpDir, 'symlink-del-target')
    mkdirSync(linkTarget, { recursive: true })
    writeFileSync(join(linkTarget, 'protected.txt'), 'protected data')

    unlinkSync(join(tmpDir, 'deleteable.txt'))
    symlinkSync(linkTarget, join(tmpDir, 'deleteable.txt'))

    // Delete must reject without removing the symlink target
    await assert.rejects(
      () => port.delete('deleteable.txt'),
      /symbolic link/u,
    )
    assert.equal(existsSync(join(linkTarget, 'protected.txt')), true, 'symlink target should be untouched')
  })
})
