import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ProjectManager, type ProjectDetail, type ProjectOverview } from '../lib/core/project/manager.mts'

let tempDirs: string[] = []
const oldStateHome = process.env.XDG_STATE_HOME

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init'])
  git(path, ['config', 'user.name', 'Foreman Test'])
  git(path, ['config', 'user.email', 'foreman@example.test'])
  git(path, ['checkout', '-b', 'main'])
  writeFileSync(join(path, 'README.md'), '# test repo\n', 'utf-8')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-m', 'initial'])
}

function initBareRemote(path: string): void {
  git(dirname(path), ['init', '--bare', path])
  git(path, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
}

function attachOrigin(repo: string, remote: string): void {
  git(repo, ['remote', 'add', 'origin', remote])
  git(repo, ['push', '-u', 'origin', 'main'])
}

function commitFile(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content, 'utf-8')
  git(repo, ['add', file])
  git(repo, ['commit', '-m', message])
}

function writeFmproj(dir: string, name: string, host: string, path: string, options: { git?: boolean } = { git: true }): void {
  mkdirSync(dir, { recursive: true })
  const gitBlock = options.git === false
    ? ''
    : `git:\n  remote: https://example.test/${name}.git\n  default_branch: main\n`
  writeFileSync(
    join(dir, `${name}.fmproj`),
    `name: ${name}\ndescription: Test project\n${gitBlock}hosts:\n  ${host}: ${JSON.stringify(path)}\n`,
    'utf-8',
  )
}

function worktreesRoot(): string {
  const stateHome = process.env.XDG_STATE_HOME
  assert.ok(stateHome)
  return join(stateHome, 'wrenyard', 'worktrees')
}

function worktreePath(id: string): string {
  return join(worktreesRoot(), id)
}

function writeWorktreeMetadata(id: string, project: string, path: string): void {
  mkdirSync(join(worktreesRoot(), '.foreman'), { recursive: true })
  writeFileSync(
    join(worktreesRoot(), '.foreman', `${id}.json`),
    `${JSON.stringify({ id, project, path }, null, 2)}\n`,
    'utf-8',
  )
}

function installPostCheckoutAdvanceHook(repo: string): void {
  const hook = join(repo, '.git', 'hooks', 'post-checkout')
  writeFileSync(
    hook,
    `#!/bin/sh
if [ "$3" = "1" ] && [ "$(git branch --show-current)" = "main" ] && [ ! -f .git/foreman-hook-ran ]; then
  touch .git/foreman-hook-ran
  printf 'hook advancement\\n' > hook.txt
  git add hook.txt >/dev/null 2>&1
  git -c user.name='Foreman Test' -c user.email='foreman@example.test' commit -m 'advance main in hook' >/dev/null 2>&1
fi
`,
    'utf-8',
  )
  chmodSync(hook, 0o755)
}

function writeFailBranchDeleteGitBin(dir: string): string {
  const path = join(dir, 'git-fail-branch-delete')
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "branch" ] && [ "$2" = "-d" ]; then
  echo "fatal: simulated branch delete failure" >&2
  exit 1
fi
exec /usr/bin/env git "$@"
`,
    'utf-8',
  )
  chmodSync(path, 0o755)
  return path
}

function writeFailRevListCountGitBin(dir: string): string {
  const path = join(dir, 'git-fail-rev-list-count')
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "rev-list" ] && [ "$2" = "--count" ]; then
  echo "fatal: simulated rev-list --count failure" >&2
  exit 1
fi
exec /usr/bin/env git "$@"
`,
    'utf-8',
  )
  chmodSync(path, 0o755)
  return path
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = makeTempDir('foreman-state-home-')
})

afterEach(() => {
  if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = oldStateHome
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('ProjectManager', () => {
  it('loads projects for the configured hostname without an implicit workspace', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)

    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })
    const status = manager.status() as ProjectOverview[]

    assert.equal(manager.getProject('app').gitRemote, 'https://example.test/app.git')
    assert.deepEqual(status, [
      {
        name: 'app',
        path: repo,
        worktree_count: 0,
      },
    ])
  })

  it('does not register an implicit workspace project', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    assert.deepEqual(manager.listProjects(), [])
    assert.throws(() => manager.getProject('workspace'), /Project 'workspace' is not registered/u)
  })

  it('does not add workspace when only another host is configured', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'other-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    assert.deepEqual(manager.listProjects(), [])
  })

  it('suggests suffix-less host keys when ordinal mac hostnames have no mapping', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'other-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'DLK-MAC-4.local' })

    assert.throws(
      () => manager.getProject('app'),
      /Host matching ignores trailing -<digits> and \.local; prefer suffix-less host key 'DLK-MAC\.local'/u,
    )
  })

  it('rejects workspace-prefixed project specs as dispatch targets', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    assert.throws(
      () => manager.resolveBasePath('workspace/ure'),
      /Project 'workspace\/ure' is not registered/,
    )
    assert.throws(
      () => manager.getProject('workspace/ure/service'),
      /Project 'workspace\/ure\/service' is not registered/,
    )
  })

  it('resolves non-workspace project specs to their configured host paths', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    writeFmproj(join(workspace, 'projects', 'ure'), 'ure', 'test-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    assert.equal(manager.resolveBasePath('ure'), repo)
  })

  it('rejects worktree creation when workspace is not a registered project', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })

    assert.throws(() => manager.createWorktree('workspace'), /Project 'workspace' is not registered/u)
  })

  it('uses .fmproj git.remote to decide whether a project supports worktrees', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    mkdirSync(repo, { recursive: true })
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo, { git: false })
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      gitBin: 'missing-git-binary',
    })

    assert.deepEqual(manager.getProject('app'), {
      name: 'app',
      path: repo,
      noWorktree: true,
      implicit: false,
    })
    assert.deepEqual((manager.status('app') as ProjectDetail).worktrees, [])
    assert.throws(() => manager.createWorktree('app'), /does not declare git\.remote/u)
  })

  it('creates, reports, resolves, and removes managed worktrees', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })

    const created = manager.createWorktree('app')
    const expectedPath = worktreePath('deadbeef')

    assert.deepEqual(created, {
      project: 'app',
      worktree_id: 'deadbeef',
      path: expectedPath,
      branch: 'wrenyard/deadbeef',
    })
    assert.equal(existsSync(expectedPath), true)
    assert.equal(existsSync(join(workspace, 'worktrees')), false)
    assert.equal(manager.resolveWorktreePath('deadbeef', 'app'), realpathSync(expectedPath))

    const detail = manager.status('app') as ProjectDetail
    assert.equal(detail.name, 'app')
    assert.equal(detail.path, repo)
    assert.deepEqual(detail.worktrees, [
      {
        id: 'deadbeef',
        path: expectedPath,
        branch: 'wrenyard/deadbeef',
        clean: true,
      },
    ])

    assert.deepEqual(manager.removeWorktree('deadbeef'), {
      worktree_id: 'deadbeef',
      removed: true,
      project: 'app',
      path: expectedPath,
    })
    assert.equal(existsSync(expectedPath), false)
  })

  it('creates managed worktrees for qualified project names', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    writeFmproj(join(workspace, 'projects', 'ure', 'site'), 'site', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })

    const created = manager.createWorktree('ure/site')
    const expectedPath = worktreePath('deadbeef')

    assert.deepEqual(created, {
      project: 'ure/site',
      worktree_id: 'deadbeef',
      path: expectedPath,
      branch: 'wrenyard/deadbeef',
    })
    assert.equal(existsSync(expectedPath), true)
  })

  it('resolves monorepo worktree paths to the registered component and rejects other projects', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    const controlPath = join(repo, 'services', 'control')
    const enginePath = join(repo, 'runtime', 'engine')
    mkdirSync(controlPath, { recursive: true })
    mkdirSync(enginePath, { recursive: true })
    commitFile(repo, 'services/control/control.txt', 'control\n', 'add control component')
    commitFile(repo, 'runtime/engine/engine.txt', 'engine\n', 'add engine component')
    writeFmproj(join(workspace, 'projects', 'control'), 'control', 'test-host.local', controlPath)
    writeFmproj(join(workspace, 'projects', 'engine'), 'engine', 'test-host.local', enginePath)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })

    const created = manager.createWorktree('control')
    const expectedPath = worktreePath('deadbeef')

    assert.equal(
      manager.resolveWorktreePath('deadbeef', 'control'),
      realpathSync(join(expectedPath, 'services', 'control')),
    )
    assert.throws(
      () => manager.resolveWorktreePath('deadbeef', 'engine'),
      /belongs to project 'control', not 'engine'/u,
    )

    // A tracked or locally substituted symlink cannot redirect execution
    // outside the managed worktree root. Replace the component with a symlink
    // (junction on Windows) to an external directory and expect the
    // containment check to reject it.
    const componentInWorktree = join(expectedPath, 'services', 'control')
    const external = makeTempDir('foreman-symlink-target-')
    writeFileSync(join(external, 'marker.txt'), 'external\n', 'utf-8')
    rmSync(componentInWorktree, { recursive: true, force: true })
    symlinkSync(external, componentInWorktree, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(
      () => manager.resolveWorktreePath('deadbeef', 'control'),
      /escapes the managed worktree root/u,
    )
    rmSync(componentInWorktree, { recursive: true, force: true })

    // A missing component inside the worktree is rejected instead of resolved.
    assert.throws(
      () => manager.resolveWorktreePath('deadbeef', 'control'),
      /Managed worktree component path does not exist/u,
    )
  })

  it('merges a clean managed worktree into main and removes it', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })
    const created = manager.createWorktree('app')
    commitFile(created.path, 'feature.txt', 'merged from worktree\n', 'feature work')

    const result = manager.mergeWorktree('app', 'deadbeef')

    assert.equal(result.merged, true)
    assert.equal(result.removed, true)
    assert.equal(result.branch_deleted, true)
    assert.equal(result.project, 'app')
    assert.equal(result.worktree_id, 'deadbeef')
    assert.equal(result.branch, 'wrenyard/deadbeef')
    assert.equal(result.target_branch, 'main')
    assert.equal(result.worktree_path, created.path)
    assert.equal(result.commit_count, 1)
    assert.equal(result.remote_check?.status, 'skipped')
    assert.equal(existsSync(created.path), false)
    assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf-8').replace(/\r\n/gu, '\n'), 'merged from worktree\n')
    assert.deepEqual((manager.status('app') as ProjectDetail).worktrees, [])
    assert.throws(() => git(repo, ['rev-parse', '--verify', 'refs/heads/wrenyard/deadbeef']))
  })

  it('merges a worktree when the main checkout is strictly ahead of origin/main', () => {
    const remoteRoot = makeTempDir('foreman-remote-root-')
    const remote = join(remoteRoot, 'origin.git')
    initBareRemote(remote)
    const repoRoot = makeTempDir('foreman-clone-root-')
    const repo = join(repoRoot, 'repo')
    initRepo(repo)
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['push', '-u', 'origin', 'main'])
    commitFile(repo, 'local.txt', 'local unpushed\n', 'local main ahead')

    const workspace = makeTempDir('foreman-workspace-')
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })
    const created = manager.createWorktree('app')
    commitFile(created.path, 'feature.txt', 'worktree commit\n', 'feature work')

    const result = manager.mergeWorktree('app', 'deadbeef')

    assert.equal(result.merged, true)
    assert.equal(result.removed, true)
    assert.equal(result.branch_deleted, true)
    assert.equal(result.reason, undefined)
    assert.equal(result.remote_check?.status, 'checked')
    assert.equal(result.remote_check?.remote_ahead_by, 0)
    assert.equal(result.remote_check?.local_ahead_by, 1)
    assert.equal(existsSync(created.path), false)
    assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf-8').replace(/\r\n/gu, '\n'), 'worktree commit\n')
    assert.throws(() => git(repo, ['rev-parse', '--verify', 'refs/heads/wrenyard/deadbeef']))
  })

  it('fails closed when the remote-ahead ancestry count cannot be computed', () => {
    const remoteRoot = makeTempDir('foreman-remote-root-')
    const remote = join(remoteRoot, 'origin.git')
    initBareRemote(remote)
    const repoRoot = makeTempDir('foreman-clone-root-')
    const repo = join(repoRoot, 'repo')
    initRepo(repo)
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['push', '-u', 'origin', 'main'])
    commitFile(repo, 'local.txt', 'local unpushed\n', 'local main ahead')

    const workspace = makeTempDir('foreman-workspace-')
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const gitBin = writeFailRevListCountGitBin(makeTempDir('foreman-git-wrapper-'))
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
      gitBin,
    })
    const created = manager.createWorktree('app')
    commitFile(created.path, 'feature.txt', 'worktree commit\n', 'feature work')

    const result = manager.mergeWorktree('app', 'deadbeef')

    // Old fail-open path: remoteAheadBy null was treated as 0, so the local-ahead
    // branch was allowed and the merge proceeded. It must now fail closed instead.
    assert.equal(result.merged, false)
    assert.equal(result.removed, false)
    assert.equal(result.reason, 'target_branch_remote_count_unavailable')
    assert.equal(result.remote_check?.status, 'failed')
    assert.equal(result.remote_check?.reason, 'count_unavailable')
    assert.match(result.error ?? '', /refusing to allow merge/iu)
    assert.equal(existsSync(created.path), true)
  })

  it('reports branch_delete_failed without rolling back a successful merge', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const gitBin = writeFailBranchDeleteGitBin(makeTempDir('foreman-git-wrapper-'))
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
      gitBin,
    })
    const created = manager.createWorktree('app')
    commitFile(created.path, 'feature.txt', 'merged content\n', 'feature work')

    const result = manager.mergeWorktree('app', 'deadbeef')

    assert.equal(result.merged, true)
    assert.equal(result.removed, true)
    assert.equal(result.branch_deleted, false)
    assert.equal(result.reason, 'branch_delete_failed')
    assert.match(result.error ?? '', /simulated branch delete failure/iu)
    assert.equal(existsSync(created.path), false)
    assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf-8').replace(/\r\n/gu, '\n'), 'merged content\n')
    assert.equal(
      git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/wrenyard/deadbeef']).trim(),
      'wrenyard/deadbeef',
    )
  })

  it('pushes a clean project branch to origin', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    const remoteRoot = makeTempDir('foreman-remote-root-')
    const remote = join(remoteRoot, 'origin.git')
    initRepo(repo)
    initBareRemote(remote)
    attachOrigin(repo, remote)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })
    commitFile(repo, 'push.txt', 'pushed from project\n', 'project push')

    const result = manager.pushProject({ project: 'app' })

    assert.equal(result.pushed, true)
    assert.equal(result.project, 'app')
    assert.equal(result.branch, 'main')
    assert.equal(result.remote, 'origin')
    assert.equal(result.summary, 'Pushed app branch main to origin.')
    const localSha = git(repo, ['rev-parse', '--verify', 'main']).trim()
    const remoteSha = git(repo, ['ls-remote', 'origin', 'refs/heads/main']).trim().split(/\s+/u)[0]
    assert.equal(remoteSha, localSha)
  })

  it('pulls a clean project branch from origin', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    const remoteRoot = makeTempDir('foreman-remote-root-')
    const remote = join(remoteRoot, 'origin.git')
    const other = makeTempDir('foreman-other-repo-')
    initRepo(repo)
    initBareRemote(remote)
    attachOrigin(repo, remote)
    rmSync(other, { recursive: true, force: true })
    git(dirname(other), ['clone', remote, other])
    git(other, ['config', 'user.name', 'Foreman Test'])
    git(other, ['config', 'user.email', 'foreman@example.test'])
    commitFile(other, 'remote.txt', 'pulled from origin\n', 'remote change')
    git(other, ['push', 'origin', 'main'])
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    const result = manager.pullProject('app')

    assert.equal(result.pulled, true)
    assert.equal(result.project, 'app')
    assert.equal(result.branch, 'main')
    assert.equal(result.remote, 'origin')
    assert.equal(result.summary, 'Pulled app branch main from origin.')
    assert.equal(readFileSync(join(repo, 'remote.txt'), 'utf-8').replace(/\r\n/gu, '\n'), 'pulled from origin\n')
  })

  it('pushes a managed worktree branch by worktree id', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    const remoteRoot = makeTempDir('foreman-remote-root-')
    const remote = join(remoteRoot, 'origin.git')
    initRepo(repo)
    initBareRemote(remote)
    attachOrigin(repo, remote)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })
    const created = manager.createWorktree('app')
    commitFile(created.path, 'feature.txt', 'pushed from worktree\n', 'worktree push')

    const result = manager.pushProject({ worktreeId: 'deadbeef' })

    assert.equal(result.pushed, true)
    assert.equal(result.project, 'app')
    assert.equal(result.worktree_id, 'deadbeef')
    assert.equal(result.branch, 'wrenyard/deadbeef')
    assert.equal(result.summary, 'Pushed app worktree deadbeef branch wrenyard/deadbeef to origin.')
    const remoteSha = git(repo, ['ls-remote', 'origin', 'refs/heads/wrenyard/deadbeef']).trim()
    assert.match(remoteSha, /^[0-9a-f]{40}\s+refs\/heads\/wrenyard\/deadbeef$/u)
  })

  it('refuses to push a dirty checkout', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    const remoteRoot = makeTempDir('foreman-remote-root-')
    const remote = join(remoteRoot, 'origin.git')
    initRepo(repo)
    initBareRemote(remote)
    attachOrigin(repo, remote)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n', 'utf-8')

    const result = manager.pushProject({ project: 'app' })

    assert.equal(result.pushed, false)
    assert.equal(result.reason, 'dirty')
    assert.ok(result.dirty?.files.includes('dirty.txt'))
    assert.match(result.summary, /Push failed for project app: dirty/u)
  })

  it('fails dirty managed worktree merges with concrete details and keeps the worktree', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })
    const created = manager.createWorktree('app')
    writeFileSync(join(created.path, 'README.md'), '# staged change\n', 'utf-8')
    git(created.path, ['add', 'README.md'])
    writeFileSync(join(created.path, 'README.md'), '# staged change\n\nunstaged change\n', 'utf-8')
    writeFileSync(join(created.path, 'notes.txt'), 'untracked text\n', 'utf-8')

    const result = manager.mergeWorktree('app', 'deadbeef')

    assert.equal(result.merged, false)
    assert.equal(result.removed, false)
    assert.equal(result.reason, 'worktree_dirty')
    assert.equal(existsSync(created.path), true)
    assert.ok(result.dirty?.status.some((entry) => entry.includes('README.md')))
    assert.ok(result.dirty?.status.includes('?? notes.txt'))
    assert.ok(result.dirty?.files.includes('README.md'))
    assert.ok(result.dirty?.files.includes('notes.txt'))
    assert.match(result.dirty?.tracked_diff ?? '', /unstaged change/u)
    assert.match(result.dirty?.staged_diff ?? '', /staged change/u)
    assert.deepEqual(result.dirty?.untracked_text, [{
      path: 'notes.txt',
      size: 15,
      content: 'untracked text\n',
    }])
  })

  it('fails when the remote target branch has updates missing from the main checkout', () => {
    const remoteRoot = makeTempDir('foreman-remote-root-')
    const remote = join(remoteRoot, 'origin.git')
    git(remoteRoot, ['init', '--bare', remote])
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    const repoRoot = makeTempDir('foreman-clone-root-')
    const repo = join(repoRoot, 'repo')
    git(repoRoot, ['clone', remote, repo])
    initRepo(repo)
    git(repo, ['remote', 'set-url', 'origin', remote])
    git(repo, ['push', '-u', 'origin', 'main'])

    const workspace = makeTempDir('foreman-workspace-')
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })
    const created = manager.createWorktree('app')
    commitFile(created.path, 'feature.txt', 'worktree commit\n', 'feature work')

    const otherRoot = makeTempDir('foreman-other-root-')
    const other = join(otherRoot, 'other')
    git(otherRoot, ['clone', remote, other])
    git(other, ['config', 'user.name', 'Foreman Test'])
    git(other, ['config', 'user.email', 'foreman@example.test'])
    commitFile(other, 'remote.txt', 'remote advancement\n', 'advance remote')
    git(other, ['push', 'origin', 'main'])

    const result = manager.mergeWorktree('app', 'deadbeef')

    assert.equal(result.merged, false)
    assert.equal(result.removed, false)
    assert.equal(result.reason, 'target_branch_remote_ahead')
    assert.equal(result.remote_check?.status, 'failed')
    assert.equal(result.remote_check?.reason, 'remote_ahead')
    assert.ok(result.remote_check?.local_sha)
    assert.ok(result.remote_check?.remote_sha)
    assert.notEqual(result.remote_check?.local_sha, result.remote_check?.remote_sha)
    assert.equal(result.remote_check?.remote_ahead_by, 1)
    assert.match(result.error ?? '', /Orchestrator agent must update the main checkout from remote/iu)
    assert.equal(existsSync(created.path), true)
  })

  it('aborts rebase conflicts and keeps the worktree', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })
    const created = manager.createWorktree('app')
    commitFile(created.path, 'README.md', '# worktree change\n', 'worktree change')
    commitFile(repo, 'README.md', '# base change\n', 'base change')

    const result = manager.mergeWorktree('app', 'deadbeef')

    assert.equal(result.merged, false)
    assert.equal(result.removed, false)
    assert.equal(result.reason, 'rebase_failed')
    assert.match(result.error ?? '', /CONFLICT|could not apply|Patch failed/iu)
    assert.equal(existsSync(created.path), true)
    assert.equal(git(created.path, ['status', '--porcelain']).trim(), '')
  })

  it('restores the previous base checkout when final merge fails after checkout', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({
      workspaceRoot: workspace,
      hostname: 'test-host.local',
      idGenerator: () => 'deadbeef',
    })
    git(repo, ['checkout', '-b', 'scratch'])
    const priorHead = git(repo, ['rev-parse', '--verify', 'HEAD']).trim()
    const created = manager.createWorktree('app')
    commitFile(created.path, 'feature.txt', 'worktree commit\n', 'feature work')
    installPostCheckoutAdvanceHook(repo)

    const result = manager.mergeWorktree('app', 'deadbeef')

    assert.equal(result.merged, false)
    assert.equal(result.removed, false)
    assert.equal(result.reason, 'merge_failed')
    assert.match(result.error ?? '', /fast-forward/iu)
    assert.equal(result.prior_base_branch, 'scratch')
    assert.equal(result.prior_base_head, priorHead)
    assert.deepEqual(result.base_restore, {
      status: 'restored',
      ref: 'scratch',
    })
    assert.equal(git(repo, ['branch', '--show-current']).trim(), 'scratch')
    assert.equal(git(repo, ['rev-parse', '--verify', 'HEAD']).trim(), priorHead)
    assert.equal(existsSync(created.path), true)
  })

  it('returns project_mismatch when worktree metadata belongs to another project', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    const managedPath = worktreePath('deadbeef')
    initRepo(repo)
    mkdirSync(managedPath, { recursive: true })
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    writeWorktreeMetadata('deadbeef', 'other', managedPath)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    const result = manager.mergeWorktree('app', 'deadbeef')

    assert.equal(result.merged, false)
    assert.equal(result.removed, false)
    assert.equal(result.reason, 'project_mismatch')
    assert.equal(result.metadata_project, 'other')
    assert.equal(result.worktree_path, managedPath)
  })

  it('returns a structured merge failure for metadata that references a missing project', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const managedPath = worktreePath('deadbeef')
    mkdirSync(managedPath, { recursive: true })
    writeWorktreeMetadata('deadbeef', 'ghost', managedPath)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    const result = manager.mergeWorktree('ghost', 'deadbeef')

    assert.deepEqual(result, {
      project: 'ghost',
      worktree_id: 'deadbeef',
      merged: false,
      removed: false,
      worktree_path: managedPath,
      metadata_project: 'ghost',
      reason: 'metadata_project_missing',
      error: "Worktree 'deadbeef' metadata references missing project 'ghost'",
    })
  })

  it('returns a failure result when removing an unknown worktree id', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    assert.deepEqual(manager.removeWorktree('12345678'), {
      worktree_id: '12345678',
      removed: false,
      error: "Worktree '12345678' was not found",
    })
  })

  it('returns a clear removal failure when metadata references a missing project', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const managedPath = worktreePath('deadbeef')
    mkdirSync(managedPath, { recursive: true })
    writeWorktreeMetadata('deadbeef', 'ghost', managedPath)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    assert.deepEqual(manager.removeWorktree('deadbeef'), {
      worktree_id: 'deadbeef',
      removed: false,
      project: 'ghost',
      path: managedPath,
      error: "Worktree 'deadbeef' metadata references missing project 'ghost'",
    })
    assert.equal(existsSync(managedPath), true)
  })

  it('does not manage worktree directories without Foreman metadata', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    mkdirSync(worktreePath('12345678'), { recursive: true })
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    assert.throws(() => manager.resolveWorktreePath('12345678', 'app'), /Worktree '12345678' was not found/u)
    assert.deepEqual(manager.removeWorktree('12345678'), {
      worktree_id: '12345678',
      removed: false,
      error: "Worktree '12345678' was not found",
    })
  })

  it('returns commit log entries for a configured project checkout', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    commitFile(repo, 'file1.txt', 'v1', 'first commit')
    commitFile(repo, 'file2.txt', 'v2', 'second commit')
    const branch = git(repo, ['branch', '--show-current']).trim()
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    const result = manager.commitLog('app', 10)
    assert.equal(result.project, 'app')
    assert.equal(result.commits.length, 3) // initial + first + second
    assert.equal(result.commits[0].subject, 'second commit')
    assert.equal(result.commits[2].subject, 'initial')
    assert.ok(result.commits[0].sha.length >= 7)
    assert.ok(result.commits[0].authored_at.length > 0)
    assert.ok(result.commits[0].author_name.length > 0)
  })

  it('respects the limit parameter in commitLog', () => {
    const workspace = makeTempDir('foreman-workspace-')
    const repo = makeTempDir('foreman-repo-')
    initRepo(repo)
    commitFile(repo, 'a.txt', 'a', 'commit 1')
    commitFile(repo, 'b.txt', 'b', 'commit 2')
    commitFile(repo, 'c.txt', 'c', 'commit 3')
    writeFmproj(join(workspace, 'projects', 'app'), 'app', 'test-host.local', repo)
    const manager = new ProjectManager({ workspaceRoot: workspace, hostname: 'test-host.local' })

    const result = manager.commitLog('app', 2)
    assert.ok(result.commits.length <= 2)
  })
})
