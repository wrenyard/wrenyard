/**
 * Bot definitions.
 *
 * One bot is one directory named by its id, in one of two roots:
 *
 * - `<workspace>/bots/<id>/` for a bot that syncs with the workspace;
 * - `<config root>/bot-agents/<id>/` for a device-only bot.
 *
 * Each directory holds `bot.json` (the user-only switches), `identity.md` (the
 * name, icon, description and persona the bot itself may edit) and a
 * `memory/` directory.
 *
 * What a bot does on this device are its routines, one file each in
 * `<config root>/bot-agents/<id>/routines/` (see routine-files.mts). They are never
 * synced. A device directory without `bot.json` is not a bot; for a workspace
 * bot it holds only `routines/`.
 *
 * Loading never throws: an unreadable or invalid part disables only that bot
 * and keeps the error visible.
 */

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { RoutineDeliver } from '../../../protocol/methods/routine.mts'
import { readRoutines, type RoutineDefinition } from './routine-files.mts'

/** One tool switch a bot can turn on. */
export type AgentToolName = 'session' | 'todo' | 'message' | 'memory' | 'routine' | 'workspace'

/** Every known tool switch. */
export const AGENT_TOOL_NAMES: readonly AgentToolName[] = ['session', 'todo', 'message', 'memory', 'routine', 'workspace']

/** Where a bot definition lives. */
export type AgentBotLocation = 'workspace' | 'device'

/**
 * Retired top-level keys that older bot files may still carry. They are
 * dropped before validation so those files keep loading; the values have no
 * effect any more.
 */
const LEGACY_IGNORED_KEYS: readonly string[] = [['deny', 'Models'].join('')]

/** The two roots a bot may be loaded from. */
export interface BotAgentRoots {
  /** `<workspace>/bots`. */
  workspace: string
  /** `<config root>/bot-agents`. */
  device: string
}

/** The only top-level keys `bot.json` may declare. */
const CONFIG_KEYS = new Set(['primary', 'enabled', 'tools'])

/** A bot id: a directory name, lowercase and path safe. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** YAML front matter: `---` fenced metadata, then the body. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u

/** `bot.json` as validated: only the user's own switches. */
export interface BotAgentConfig {
  /** Marks the single primary bot; the first in id order wins. */
  primary: boolean
  /** False puts the bot out of service without deleting its directory. */
  enabled: boolean
  /** The tool switches that are on, sorted. Empty means text replies only. */
  tools: AgentToolName[]
}

/** `identity.md` as validated: what the bot may change about itself. */
export interface BotAgentIdentity {
  /** Display name; required. */
  name: string
  /** Optional icon of at most two grapheme clusters. */
  icon?: string
  /** Optional one-line description used by the bot roster. */
  description?: string
  /** The role text, replacing the old instructions field. */
  body: string
}

/**
 * Per-part change metadata. The kernel polls both roots every five seconds and
 * compares these values: a `bot.json` edit, an `identity.md` edit or a memory
 * addition/removal all change the aggregate `signature`.
 */
export interface BotAgentChangeSet {
  config: string
  identity: string
  memory: string
  routines: string
}

/**
 * One definition as loaded. `config` and `identity` are present only when the
 * corresponding part validated; otherwise `error` explains why and the bot is
 * disabled. `signature` changes when `bot.json`, `identity.md` or the set of
 * memory files changes, so a caller can poll the roots cheaply.
 */
export interface BotAgentEntry {
  id: string
  location: AgentBotLocation
  /** The bot definition directory. */
  directory: string
  configPath: string
  identityPath: string
  memoryDir: string
  /** True only for the effective primary bot. */
  primary: boolean
  /** Non-fatal findings that must stay visible, such as a primary conflict. */
  warnings: string[]
  change: BotAgentChangeSet
  configText: string
  identityText: string
  config?: BotAgentConfig
  identity?: BotAgentIdentity
  /** `<config root>/bot-agents/<id>/routines`: this device's routine files of the bot. */
  routinesDir: string
  /**
   * The bot's routines on this device; undefined while its routines directory
   * does not exist yet (the scheduler then exports the routines it holds).
   */
  routines?: RoutineDefinition[]
  /**
   * Config-declared routines from a flat `<id>.json` migrated in this load;
   * the kernel imports them into the scheduler once before the bot runs.
   */
  configDeclaredRoutines?: ConfigDeclaredRoutine[]
  error?: string
  signature: string
}

/** One named routine from a retired flat device bot JSON file. */
export interface ConfigDeclaredRoutine {
  name: string
  prompt: string
  intervalMinutes: number
  deliver: RoutineDeliver
}

/** One file of a bot's memory directory. */
export interface AgentMemoryFile {
  name: string
  size: number
  updatedAt: string
}

/** One load of both roots. `warnings` carries the skipped directory names. */
export interface BotAgentScan {
  bots: BotAgentEntry[]
  warnings: string[]
}

/** One file's change signature. */
interface FileSignature {
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
}

const EMPTY_SIGNATURE: FileSignature = { mtimeMs: 0, ctimeMs: 0, size: 0, ino: 0 }

function signatureOf(info: Stats): FileSignature {
  return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, ino: info.ino }
}

function signatureText(signature: FileSignature): string {
  return `${signature.mtimeMs}:${signature.ctimeMs}:${signature.size}:${signature.ino}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True when `id` is a legal bot directory name. */
export function isBotId(id: string): boolean {
  return ID_PATTERN.test(id)
}

/**
 * Strict directory containment: `path` is `root` itself or below it, with no
 * `..` escape and no absolute replacement.
 */
export function isContained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve `path` and refuse it unless its real target stays inside `root`.
 * A symlink that points outside the root therefore fails every read and write.
 */
export async function assertRealInside(root: string, path: string): Promise<void> {
  const realRoot = await realpath(root)
  const realPath = await realpath(path)
  if (!isContained(realRoot, realPath)) {
    throw new Error(`path escapes its bot directory: ${path}`)
  }
}

/** A regular file that is not a symlink and stays inside `root`. */
async function readDefinitionFile(root: string, path: string, label: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile()) throw new Error(`${label} is a symlink or not a regular file`)
  await assertRealInside(root, path)
  return readFile(path, 'utf-8')
}

/** Read one `tools` map into the sorted list of enabled tool names. */
function validateTools(value: unknown): AgentToolName[] {
  if (value === undefined) return []
  if (!isPlainObject(value)) throw new Error('tools must be an object')
  const enabled: AgentToolName[] = []
  for (const [key, setting] of Object.entries(value)) {
    if (!(AGENT_TOOL_NAMES as readonly string[]).includes(key)) throw new Error(`unknown tool: ${key}`)
    // Absent or false means off; true or an options object means on.
    if (setting === false) continue
    if (setting !== true && !isPlainObject(setting)) {
      throw new Error(`tool ${key} must be true, false or an options object`)
    }
    enabled.push(key as AgentToolName)
  }
  return enabled.sort()
}

/** Validate one `bot.json` body. Unknown keys, including the old fields, fail. */
export function validateConfig(text: string): BotAgentConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${errorText(error)}`)
  }
  if (!isPlainObject(parsed)) throw new Error('bot.json must be a JSON object')
  for (const key of LEGACY_IGNORED_KEYS) delete parsed[key]
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`unknown field: ${key}`)
  }
  const primary = parsed.primary
  if (primary !== undefined && typeof primary !== 'boolean') throw new Error('primary must be a boolean')
  const enabled = parsed.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
  return {
    primary: primary ?? false,
    enabled: enabled ?? true,
    tools: validateTools(parsed.tools),
  }
}

/** Count user-perceived characters, so an icon is one or two graphemes. */
function graphemeCount(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let count = 0
  for (const _ of segmenter.segment(value)) count += 1
  return count
}

/** Validate one `identity.md`: required name, optional icon/description, body role. */
export function parseIdentity(text: string): BotAgentIdentity {
  const match = FRONTMATTER.exec(text)
  if (match === null) throw new Error('identity.md has no YAML front matter')
  let data: unknown
  try {
    data = parseYaml(match[1]!)
  } catch (error) {
    throw new Error(`identity.md has invalid YAML: ${errorText(error)}`)
  }
  if (!isPlainObject(data)) throw new Error('identity.md front matter must be a mapping')
  const name = data.name
  if (typeof name !== 'string' || name.trim() === '' || /[\r\n\0]/u.test(name)) {
    throw new Error('identity.md needs a one-line name')
  }
  let icon: string | undefined
  if (data.icon !== undefined) {
    if (typeof data.icon !== 'string' || data.icon.trim() === '') {
      throw new Error('identity.md icon must be a nonempty string')
    }
    if (graphemeCount(data.icon.trim()) > 2) {
      throw new Error('identity.md icon must be at most two grapheme clusters')
    }
    icon = data.icon.trim()
  }
  let description: string | undefined
  if (data.description !== undefined) {
    if (typeof data.description !== 'string' || data.description.trim() === '' || /[\r\n\0]/u.test(data.description)) {
      throw new Error('identity.md description must be one nonempty line')
    }
    description = data.description.trim()
  }
  return {
    name: name.trim(),
    ...(icon === undefined ? {} : { icon }),
    ...(description === undefined ? {} : { description }),
    body: match[2]!.trim(),
  }
}

/** Render one identity with the same field set and body layout the loader reads. */
export function formatIdentity(identity: BotAgentIdentity): string {
  const data: Record<string, unknown> = { name: identity.name }
  if (identity.icon !== undefined) data.icon = identity.icon
  if (identity.description !== undefined) data.description = identity.description
  return `---\n${stringifyYaml(data).trimEnd()}\n---\n\n${identity.body.trim()}\n`
}

/** Read the memory directory listing. A missing directory is empty. */
export async function listMemoryFiles(directory: string): Promise<AgentMemoryFile[]> {
  const memoryDir = join(directory, 'memory')
  let info: Stats
  try {
    info = await lstat(memoryDir)
  } catch {
    return []
  }
  if (!info.isDirectory()) throw new Error('memory is a symlink or not a directory')
  await assertRealInside(directory, memoryDir)
  const files: AgentMemoryFile[] = []
  for (const name of (await readdir(memoryDir)).sort()) {
    if (!name.endsWith('.md')) continue
    const path = join(memoryDir, name)
    const file = await lstat(path)
    if (!file.isFile()) continue
    files.push({ name, size: file.size, updatedAt: new Date(file.mtimeMs).toISOString() })
  }
  return files
}

/** The names of the memory files, as change-detection material. */
async function memorySignature(directory: string): Promise<string> {
  try {
    const files = await listMemoryFiles(directory)
    return files.map(file => `${file.name}:${file.size}:${file.updatedAt}`).join(',')
  } catch (error) {
    return `error:${errorText(error)}`
  }
}

/** Read one bot definition directory. Every failure becomes `error`. */
async function readDefinition(
  root: string,
  id: string,
  location: AgentBotLocation,
  previous: BotAgentEntry | undefined,
  deviceRoot: string,
): Promise<BotAgentEntry> {
  const directory = join(root, id)
  const configPath = join(directory, 'bot.json')
  const identityPath = join(directory, 'identity.md')
  const memoryDir = join(directory, 'memory')
  const base = {
    id,
    location,
    directory,
    configPath,
    identityPath,
    memoryDir,
    routinesDir: join(deviceRoot, id, 'routines'),
    primary: false,
    warnings: [] as string[],
    change: { config: 'missing', identity: 'missing', memory: '', routines: 'missing' } satisfies BotAgentChangeSet,
  }
  try {
    const info = await lstat(directory)
    if (!info.isDirectory()) throw new Error('bot directory is a symlink or not a directory')
    await assertRealInside(root, directory)
  } catch (error) {
    const entry: BotAgentEntry = {
      ...base,
      configText: '',
      identityText: '',
      error: errorText(error),
      signature: `missing:${id}`,
    }
    return entry
  }

  let configSignature = 'missing'
  let identitySignature = 'missing'
  let config: BotAgentConfig | undefined
  let identity: BotAgentIdentity | undefined
  let configText = ''
  let identityText = ''
  const errors: string[] = []

  try {
    const info = await lstat(configPath)
    configSignature = signatureText(signatureOf(info))
    configText = await readDefinitionFile(directory, configPath, 'bot.json')
    config = validateConfig(configText)
  } catch (error) {
    errors.push(`bot.json: ${errorText(error)}`)
  }

  try {
    const info = await lstat(identityPath)
    identitySignature = signatureText(signatureOf(info))
    identityText = await readDefinitionFile(directory, identityPath, 'identity.md')
    identity = parseIdentity(identityText)
  } catch (error) {
    errors.push(`identity.md: ${errorText(error)}`)
  }

  // Routines are optional and never disable the bot: an invalid file is a warning.
  const read = await readRoutines(base.routinesDir)
  const routinesSignature = read === undefined ? 'missing' : read.signature

  const change: BotAgentChangeSet = {
    config: configSignature,
    identity: identitySignature,
    memory: await memorySignature(directory),
    routines: routinesSignature,
  }
  const signature = createHash('sha1')
    .update(`${change.config}|${change.identity}|${change.memory}|${change.routines}`)
    .digest('hex')
  if (previous !== undefined && previous.signature === signature) return previous

  return {
    ...base,
    warnings: read?.errors ?? [],
    change,
    configText,
    identityText,
    ...(config === undefined ? {} : { config }),
    ...(identity === undefined ? {} : { identity }),
    ...(read === undefined ? {} : { routines: read.routines }),
    ...(errors.length === 0 ? {} : { error: errors.join('; ') }),
    signature,
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

interface ScannedDirectory {
  id: string
  directory: string
  location: AgentBotLocation
}

/** List the legal bot directories of one root; illegal names are warnings. */
const LEGACY_FLAT_KEYS = new Set(['id', 'name', 'enabled', 'instructions', 'tools', 'routines'])
const LEGACY_RETIRED_KEYS = new Set(['denyModels'])
const LEGACY_DELIVER_PATTERN = /^(none|bot:[a-z0-9][a-z0-9-]{0,31})$/
const LEGACY_MAX_PROMPT_LENGTH = 4_000
const LEGACY_MAX_INTERVAL_MINUTES = 10_080

interface LegacyFlatBot {
  name: string
  enabled: boolean
  instructions: string
  tools: Record<string, true>
  routines: ConfigDeclaredRoutine[]
}

function validateLegacyRoutine(value: unknown, names: Set<string>): ConfigDeclaredRoutine {
  if (!isPlainObject(value)) throw new Error('routine must be an object')
  const name = value.name
  if (typeof name !== 'string' || name.trim() === '') throw new Error('routine name must be a nonempty string')
  if (names.has(name)) throw new Error(`duplicate routine name: ${name}`)
  names.add(name)
  const prompt = value.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error(`routine ${name}: prompt must be a nonempty string`)
  }
  if (prompt.length > LEGACY_MAX_PROMPT_LENGTH) {
    throw new Error(`routine ${name}: prompt must be at most ${LEGACY_MAX_PROMPT_LENGTH} characters`)
  }
  const intervalMinutes = value.intervalMinutes
  if (typeof intervalMinutes !== 'number' || !Number.isInteger(intervalMinutes)
    || intervalMinutes < 1 || intervalMinutes > LEGACY_MAX_INTERVAL_MINUTES) {
    throw new Error(`routine ${name}: intervalMinutes must be an integer between 1 and ${LEGACY_MAX_INTERVAL_MINUTES}`)
  }
  const deliver = value.deliver
  if (deliver !== undefined && (typeof deliver !== 'string' || !LEGACY_DELIVER_PATTERN.test(deliver))) {
    throw new Error(`routine ${name}: deliver must match ${LEGACY_DELIVER_PATTERN}`)
  }
  return { name, prompt, intervalMinutes, deliver: (deliver ?? 'none') as RoutineDeliver }
}

function parseLegacyFlatBot(text: string, id: string): LegacyFlatBot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${errorText(error)}`)
  }
  if (!isPlainObject(parsed)) throw new Error('bot file must be a JSON object')
  for (const key of LEGACY_RETIRED_KEYS) delete parsed[key]
  for (const key of Object.keys(parsed)) {
    if (!LEGACY_FLAT_KEYS.has(key)) throw new Error(`unknown field: ${key}`)
  }
  const declaredId = parsed.id
  if (declaredId !== undefined && declaredId !== id) {
    throw new Error(`declared id ${String(declaredId)} does not match file name ${id}`)
  }
  const name = parsed.name
  if (name !== undefined && typeof name !== 'string') throw new Error('name must be a string')
  const enabled = parsed.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const instructions = parsed.instructions
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('instructions must be a string')
  }
  const toolNames = validateTools(parsed.tools ?? {})
  const routines = parsed.routines
  if (routines !== undefined && !Array.isArray(routines)) throw new Error('routines must be an array')
  const names = new Set<string>()
  return {
    name: name ?? id,
    enabled: enabled ?? true,
    instructions: instructions ?? '',
    tools: Object.fromEntries(toolNames.map(tool => [tool, true])),
    routines: (routines ?? []).map(routine => validateLegacyRoutine(routine, names)),
  }
}

/**
 * Upgrade flat `<id>.json` device bots into `<id>/` directories. Never clobbers
 * an existing directory; failures and skips become visible warnings.
 */
async function migrateFlatDeviceBots(
  deviceRoot: string,
  warnings: string[],
): Promise<Map<string, ConfigDeclaredRoutine[]>> {
  const imported = new Map<string, ConfigDeclaredRoutine[]>()
  const entries = await readdir(deviceRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.json.migrated')) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (!isBotId(id)) {
      warnings.push(`ignored legacy bot file "${entry.name}": id must match ${ID_PATTERN.source}`)
      continue
    }
    const filePath = join(deviceRoot, entry.name)
    let bot: LegacyFlatBot
    try {
      bot = parseLegacyFlatBot(await readFile(filePath, 'utf-8'), id)
    } catch (error) {
      warnings.push(`legacy bot file "${entry.name}" left in place: ${errorText(error)}`)
      continue
    }
    const directory = join(deviceRoot, id)
    if (await exists(directory)) {
      warnings.push(`legacy bot file "${entry.name}" skipped: directory "${id}" already exists`)
      continue
    }
    try {
      await mkdir(directory)
      await writeFile(
        join(directory, 'bot.json'),
        `${JSON.stringify({ enabled: bot.enabled, tools: bot.tools }, null, 2)}\n`,
        { encoding: 'utf-8', mode: 0o600 },
      )
      await writeFile(
        join(directory, 'identity.md'),
        formatIdentity({ name: bot.name, body: bot.instructions }),
        'utf-8',
      )
      await mkdir(join(directory, 'memory'))
      await rename(filePath, `${filePath}.migrated`)
    } catch (error) {
      warnings.push(`legacy bot file "${entry.name}" left in place: ${errorText(error)}`)
      await rm(directory, { recursive: true, force: true }).catch(() => {})
      continue
    }
    imported.set(id, bot.routines)
  }
  return imported
}

async function scanRoot(
  root: string,
  location: AgentBotLocation,
  warnings: string[],
): Promise<ScannedDirectory[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found: ScannedDirectory[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    if (!ID_PATTERN.test(entry.name)) {
      warnings.push(`ignored bot directory "${entry.name}": id must match ${ID_PATTERN.source}`)
      continue
    }
    found.push({ id: entry.name, directory: join(root, entry.name), location })
  }
  return found
}

/**
 * Load both roots. A workspace bot wins an id clash; the device duplicate stays
 * visible with a clash error and its switches off. The effective primary is the
 * first valid bot in id order that claims it; nothing is promoted automatically.
 */
export async function loadBotAgents(
  roots: BotAgentRoots,
  previous: readonly BotAgentEntry[] = [],
): Promise<BotAgentScan> {
  const warnings: string[] = []
  const workspace = await scanRoot(roots.workspace, 'workspace', warnings)
  const migratedRoutines = await migrateFlatDeviceBots(roots.device, warnings)
  const device = await scanRoot(roots.device, 'device', warnings)
  const cached = new Map(previous.map(entry => [`${entry.location}\n${entry.id}`, entry]))

  const loaded: BotAgentEntry[] = []
  const workspaceIds = new Set(workspace.map(item => item.id))
  for (const item of workspace) {
    loaded.push(await readDefinition(
      roots.workspace, item.id, 'workspace', cached.get(`workspace\n${item.id}`), roots.device,
    ))
  }
  for (const item of device) {
    // A device directory without bot.json is not a bot: it carries a workspace
    // bot's routines on this device, or belongs to something else in the root.
    if (!(await exists(join(item.directory, 'bot.json')))) continue
    let entry = await readDefinition(roots.device, item.id, 'device', cached.get(`device\n${item.id}`), roots.device)
    const declared = migratedRoutines.get(item.id)
    if (declared !== undefined && declared.length > 0) {
      entry = { ...entry, configDeclaredRoutines: declared }
    } else {
      const { configDeclaredRoutines: _drop, ...rest } = entry
      entry = rest
    }
    if (workspaceIds.has(item.id)) {
      warnings.push(`bot "${item.id}" exists in both roots; the workspace bot is used and the device bot is disabled`)
      loaded.push({
        ...entry,
        ...(entry.config === undefined ? {} : { config: { ...entry.config, enabled: false } }),
        primary: false,
        error: `id "${item.id}" clashes with the workspace bot; the device-only bot is disabled`,
        warnings: [...entry.warnings, 'disabled: id clash with the workspace bot'],
        signature: `${entry.signature}:clash`,
      })
      continue
    }
    loaded.push(entry)
  }

  // The effective primary is the first valid claimant by id, never a survivor
  // of a removed primary. Warnings are recomputed on every poll, so a cached
  // entry cannot accumulate duplicate notes.
  const ordered = [...loaded].sort((left, right) => left.id.localeCompare(right.id))
  const claimants = ordered.filter(entry =>
    entry.config?.primary === true && entry.identity !== undefined && entry.error === undefined)
  const winner = claimants[0]
  for (const entry of loaded) {
    entry.primary = winner !== undefined && entry === winner
    entry.warnings = entry.warnings.filter(warning => !warning.startsWith('primary ignored:'))
    if (entry.config?.primary === true && entry.primary === false && entry.error === undefined) {
      entry.warnings.push(`primary ignored: bot "${winner!.id}" is the effective primary`)
    }
  }
  return { bots: loaded.sort((left, right) => left.id.localeCompare(right.id)), warnings }
}

/**
 * Race-safe id availability check over both roots. Any existing directory
 * counts, including an invalid definition; nothing is read or overwritten.
 */
export async function assertBotIdAvailable(roots: BotAgentRoots, id: string): Promise<void> {
  if (!ID_PATTERN.test(id)) throw new Error('id must match ^[a-z0-9][a-z0-9-]{0,31}$')
  for (const root of [roots.workspace, roots.device]) {
    const path = join(root, id)
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing !== undefined) throw new Error(`bot "${id}" already exists`)
  }
}

/**
 * Create one bot directory without overwriting anything. `mkdir` is the
 * exclusive step, and both files use the exclusive `wx` flag; a partial
 * failure never replaces an existing definition.
 */
export async function createBotDirectory(
  directory: string,
  identity: BotAgentIdentity,
): Promise<void> {
  const identityText = formatIdentity(identity)
  // Validate exactly what will be written, before the first file exists.
  parseIdentity(identityText)
  // `mkdir` is the exclusive step: a concurrent creation fails here and its
  // directory is never removed by this caller.
  await mkdir(directory)
  try {
    await writeFile(
      join(directory, 'bot.json'),
      `${JSON.stringify({
        primary: true,
        tools: { session: true, todo: true, memory: true, workspace: true },
      }, null, 2)}\n`,
      { encoding: 'utf-8', flag: 'wx', mode: 0o600 },
    )
    await writeFile(join(directory, 'identity.md'), identityText, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    })
    await mkdir(join(directory, 'memory'))
  } catch (error) {
    // Only this call's own partial directory is cleaned up.
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
