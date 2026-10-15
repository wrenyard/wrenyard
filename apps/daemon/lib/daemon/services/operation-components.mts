/**
 * Daemon-owned, machine-local operation components.
 *
 * Two components make an agent able to operate the outside world:
 *
 *   - `browser`: the `agent-browser` CLI (vercel-labs/agent-browser), pinned to
 *     one release and downloaded as a native asset so a new device needs no
 *     system npm or Node runtime.
 *   - `desktop`: the Cua Driver desktop-control MCP server (`cua-driver mcp`).
 *
 * The service owns discovery, health checks, user-triggered lifecycle actions
 * (install/update/repair/authorize/uninstall/enable/disable) and the persisted
 * disabled state. It never runs any of that on its own: a check is read-only and
 * an installation only happens through an explicit user action, because the
 * component is installed on this computer and may require operating-system
 * permissions.
 *
 * The constructor performs no I/O and never throws, so daemon startup cannot
 * fail because of a missing or broken component. Every check is bounded and
 * isolated: a missing, slow or failing executable becomes a snapshot state, not
 * an exception crossing the daemon boundary.
 *
 * Platform/installation policy:
 *
 *   - The browser binary lives under `<stateRoot>/components/agent-browser/` and
 *     is verified against the pinned SHA-256 before it is promoted. The previous
 *     version is retained for rollback.
 *   - The browser *runtime* (Chrome for Testing) is installed by the CLI itself
 *     into its own shared location; Wrenyard documents that location and never
 *     deletes it.
 *   - An existing external installation is discoverable and health-checked, but
 *     never silently overwritten, upgraded or removed.
 *   - Operating-system permissions are only ever requested by an explicit
 *     `authorize` action and are never granted silently.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { delimiter, join } from 'node:path'
import type { McpServer } from '@wrenyard/exec'

export type OperationComponentId = 'browser' | 'desktop'

export type OperationComponentState =
  | 'not-installed'
  | 'installing'
  | 'needs-authorization'
  | 'ready'
  | 'failed'
  | 'unsupported'
  | 'disabled'

export type OperationComponentAction =
  | 'refresh'
  | 'install'
  | 'update'
  | 'repair'
  | 'authorize'
  | 'uninstall'
  | 'enable'
  | 'disable'

export type OperationComponentHint =
  | 'legacy-browser-mcp'
  | 'shared-browser-runtime'
  | 'external-mcp'
  | 'existing-installation'
  | 'missing-accessibility'
  | 'missing-screen-recording'

export const OPERATION_COMPONENT_IDS: readonly OperationComponentId[] = ['browser', 'desktop']

export const OPERATION_COMPONENT_ACTIONS: readonly OperationComponentAction[] = [
  'refresh',
  'install',
  'update',
  'repair',
  'authorize',
  'uninstall',
  'enable',
  'disable',
]

/** One component's observed status, as rendered by Desktop Settings. */
export interface OperationComponentSnapshot {
  id: OperationComponentId
  /** Executable identity shown to the user: `agent-browser` or `Cua Driver`. */
  name: string
  state: OperationComponentState
  /** `managed` when Wrenyard installed it; `external` for a pre-existing install. */
  source?: 'managed' | 'external'
  version?: string
  /** The release Wrenyard pins and installs for this component. */
  pinnedVersion: string
  /** Absolute executable path, or the URL of an external HTTP MCP server. */
  path?: string
  /** Hostname of the machine the component belongs to (this computer). */
  host: string
  platform: string
  arch: string
  /** ISO timestamp of the last completed check. */
  checkedAt?: string
  progress?: { phase: string; receivedBytes?: number; totalBytes?: number }
  error?: string
  hints: OperationComponentHint[]
  actions: OperationComponentAction[]
}

/** Everything a run needs to use a ready component. */
export interface OperationComponentLaunch {
  id: OperationComponentId
  host: string
  /** Absolute executable, or an external MCP server's URL. */
  executable: string
  /** Present for the desktop component only. */
  mcpServer?: McpServer
  env: Record<string, string>
}

/** A requested component is not usable; carries the snapshot that explains why. */
export class OperationComponentUnavailableError extends Error {
  readonly snapshot: OperationComponentSnapshot

  constructor(snapshot: OperationComponentSnapshot) {
    super(
      `Operation component '${snapshot.name}' is not ready on host '${snapshot.host}' (${snapshot.state}${
        snapshot.error ? ': ' + snapshot.error : ''
      }). Open Settings > 操作组件 (Operation components) in Wrenyard Desktop on this computer to install, authorize or enable it.`,
    )
    this.name = 'OperationComponentUnavailableError'
    this.snapshot = snapshot
  }
}

const BROWSER_VERSION = '0.39.1'
const DESKTOP_VERSION = '0.35.4'

const BROWSER_RELEASE_BASE = `https://github.com/vercel-labs/agent-browser/releases/download/v${BROWSER_VERSION}`
const DESKTOP_RELEASE_BASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${DESKTOP_VERSION}`

interface PinnedAsset {
  readonly asset: string
  readonly sha256: string
}

/** Pinned official native browser builds, verified by SHA-256 before promotion. */
const BROWSER_ASSETS: Readonly<Record<string, PinnedAsset>> = {
  'darwin-arm64': {
    asset: 'agent-browser-darwin-arm64',
    sha256: 'cc18fac41d9dc9821918340a136e643286ea05544c4dd35671b796f1a874cdef',
  },
  'darwin-x64': {
    asset: 'agent-browser-darwin-x64',
    sha256: '339cb9aa6dfd404856cf938df34cd3b4779c61dfd57fc257be11b14fd1a885f9',
  },
  'win32-x64': {
    asset: 'agent-browser-win32-x64.exe',
    sha256: 'af1ff5f2afd5c187fb50ac3bbc1e7114baadc180d67cef63f644af9031be5049',
  },
}

/** Pinned official Cua Driver installer scripts, verified by SHA-256 before running. */
const DESKTOP_INSTALLERS: Readonly<Record<string, PinnedAsset>> = {
  darwin: {
    asset: 'install.sh',
    sha256: 'a103177e0df86d04d752bfa20c73f99a3e501906f1814c3127da84788539d9ba',
  },
  win32: {
    asset: 'install.ps1',
    sha256: '89ece4ed4dff3630129448a14bb06dec30adae7a2ffb3cc53b9971e7a195b097',
  },
}

/** The pinned release publishes no byte sizes, so the download is capped instead. */
const BROWSER_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const INSTALLER_MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024

const VERSION_TIMEOUT_MS = 10_000
const DOCTOR_TIMEOUT_MS = 30_000
const PERMISSIONS_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const INSTALL_TIMEOUT_MS = 15 * 60_000
const INSTALLER_RUN_TIMEOUT_MS = 15 * 60_000

const BROWSER_VERSION_PATTERN = /agent-browser\s+v?(\d+\.\d+\.\d+)/
const DESKTOP_VERSION_PATTERN = /cua-driver\s+v?(\d+\.\d+\.\d+)/

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

interface ComponentRuntime {
  source?: 'managed' | 'external'
  managed: boolean
  outdated: boolean
  executable?: string
  version?: string
  env: Record<string, string>
  mcpServer?: McpServer
}

interface CheckResult {
  snapshot: OperationComponentSnapshot
  runtime?: ComponentRuntime
}

type ProgressReport = { phase: string; receivedBytes?: number; totalBytes?: number }
type ProgressReporter = (progress: ProgressReport) => void

/**
 * Run one bounded child process. Never rejects: a spawn failure, a timeout and a
 * non-zero exit all come back as a result so callers can turn them into state.
 */
function run(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean }
          const code = typeof failure.code === 'number' ? failure.code : -1
          const reason = failure.killed
            ? `timed out after ${options.timeoutMs} ms`
            : stderr?.trim() || error.message || String(error)
          resolve({ code, stdout: stdout ?? '', stderr: reason })
          return
        }
        resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

/** Strip ANSI escapes, redact the home directory and keep the tail of one line. */
function sanitize(text: string): string {
  if (!text) return ''
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(homedir())
    .join('~')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-500)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function browserBinaryName(): string {
  return process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'
}

function desktopBinaryName(): string {
  return process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** The PATH key actually present in this environment (Windows casing varies). */
function pathKeyOf(env: NodeJS.ProcessEnv): string | undefined {
  if (typeof env.PATH === 'string') return 'PATH'
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') return key
    }
  }
  return undefined
}

/** Resolve one executable name against PATH, honouring Windows PATHEXT shims. */
function findExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const key = pathKeyOf(env)
  const raw = key ? env[key] : undefined
  if (!raw) return undefined
  const candidates =
    process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const directory of raw.split(delimiter)) {
    if (!directory) continue
    for (const candidate of candidates) {
      const full = join(directory, candidate)
      if (existsSync(full) && isFileSync(full)) return full
    }
  }
  return undefined
}

function parseBrowserVersion(output: string): string | undefined {
  return BROWSER_VERSION_PATTERN.exec(output)?.[1]
}

function parseDesktopVersion(output: string): string | undefined {
  return DESKTOP_VERSION_PATTERN.exec(output)?.[1]
}

/** Read accessibility/screen-recording booleans from `permissions status --json`. */
function parsePermissionFlags(
  output: string,
): { accessibility: boolean; screenRecording: boolean } | undefined {
  const parsed = parseJson(output)
  if (!isRecord(parsed)) return undefined
  const source = isRecord(parsed.permissions) ? parsed.permissions : parsed
  return {
    accessibility: source.accessibility === true,
    screenRecording: source.screen_recording === true,
  }
}

/** Collect the failing check messages from `agent-browser doctor --json`. */
function collectCheckFailures(parsed: unknown): string[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.checks)) return []
  const messages: string[] = []
  for (const entry of parsed.checks) {
    if (!isRecord(entry)) continue
    if (entry.status !== 'fail') continue
    if (typeof entry.message === 'string' && entry.message.trim()) messages.push(entry.message.trim())
  }
  return messages
}

interface DownloadOptions {
  maxBytes: number
  timeoutMs: number
  phase: string
  onProgress?: (progress: ProgressReport) => void
}

/**
 * Stream one bounded download to disk, hashing as it goes. Writes the file only
 * after the transfer completes inside the byte cap.
 */
async function download(
  url: string,
  destination: string,
  options: DownloadOptions,
): Promise<{ sha256: string; bytes: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`)
    const header = response.headers.get('content-length')
    const parsedTotal = header ? Number.parseInt(header, 10) : Number.NaN
    const totalBytes = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : undefined
    const body = response.body
    if (!body) throw new Error(`empty response body from ${url}`)
    const reader = body.getReader()
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (received > options.maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(
          `download exceeded the ${Math.floor(options.maxBytes / (1024 * 1024))} MiB limit`,
        )
      }
      hash.update(value)
      chunks.push(Buffer.from(value))
      options.onProgress?.({ phase: options.phase, receivedBytes: received, totalBytes })
    }
    await writeFile(destination, Buffer.concat(chunks))
    return { sha256: hash.digest('hex'), bytes: received }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`download timed out after ${Math.round(options.timeoutMs / 1000)} s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse and validate one `McpServer` JSON descriptor. Throws on any defect.
 * Kept byte-compatible with the removed exec-feature registry so an existing
 * `WRENYARD_COMPUTER_USE_MCP` value keeps working unchanged.
 */
export function parseMcpServer(raw: string, variable: string): McpServer {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `${variable} must be a JSON MCP server descriptor: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${variable} must be a JSON object describing one MCP server`)
  }
  const record = value as Record<string, unknown>
  const transport = record.transport
  if (transport === 'stdio') {
    const command = record.command
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error(`${variable} stdio MCP server requires a non-empty 'command'`)
    }
    const args = optionalStringArray(record.args, `${variable} 'args'`)
    const env = optionalStringRecord(record.env, `${variable} 'env'`)
    const cwd = optionalString(record.cwd, `${variable} 'cwd'`)
    return {
      transport: 'stdio',
      command: command.trim(),
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    }
  }
  if (transport === 'http') {
    const url = record.url
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error(`${variable} http MCP server requires a non-empty 'url'`)
    }
    const headers = optionalStringRecord(record.headers, `${variable} 'headers'`)
    return {
      transport: 'http',
      url: url.trim(),
      ...(headers ? { headers } : {}),
    }
  }
  throw new Error(`${variable} MCP server transport must be 'stdio' or 'http'`)
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
  return value as string[]
}

function optionalStringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object of strings`)
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') throw new Error(`${label} must be an object of strings`)
    record[key] = entry
  }
  return record
}

export class OperationComponents {
  readonly #componentsRoot: string
  readonly #browserDir: string
  readonly #settingsPath: string
  readonly #env: NodeJS.ProcessEnv
  readonly #log?: (message: string) => void

  readonly #snapshots = new Map<OperationComponentId, OperationComponentSnapshot>()
  readonly #runtime = new Map<OperationComponentId, ComponentRuntime>()
  readonly #jobs = new Map<OperationComponentId, Promise<void>>()
  #listed = false

  constructor(options: { stateRoot: string; env?: NodeJS.ProcessEnv; log?: (message: string) => void }) {
    this.#componentsRoot = join(options.stateRoot, 'components')
    this.#browserDir = join(this.#componentsRoot, 'agent-browser')
    this.#settingsPath = join(this.#componentsRoot, 'settings.json')
    this.#env = options.env ?? process.env
    this.#log = options.log
    if (this.#env.WRENYARD_BROWSER_USE_MCP?.trim()) {
      this.#log?.(
        'WRENYARD_BROWSER_USE_MCP is no longer used; browser operations use the agent-browser CLI managed in Settings > Operation components.',
      )
    }
  }

  /** Current snapshots, in component order. The first call runs both checks. */
  async list(): Promise<OperationComponentSnapshot[]> {
    if (!this.#listed) {
      this.#listed = true
      await Promise.all(OPERATION_COMPONENT_IDS.map((id) => this.#check(id)))
    }
    return OPERATION_COMPONENT_IDS.map((id) => this.#snapshots.get(id) ?? this.#base(id))
  }

  /** Run one user-triggered action and return the resulting snapshot. */
  async act(id: OperationComponentId, action: OperationComponentAction): Promise<OperationComponentSnapshot> {
    const current = this.#snapshots.get(id) ?? (await this.#check(id))
    if (!current.actions.includes(action)) {
      throw new Error(`Action '${action}' is not available for '${id}' in state '${current.state}'`)
    }
    if (this.#jobs.has(id)) throw new Error(`'${id}' is busy`)

    if (action === 'refresh') return this.#check(id)
    if (action === 'enable' || action === 'disable') return this.#setDisabled(id, action === 'disable')

    if (action === 'uninstall') {
      return this.#startJob(id, 'uninstalling', () => this.#jobBrowserUninstall())
    }
    if (action === 'authorize') {
      const executable = this.#runtime.get(id)?.executable
      if (!executable) throw new Error(`'${id}' has no executable to authorize`)
      return this.#startJob(id, 'authorizing', () => this.#jobDesktopAuthorize(executable))
    }
    if (id === 'browser') {
      return this.#startJob(id, 'downloading', (report) => this.#jobBrowserInstall(report))
    }
    return this.#startJob(id, 'downloading-installer', (report) => this.#jobDesktopInstall(report))
  }

  /** Freshly verify one component and return how to launch it. */
  async resolve(id: OperationComponentId): Promise<OperationComponentLaunch> {
    if (this.#jobs.has(id)) {
      throw new OperationComponentUnavailableError({
        ...(this.#snapshots.get(id) ?? this.#base(id)),
        state: 'installing',
      })
    }
    const { snapshot, runtime } = await this.#inspect(id)
    if (snapshot.state !== 'ready' || !runtime) throw new OperationComponentUnavailableError(snapshot)
    return {
      id,
      host: snapshot.host,
      executable: runtime.executable ?? snapshot.path ?? '',
      mcpServer: runtime.mcpServer,
      env: { ...runtime.env },
    }
  }

  #base(id: OperationComponentId): OperationComponentSnapshot {
    return {
      id,
      name: id === 'browser' ? 'agent-browser' : 'Cua Driver',
      state: 'not-installed',
      pinnedVersion: id === 'browser' ? BROWSER_VERSION : DESKTOP_VERSION,
      host: hostname(),
      platform: process.platform,
      arch: process.arch,
      hints: [],
      actions: ['refresh'],
    }
  }

  async #check(id: OperationComponentId): Promise<OperationComponentSnapshot> {
    return (await this.#inspect(id)).snapshot
  }

  /** Run one bounded check, cache the result and never throw. */
  async #inspect(id: OperationComponentId): Promise<CheckResult> {
    try {
      const result = id === 'browser' ? await this.#checkBrowser() : await this.#checkDesktop()
      this.#snapshots.set(id, result.snapshot)
      if (result.runtime) this.#runtime.set(id, result.runtime)
      else this.#runtime.delete(id)
      return result
    } catch (error) {
      const snapshot: OperationComponentSnapshot = {
        ...(this.#snapshots.get(id) ?? this.#base(id)),
        state: 'failed',
        progress: undefined,
        error: sanitize(errorMessage(error)) || 'component check failed',
        checkedAt: nowIso(),
        actions: ['refresh', 'disable'],
      }
      this.#snapshots.set(id, snapshot)
      this.#runtime.delete(id)
      return { snapshot }
    }
  }

  async #isDisabled(id: OperationComponentId): Promise<boolean> {
    const settings = await this.#readSettings()
    return settings.disabled.includes(id)
  }

  async #readSettings(): Promise<{ disabled: OperationComponentId[] }> {
    try {
      const parsed = parseJson(await readFile(this.#settingsPath, 'utf8'))
      if (!isRecord(parsed) || !Array.isArray(parsed.disabled)) return { disabled: [] }
      const disabled = parsed.disabled.filter(
        (entry): entry is OperationComponentId => entry === 'browser' || entry === 'desktop',
      )
      return { disabled }
    } catch {
      return { disabled: [] }
    }
  }

  async #setDisabled(id: OperationComponentId, disabled: boolean): Promise<OperationComponentSnapshot> {
    const settings = await this.#readSettings()
    const next = new Set(settings.disabled)
    if (disabled) next.add(id)
    else next.delete(id)
    await mkdir(this.#componentsRoot, { recursive: true })
    await writeFile(
      this.#settingsPath,
      `${JSON.stringify({ disabled: [...next] }, null, 2)}\n`,
      'utf8',
    )
    return this.#check(id)
  }

  #startJob(
    id: OperationComponentId,
    phase: string,
    work: (report: ProgressReporter) => Promise<void>,
  ): OperationComponentSnapshot {
    const installing: OperationComponentSnapshot = {
      ...(this.#snapshots.get(id) ?? this.#base(id)),
      state: 'installing',
      progress: { phase },
      error: undefined,
      checkedAt: nowIso(),
      actions: [],
    }
    this.#snapshots.set(id, installing)

    const job = (async () => {
      let failure: string | undefined
      try {
        await work((progress) => this.#updateProgress(id, progress))
      } catch (error) {
        failure = sanitize(errorMessage(error)) || 'operation component action failed'
      }
      this.#jobs.delete(id)
      if (failure) {
        const runtime = this.#runtime.get(id)
        const actions =
          id === 'browser'
            ? this.#browserActions('failed', runtime)
            : this.#desktopActions('failed', runtime)
        this.#snapshots.set(id, {
          ...(this.#snapshots.get(id) ?? this.#base(id)),
          state: 'failed',
          progress: undefined,
          error: failure,
          checkedAt: nowIso(),
          actions,
        })
        return
      }
      await this.#check(id)
    })()
    this.#jobs.set(id, job)
    void job.catch(() => undefined)
    return installing
  }

  #updateProgress(id: OperationComponentId, progress: ProgressReport): void {
    const current = this.#snapshots.get(id)
    if (!current || current.state !== 'installing') return
    this.#snapshots.set(id, {
      ...current,
      progress: {
        phase: progress.phase,
        ...(progress.receivedBytes !== undefined ? { receivedBytes: progress.receivedBytes } : {}),
        ...(progress.totalBytes !== undefined && Number.isFinite(progress.totalBytes)
          ? { totalBytes: progress.totalBytes }
          : {}),
      },
    })
  }

  // --- browser ------------------------------------------------------------

  #browserEnv(configPath: string): NodeJS.ProcessEnv {
    return { ...this.#env, AGENT_BROWSER_CONFIG: configPath }
  }

  async #ensureBrowserConfig(): Promise<string> {
    const configPath = join(this.#browserDir, 'config.json')
    await mkdir(this.#browserDir, { recursive: true })
    if (!(await isFile(configPath))) await writeFile(configPath, '{}\n', 'utf8')
    return configPath
  }

  async #readCurrentBrowser(): Promise<{ path: string; version: string; previous?: string } | undefined> {
    try {
      const parsed = parseJson(await readFile(join(this.#browserDir, 'current.json'), 'utf8'))
      if (!isRecord(parsed) || typeof parsed.version !== 'string' || !parsed.version) return undefined
      const path = join(this.#browserDir, parsed.version, browserBinaryName())
      if (!(await isFile(path))) return undefined
      return {
        path,
        version: parsed.version,
        ...(typeof parsed.previous === 'string' && parsed.previous ? { previous: parsed.previous } : {}),
      }
    } catch {
      return undefined
    }
  }

  async #hashMatches(path: string, expected: string): Promise<boolean> {
    try {
      return (await hashFile(path)) === expected
    } catch {
      return false
    }
  }

  async #pruneBrowserVersions(): Promise<void> {
    const current = await this.#readCurrentBrowser()
    if (!current) return
    const keep = new Set([current.version, ...(current.previous ? [current.previous] : [])])
    let entries: string[]
    try {
      entries = await readdir(this.#browserDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (keep.has(entry)) continue
      if (entry === 'current.json' || entry === 'config.json' || entry.includes('.partial-')) continue
      await rm(join(this.#browserDir, entry), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  #browserActions(
    state: OperationComponentState,
    runtime: ComponentRuntime | undefined,
  ): OperationComponentAction[] {
    const managed = runtime?.managed === true
    if (state === 'ready') {
      return [
        'refresh',
        'disable',
        ...(managed && runtime?.outdated ? (['update'] as const) : []),
        ...(managed ? (['uninstall'] as const) : []),
      ]
    }
    if (state === 'failed') {
      return ['repair', 'refresh', 'disable', ...(managed ? (['uninstall'] as const) : [])]
    }
    return ['refresh']
  }

  async #checkBrowser(): Promise<CheckResult> {
    const id: OperationComponentId = 'browser'
    const base = this.#base(id)
    const hints: OperationComponentHint[] = ['shared-browser-runtime']
    if (this.#env.WRENYARD_BROWSER_USE_MCP?.trim()) hints.push('legacy-browser-mcp')

    if (await this.#isDisabled(id)) {
      return { snapshot: { ...base, state: 'disabled', hints, checkedAt: nowIso(), actions: ['enable'] } }
    }

    const asset = BROWSER_ASSETS[`${process.platform}-${process.arch}`]
    const configPath = await this.#ensureBrowserConfig()
    const managed = await this.#readCurrentBrowser()
    let executable: string | undefined
    let source: 'managed' | 'external' | undefined
    if (managed) {
      executable = managed.path
      source = 'managed'
    } else {
      const found = findExecutable('agent-browser', this.#env)
      if (found) {
        executable = found
        source = 'external'
      }
    }

    if (!executable) {
      if (!asset) {
        return { snapshot: { ...base, state: 'unsupported', hints, checkedAt: nowIso(), actions: ['refresh'] } }
      }
      return {
        snapshot: { ...base, state: 'not-installed', hints, checkedAt: nowIso(), actions: ['install', 'refresh', 'disable'] },
      }
    }

    const runtime: ComponentRuntime = {
      source,
      managed: source === 'managed',
      outdated: false,
      executable,
      env: { AGENT_BROWSER_CONFIG: configPath },
    }

    const versionRun = await run(executable, ['--version'], {
      timeoutMs: VERSION_TIMEOUT_MS,
      env: this.#browserEnv(configPath),
    })
    const version = parseBrowserVersion(versionRun.stdout)
    if (!version) {
      return {
        snapshot: {
          ...base,
          state: 'failed',
          source,
          path: executable,
          hints,
          checkedAt: nowIso(),
          error:
            sanitize(versionRun.stderr || versionRun.stdout) || 'agent-browser --version did not report a version',
          actions: this.#browserActions('failed', runtime),
        },
        runtime,
      }
    }
    runtime.version = version
    runtime.outdated = version !== BROWSER_VERSION

    const doctor = await run(executable, ['doctor', '--offline', '--quick', '--json'], {
      timeoutMs: DOCTOR_TIMEOUT_MS,
      env: this.#browserEnv(configPath),
    })
    const parsed = parseJson(doctor.stdout)
    if (isRecord(parsed) && parsed.success === true) {
      return {
        snapshot: {
          ...base,
          state: 'ready',
          source,
          version,
          path: executable,
          hints,
          checkedAt: nowIso(),
          actions: this.#browserActions('ready', runtime),
        },
        runtime,
      }
    }

    const failures = collectCheckFailures(parsed)
    const error = failures.length
      ? failures.slice(0, 3).join('; ')
      : sanitize(doctor.stderr || doctor.stdout) || `agent-browser doctor exited with code ${doctor.code}`
    return {
      snapshot: {
        ...base,
        state: 'failed',
        source,
        version,
        path: executable,
        hints,
        checkedAt: nowIso(),
        error,
        actions: this.#browserActions('failed', runtime),
      },
      runtime,
    }
  }

  async #jobBrowserInstall(report: ProgressReporter): Promise<void> {
    const asset = BROWSER_ASSETS[`${process.platform}-${process.arch}`]
    if (!asset) {
      throw new Error(`agent-browser ${BROWSER_VERSION} has no build for ${process.platform}-${process.arch}`)
    }
    const configPath = await this.#ensureBrowserConfig()
    const runtime = this.#runtime.get('browser')
    const external = runtime?.source === 'external' && Boolean(runtime.executable)
    let binary = external ? runtime!.executable! : join(this.#browserDir, BROWSER_VERSION, browserBinaryName())

    if (!external) {
      const target = binary
      const current = await this.#readCurrentBrowser()
      if (!(await this.#hashMatches(target, asset.sha256))) {
        await mkdir(join(this.#browserDir, BROWSER_VERSION), { recursive: true })
        const partial = join(this.#browserDir, `${BROWSER_VERSION}.partial-${randomBytes(6).toString('hex')}`)
        try {
          const { sha256 } = await download(`${BROWSER_RELEASE_BASE}/${asset.asset}`, partial, {
            maxBytes: BROWSER_MAX_DOWNLOAD_BYTES,
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            phase: 'downloading',
            onProgress: (progress) => report(progress),
          })
          report({ phase: 'verifying' })
          if (sha256 !== asset.sha256) {
            throw new Error(
              `agent-browser ${BROWSER_VERSION} checksum mismatch: expected ${asset.sha256}, got ${sha256}`,
            )
          }
          if (process.platform !== 'win32') await chmod(partial, 0o755)
          const verify = await run(partial, ['--version'], {
            timeoutMs: VERSION_TIMEOUT_MS,
            env: this.#browserEnv(configPath),
          })
          const reported = parseBrowserVersion(verify.stdout)
          if (reported !== BROWSER_VERSION) {
            throw new Error(
              `downloaded agent-browser reported version ${reported ?? 'unknown'}, expected ${BROWSER_VERSION}`,
            )
          }
          await rm(target, { force: true })
          await rename(partial, target)
        } finally {
          await rm(partial, { force: true }).catch(() => undefined)
        }
      }
      const previous = current && current.version !== BROWSER_VERSION ? current.version : undefined
      await writeFile(
        join(this.#browserDir, 'current.json'),
        `${JSON.stringify({ version: BROWSER_VERSION, ...(previous ? { previous } : {}) }, null, 2)}\n`,
        'utf8',
      )
      await this.#pruneBrowserVersions()
      binary = target
    }

    report({ phase: 'installing-browser-runtime' })
    const install = await run(binary, ['install'], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: this.#browserEnv(configPath),
    })
    if (install.code !== 0) {
      throw new Error(
        sanitize(install.stderr || install.stdout) || `agent-browser install exited with code ${install.code}`,
      )
    }
  }

  async #jobBrowserUninstall(): Promise<void> {
    // Only the managed browser binary directory; the shared browser runtime and
    // every other agent-browser installation are left untouched.
    await rm(this.#browserDir, { recursive: true, force: true })
  }

  // --- desktop ------------------------------------------------------------

  async #readDesktopMarker(): Promise<{ version: string; installedAt: string } | undefined> {
    try {
      const parsed = parseJson(
        await readFile(join(this.#componentsRoot, 'cua-driver', 'installed.json'), 'utf8'),
      )
      if (!isRecord(parsed) || typeof parsed.version !== 'string') return undefined
      return {
        version: parsed.version,
        installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
      }
    } catch {
      return undefined
    }
  }

  async #findDesktopBinary(): Promise<string | undefined> {
    const found = findExecutable('cua-driver', this.#env)
    if (found) return found
    if (process.platform === 'darwin') {
      const candidate = join(homedir(), '.local', 'bin', desktopBinaryName())
      return (await isFile(candidate)) ? candidate : undefined
    }
    if (process.platform === 'win32') {
      const base = this.#env.LOCALAPPDATA
      if (!base) return undefined
      const candidate = join(base, 'Programs', 'Cua', 'cua-driver', 'bin', desktopBinaryName())
      return (await isFile(candidate)) ? candidate : undefined
    }
    return undefined
  }

  #desktopActions(
    state: OperationComponentState,
    runtime: ComponentRuntime | undefined,
  ): OperationComponentAction[] {
    const managed = runtime?.managed === true
    if (state === 'ready') {
      return ['refresh', 'disable', ...(managed && runtime?.outdated ? (['update'] as const) : [])]
    }
    if (state === 'failed') {
      return ['refresh', 'disable', ...(managed ? (['repair'] as const) : [])]
    }
    return ['refresh']
  }

  async #checkDesktop(): Promise<CheckResult> {
    const id: OperationComponentId = 'desktop'
    const base = this.#base(id)

    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return { snapshot: { ...base, state: 'unsupported', checkedAt: nowIso(), actions: ['refresh'] } }
    }
    if (await this.#isDisabled(id)) {
      return { snapshot: { ...base, state: 'disabled', checkedAt: nowIso(), actions: ['enable'] } }
    }

    const externalRaw = this.#env.WRENYARD_COMPUTER_USE_MCP?.trim()
    if (externalRaw) {
      try {
        const mcpServer = parseMcpServer(externalRaw, 'WRENYARD_COMPUTER_USE_MCP')
        const path = mcpServer.transport === 'stdio' ? mcpServer.command : mcpServer.url
        return {
          snapshot: {
            ...base,
            state: 'ready',
            source: 'external',
            path,
            hints: ['external-mcp'],
            checkedAt: nowIso(),
            actions: ['refresh', 'disable'],
          },
          runtime: { source: 'external', managed: false, outdated: false, executable: path, env: {}, mcpServer },
        }
      } catch (error) {
        return {
          snapshot: {
            ...base,
            state: 'failed',
            hints: ['external-mcp'],
            error: sanitize(errorMessage(error)),
            checkedAt: nowIso(),
            actions: ['refresh'],
          },
        }
      }
    }

    const marker = await this.#readDesktopMarker()
    const binary = await this.#findDesktopBinary()
    if (!binary) {
      return {
        snapshot: { ...base, state: 'not-installed', checkedAt: nowIso(), actions: ['install', 'refresh', 'disable'] },
      }
    }

    const source: 'managed' | 'external' = marker ? 'managed' : 'external'
    const hints: OperationComponentHint[] = source === 'external' ? ['existing-installation'] : []
    const runtime: ComponentRuntime = {
      source,
      managed: source === 'managed',
      outdated: false,
      executable: binary,
      env: {},
    }

    const versionRun = await run(binary, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS })
    const version = parseDesktopVersion(versionRun.stdout)
    if (!version) {
      return {
        snapshot: {
          ...base,
          state: 'failed',
          source,
          path: binary,
          hints,
          checkedAt: nowIso(),
          error: sanitize(versionRun.stderr || versionRun.stdout) || 'cua-driver --version did not report a version',
          actions: this.#desktopActions('failed', runtime),
        },
        runtime,
      }
    }
    runtime.version = version
    runtime.outdated = version !== DESKTOP_VERSION
    runtime.mcpServer = { transport: 'stdio', command: binary, args: ['mcp'] }

    if (process.platform === 'darwin') {
      const permissions = await run(binary, ['permissions', 'status', '--json'], {
        timeoutMs: PERMISSIONS_TIMEOUT_MS,
      })
      const flags = parsePermissionFlags(permissions.stdout)
      if (!flags) {
        return {
          snapshot: {
            ...base,
            state: 'failed',
            source,
            version,
            path: binary,
            hints,
            checkedAt: nowIso(),
            error:
              sanitize(permissions.stderr || permissions.stdout) ||
              'cua-driver permissions status did not return JSON',
            actions: this.#desktopActions('failed', runtime),
          },
          runtime,
        }
      }
      const authHints = [...hints]
      if (!flags.accessibility) authHints.push('missing-accessibility')
      if (!flags.screenRecording) authHints.push('missing-screen-recording')
      if (flags.accessibility && flags.screenRecording) {
        return {
          snapshot: {
            ...base,
            state: 'ready',
            source,
            version,
            path: binary,
            hints: authHints,
            checkedAt: nowIso(),
            actions: this.#desktopActions('ready', runtime),
          },
          runtime,
        }
      }
      return {
        snapshot: {
          ...base,
          state: 'needs-authorization',
          source,
          version,
          path: binary,
          hints: authHints,
          checkedAt: nowIso(),
          actions: ['authorize', 'refresh', 'disable'],
        },
        runtime,
      }
    }

    const doctor = await run(binary, ['doctor', '--json'], { timeoutMs: DOCTOR_TIMEOUT_MS })
    if (doctor.code === 0) {
      return {
        snapshot: {
          ...base,
          state: 'ready',
          source,
          version,
          path: binary,
          hints,
          checkedAt: nowIso(),
          actions: this.#desktopActions('ready', runtime),
        },
        runtime,
      }
    }
    return {
      snapshot: {
        ...base,
        state: 'failed',
        source,
        version,
        path: binary,
        hints,
        checkedAt: nowIso(),
        error: sanitize(doctor.stderr || doctor.stdout) || `cua-driver doctor exited with code ${doctor.code}`,
        actions: this.#desktopActions('failed', runtime),
      },
      runtime,
    }
  }

  async #jobDesktopInstall(report: ProgressReporter): Promise<void> {
    const installer = DESKTOP_INSTALLERS[process.platform]
    if (!installer) throw new Error(`Cua Driver ${DESKTOP_VERSION} has no installer for ${process.platform}`)

    const marker = await this.#readDesktopMarker()
    const existing = await this.#findDesktopBinary()
    if (existing && !marker) {
      throw new Error(
        'An existing Cua Driver installation was found; Wrenyard checks it but never replaces or updates it.',
      )
    }

    const directory = join(this.#componentsRoot, 'cua-driver')
    await mkdir(directory, { recursive: true })
    const file = join(directory, installer.asset)
    try {
      report({ phase: 'downloading-installer' })
      const { sha256 } = await download(`${DESKTOP_RELEASE_BASE}/${installer.asset}`, file, {
        maxBytes: INSTALLER_MAX_DOWNLOAD_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        phase: 'downloading-installer',
        onProgress: (progress) => report(progress),
      })
      if (sha256 !== installer.sha256) {
        throw new Error(`Cua Driver installer checksum mismatch: expected ${installer.sha256}, got ${sha256}`)
      }
      report({ phase: 'running-installer' })
      const result =
        process.platform === 'darwin'
          ? await run('/bin/bash', [file, '--no-modify-path'], {
              timeoutMs: INSTALLER_RUN_TIMEOUT_MS,
              env: {
                ...this.#env,
                CUA_DRIVER_RS_VERSION: DESKTOP_VERSION,
                CUA_DRIVER_NO_MODIFY_PATH: '1',
              },
            })
          : await run(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                file,
                '-NoPathUpdate',
                '-Release',
                DESKTOP_VERSION,
              ],
              {
                timeoutMs: INSTALLER_RUN_TIMEOUT_MS,
                env: { ...this.#env, CUA_DRIVER_RS_VERSION: DESKTOP_VERSION },
              },
            )
      if (result.code !== 0) {
        throw new Error(
          sanitize(result.stderr || result.stdout) || `Cua Driver installer exited with code ${result.code}`,
        )
      }
    } finally {
      await rm(file, { force: true }).catch(() => undefined)
    }

    await writeFile(
      join(directory, 'installed.json'),
      `${JSON.stringify({ version: DESKTOP_VERSION, installedAt: nowIso() }, null, 2)}\n`,
      'utf8',
    )
  }

  async #jobDesktopAuthorize(binary: string): Promise<void> {
    // Launch through LaunchServices so the signed app identity (not this daemon)
    // becomes the TCC subject, then ask the driver to raise the OS prompts.
    await run('open', ['-n', '-g', '-a', 'CuaDriver', '--args', 'serve'], { timeoutMs: 15_000 })
    await delay(2_000)
    await run(binary, ['permissions', 'grant'], { timeoutMs: 120_000 })
  }
}
