import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { execFile } from 'node:child_process'
import type {
  ClientCompatibility,
  ClientDiscovery,
  ClientSurfaceDiscovery,
  ClientSurfaceId,
} from './types.mts'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type CommandRunner = (executable: string, args: readonly string[]) => Promise<CommandResult>

export interface ClientCapabilityResult {
  compatibility: Exclude<ClientCompatibility, 'not-installed'>
  detail?: string
}

export interface ClientDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  appRoots?: readonly string[]
  runCommand?: CommandRunner
  capabilityProbes?: Partial<Record<ClientSurfaceId, (surface: ClientSurfaceDiscovery) => Promise<ClientCapabilityResult>>>
  pathExists?: (path: string, executable?: boolean) => Promise<boolean>
}

function runCommand(executable: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(executable, [...args], { timeout: 5_000 }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
        exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
          ? (error as NodeJS.ErrnoException & { code: number }).code
          : error ? 1 : 0,
      })
    })
  })
}

async function defaultPathExists(path: string, executable = false): Promise<boolean> {
  try {
    await access(path, executable ? constants.X_OK : constants.F_OK)
    return true
  } catch {
    return false
  }
}

function versionFromOutput(output: string): string | undefined {
  return /\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?/.exec(output)?.[0]
}

export async function findExecutable(name: string, env: NodeJS.ProcessEnv, exists: ClientDiscoveryOptions['pathExists']): Promise<string | undefined> {
  for (const root of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(root, process.platform === 'win32' ? `${name}.exe` : name)
    if (await exists!(candidate, true)) return candidate
  }
  return undefined
}

async function cliSurface(
  id: ClientSurfaceId,
  label: string,
  executableName: string,
  env: NodeJS.ProcessEnv,
  exists: ClientDiscoveryOptions['pathExists'],
  runner: CommandRunner,
): Promise<ClientSurfaceDiscovery> {
  const executable = await findExecutable(executableName, env, exists)
  if (!executable) return { id, label, installed: false, compatibility: 'not-installed' }
  const result = await runner(executable, ['--version'])
  const version = versionFromOutput(`${result.stdout}\n${result.stderr}`)
  return {
    id,
    label,
    installed: true,
    source: executable,
    ...(version ? { version } : {}),
    compatibility: result.exitCode === 0 ? 'supported' : 'needs-verification',
    ...(result.exitCode === 0 ? {} : { detail: '无法读取客户端版本' }),
  }
}

async function readBundle(
  id: ClientSurfaceId,
  label: string,
  candidates: readonly string[],
  exists: ClientDiscoveryOptions['pathExists'],
  runner: CommandRunner,
): Promise<ClientSurfaceDiscovery> {
  const root = await firstExisting(candidates, exists)
  if (!root) return { id, label, installed: false, compatibility: 'not-installed' }
  const plist = join(root, 'Contents', 'Info.plist')
  let version: string | undefined
  try {
    const raw = await readFile(plist, 'utf8')
    version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(raw)?.[1]
  } catch {
    // Binary plists are common.
  }
  if (!version && process.platform === 'darwin') {
    const result = await runner('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])
    if (result.exitCode === 0) version = result.stdout.trim() || undefined
  }
  return {
    id,
    label,
    installed: true,
    source: root,
    ...(version ? { version } : {}),
    compatibility: 'needs-verification',
    detail: '需要在应用内完成独立连接验收',
  }
}

async function firstExisting(candidates: readonly string[], exists: ClientDiscoveryOptions['pathExists']): Promise<string | undefined> {
  for (const candidate of candidates) if (await exists!(candidate)) return candidate
  return undefined
}

export class InstalledClientDiscovery implements ClientDiscovery {
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly appRoots: readonly string[]
  private readonly runner: CommandRunner
  private readonly exists: NonNullable<ClientDiscoveryOptions['pathExists']>

  constructor(private readonly options: ClientDiscoveryOptions = {}) {
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.appRoots = options.appRoots ?? ['/Applications', join(this.env.HOME ?? '', 'Applications')]
    this.runner = options.runCommand ?? runCommand
    this.exists = options.pathExists ?? defaultPathExists
  }

  async list(): Promise<readonly ClientSurfaceDiscovery[]> {
    const claudeAppCandidates = this.platform === 'darwin'
      ? this.appRoots.flatMap((root) => [join(root, 'Claude.app'), join(root, 'Claude-3p.app')])
      : []
    const codexAppCandidates = this.platform === 'darwin'
      ? this.appRoots.flatMap((root) => [join(root, 'ChatGPT.app'), join(root, 'Codex.app')])
      : []
    const surfaces = await Promise.all([
      readBundle('claude-app', 'Claude App', claudeAppCandidates, this.exists, this.runner),
      cliSurface('claude-code', 'Claude Code', 'claude', this.env, this.exists, this.runner),
      readBundle('codex-app', 'Codex App', codexAppCandidates, this.exists, this.runner),
      cliSurface('codex-cli', 'Codex CLI', 'codex', this.env, this.exists, this.runner),
      cliSurface('grok-build', 'Grok Build', 'grok', this.env, this.exists, this.runner),
    ])
    return Promise.all(surfaces.map(async (surface) => {
      if (!surface.installed) return surface
      const probe = this.options.capabilityProbes?.[surface.id] ?? this.defaultCapabilityProbe(surface.id)
      if (!probe) return surface
      const result = await probe(surface)
      return { ...surface, ...result }
    }))
  }

  private defaultCapabilityProbe(id: ClientSurfaceId): ((surface: ClientSurfaceDiscovery) => Promise<ClientCapabilityResult>) | undefined {
    if (id === 'claude-code') return (surface) => probeClaudeCodeSurface(surface)
    if (id === 'claude-app') return (surface) => probeClaudeAppSurface(surface, this.exists)
    if (id === 'codex-app') return (surface) => probeCodexAppSurface(surface, this.exists, this.runner)
    return undefined
  }
}

function versionTuple(value: string | undefined): [number, number, number] | undefined {
  if (!value) return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function versionAtLeast(value: string | undefined, minimum: [number, number, number]): boolean {
  const actual = versionTuple(value)
  if (!actual) return false
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

export async function probeClaudeCodeSurface(surface: ClientSurfaceDiscovery): Promise<ClientCapabilityResult> {
  if (!versionAtLeast(surface.version, [2, 1, 129])) {
    return { compatibility: 'needs-upgrade', detail: '当前版本不支持 Gateway 模型发现，请升级 Claude Code' }
  }
  return { compatibility: 'supported', detail: '支持 Gateway /v1/models 与 apiKeyHelper' }
}

export async function probeClaudeAppSurface(
  surface: ClientSurfaceDiscovery,
  exists: NonNullable<ClientDiscoveryOptions['pathExists']> = defaultPathExists,
): Promise<ClientCapabilityResult> {
  if (process.platform !== 'darwin') return { compatibility: 'needs-verification', detail: '当前仅完成 macOS 3P Gateway 验证' }
  for (const path of [
    '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist',
    '/Library/Managed Preferences/com.anthropic.claude.plist',
  ]) {
    if (await exists(path)) return { compatibility: 'externally-managed', detail: `检测到受管理配置：${path}` }
  }
  return { compatibility: 'supported', detail: '支持 Claude-3p configLibrary' }
}

export async function probeCodexAppSurface(
  surface: ClientSurfaceDiscovery,
  exists: NonNullable<ClientDiscoveryOptions['pathExists']> = defaultPathExists,
  runner: CommandRunner = runCommand,
): Promise<ClientCapabilityResult> {
  if (process.platform !== 'darwin' || !surface.source) {
    return { compatibility: 'needs-verification', detail: '当前仅完成 macOS Codex App 验证' }
  }
  const plist = join(surface.source, 'Contents', 'Info.plist')
  const bundle = await runner('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])
  if (bundle.exitCode !== 0 || bundle.stdout.trim() !== 'com.openai.codex') {
    return { compatibility: 'needs-verification', detail: '应用 bundle id 不是 com.openai.codex' }
  }
  const runtime = join(surface.source, 'Contents', 'Resources', 'codex')
  if (!await exists(runtime, true)) return { compatibility: 'needs-upgrade', detail: '未找到 Codex App 内置 runtime' }
  const version = await runner(runtime, ['--version'])
  if (version.exitCode !== 0) return { compatibility: 'needs-verification', detail: 'Codex App 内置 runtime 无法执行' }
  return { compatibility: 'supported', detail: `内置 runtime ${versionFromOutput(version.stdout) ?? '可用'}，需独立重启验收` }
}
