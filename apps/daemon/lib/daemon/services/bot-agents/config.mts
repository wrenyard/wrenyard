/**
 * Bot agent config files.
 *
 * One JSON file per bot under `<config root>/bot-agents/<id>.json`. The file is
 * the whole definition of one bot: its display name, its instructions, the tool
 * switches it turns on and the routines it owns. Nothing is inherited and
 * nothing is enabled by default, so a bot with no tool switch can only answer
 * in text.
 *
 * Loading never throws. An unreadable file, invalid JSON or a failed validation
 * yields an entry that carries `error` and no config, so one bad file disables
 * one bot and never affects the daemon or the other bots.
 */

import type { Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { RoutineConfig } from '../scheduler.mts'

/** One tool switch a bot can turn on. */
export type AgentToolName = 'session' | 'todo' | 'message'

/** Every known tool switch. */
const TOOL_NAMES: readonly AgentToolName[] = ['session', 'todo', 'message']

/** The only top-level keys a bot config file may declare. */
const CONFIG_KEYS = new Set(['id', 'name', 'enabled', 'instructions', 'tools', 'routines', 'denyModels'])

/** A bot id: the config file's basename, lowercase and path safe. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** A routine's delivery target: nowhere, or one other bot. */
const DELIVER_PATTERN = /^(none|bot:[a-z0-9][a-z0-9-]{0,31})$/

/** Same interval bounds the routine store enforces. */
const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 10_080

/** Same prompt length bound the routine store enforces. */
const MAX_PROMPT_LENGTH = 4_000

/** One bot's validated config. */
export interface BotAgentConfig {
  /** Config file basename; also the bot id. */
  id: string
  /** Display name; defaults to the id. */
  name: string
  /** False puts the bot out of service without deleting its file. */
  enabled: boolean
  /** Text appended to the bot's fixed kernel prompt. */
  instructions: string
  /** The tool switches that are on, sorted. Empty means text replies only. */
  tools: AgentToolName[]
  /** Models this bot may not run sessions on: `provider/model` or bare model ids. */
  denyModels: string[]
  /** The routines this config declares; managed by the routine store. */
  routines: RoutineConfig[]
}

/**
 * One config file's change signature. A loader call compares it against the
 * signature of the file it returned last time and reads the file again only
 * when it differs.
 */
export interface BotAgentSignature {
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
}

/**
 * One config file as loaded. `config` is present only when the file validated;
 * otherwise `error` explains why and the bot is disabled. `text` is the raw file
 * content and `signature` the file's change signature, so a caller can poll the
 * directory cheaply.
 */
export interface BotAgentEntry {
  id: string
  path: string
  signature: BotAgentSignature
  text: string
  config?: BotAgentConfig
  error?: string
}

/** A file whose stat failed carries no usable signature and is never reused. */
const EMPTY_SIGNATURE: BotAgentSignature = { mtimeMs: 0, ctimeMs: 0, size: 0, ino: 0 }

function signatureOf(info: Stats): BotAgentSignature {
  return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, ino: info.ino }
}

function sameSignature(left: BotAgentSignature, right: BotAgentSignature): boolean {
  return left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.size === right.size
    && left.ino === right.ino
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Trim and deduplicate the model deny list entries. */
function normalizeDenyModels(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('denyModels must be an array')
  const seen = new Set<string>()
  const models: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('every denyModels entry must be a string')
    const model = entry.trim()
    if (model === '') throw new Error('every denyModels entry must be a nonempty string')
    if (seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models
}

/** Read one `tools` map into the sorted list of enabled tool names. */
function validateTools(value: unknown): AgentToolName[] {
  if (value === undefined) return []
  if (!isPlainObject(value)) throw new Error('tools must be an object')
  const enabled: AgentToolName[] = []
  for (const [key, setting] of Object.entries(value)) {
    if (!(TOOL_NAMES as readonly string[]).includes(key)) throw new Error(`unknown tool: ${key}`)
    // Absent or false means off; true or an options object means on. The options
    // object is accepted and ignored, for `session` just like the other tools.
    if (setting === false) continue
    if (setting !== true && !isPlainObject(setting)) {
      throw new Error(`tool ${key} must be true, false or an options object`)
    }
    enabled.push(key as AgentToolName)
  }
  return enabled.sort()
}

/** Read one `routines` array into validated routine configs. */
function validateRoutines(value: unknown): RoutineConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('routines must be an array')
  const routines: RoutineConfig[] = []
  const names = new Set<string>()
  for (const entry of value) {
    if (!isPlainObject(entry)) throw new Error('every routine must be an object')
    const name = entry.name
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('every routine needs a nonempty name')
    }
    if (names.has(name)) throw new Error(`duplicate routine name: ${name}`)
    names.add(name)
    const prompt = entry.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new Error(`routine ${name}: prompt must be a nonempty string`)
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`routine ${name}: prompt must be at most ${MAX_PROMPT_LENGTH} characters`)
    }
    const intervalMinutes = entry.intervalMinutes
    if (
      typeof intervalMinutes !== 'number'
      || !Number.isInteger(intervalMinutes)
      || intervalMinutes < MIN_INTERVAL_MINUTES
      || intervalMinutes > MAX_INTERVAL_MINUTES
    ) {
      throw new Error(`routine ${name}: intervalMinutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`)
    }
    let deliver: RoutineConfig['deliver'] = 'none'
    const declared = entry.deliver
    if (declared !== undefined) {
      if (typeof declared !== 'string' || !DELIVER_PATTERN.test(declared)) {
        throw new Error(`routine ${name}: deliver must be 'none' or 'bot:<id>'`)
      }
      deliver = declared as RoutineConfig['deliver']
    }
    routines.push({ name, prompt, intervalMinutes, deliver })
  }
  return routines
}

/**
 * Validate one config file's parsed content. The id must match the file's
 * basename, because the basename is the bot id every other layer uses.
 */
function validateConfig(id: string, text: string): BotAgentConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${errorText(error)}`)
  }
  if (!isPlainObject(parsed)) throw new Error('the config must be a JSON object')
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`unknown field: ${key}`)
  }
  const declaredId = parsed.id
  if (typeof declaredId !== 'string' || !ID_PATTERN.test(declaredId)) {
    throw new Error('id must match ^[a-z0-9][a-z0-9-]{0,31}$')
  }
  if (declaredId !== id) {
    throw new Error(`id "${declaredId}" must equal the file name "${id}"`)
  }
  const name = parsed.name
  if (name !== undefined && typeof name !== 'string') throw new Error('name must be a string')
  const enabled = parsed.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const instructions = parsed.instructions
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('instructions must be a string')
  }
  const parsedTools = validateTools(parsed.tools)
  return {
    id,
    name: name ?? id,
    enabled: enabled ?? true,
    instructions: instructions ?? '',
    tools: parsedTools,
    denyModels: normalizeDenyModels(parsed.denyModels),
    routines: validateRoutines(parsed.routines),
  }
}

/**
 * Load every `*.json` bot config in one directory, sorted by id. A missing (or
 * unreadable) directory is an empty list and a file that fails to read or
 * validate is reported as an entry with `error` and no config.
 *
 * `previous` is the result of the last call: an entry whose file name and
 * signature still match is returned as the same object, so unchanged files are
 * neither read nor parsed and a caller can detect changes by identity. Files
 * that disappeared from the directory are dropped. The cache belongs to the
 * caller and is never stored globally.
 */
export async function loadBotAgentConfigs(
  dir: string,
  previous: readonly BotAgentEntry[] = [],
): Promise<BotAgentEntry[]> {
  let names: string[]
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    names = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name)
  } catch {
    // No config directory (or one that cannot be listed) simply has no bots.
    return []
  }
  // Keyed by file name, the name every config lookup below uses.
  const cached = new Map(previous.map(entry => [basename(entry.path), entry]))
  const loaded: BotAgentEntry[] = []
  for (const name of names.sort()) {
    const path = join(dir, name)
    const id = basename(name, '.json')
    let signature: BotAgentSignature
    try {
      signature = signatureOf(await stat(path))
    } catch (error) {
      loaded.push({ id, path, signature: EMPTY_SIGNATURE, text: '', error: errorText(error) })
      continue
    }
    const prior = cached.get(name)
    if (prior !== undefined && prior.signature !== EMPTY_SIGNATURE && sameSignature(prior.signature, signature)) {
      loaded.push(prior)
      continue
    }
    let text: string
    try {
      text = await readFile(path, 'utf-8')
    } catch (error) {
      // A failed read is transient (unlike a failed stat, which cannot be
      // distinguished from a missing file). Marking it with the never-reusable
      // signature makes the next poll read the file again instead of serving
      // this error from the cache until the file happens to change.
      loaded.push({ id, path, signature: EMPTY_SIGNATURE, text: '', error: errorText(error) })
      continue
    }
    try {
      loaded.push({ id, path, signature, text, config: validateConfig(id, text) })
    } catch (error) {
      loaded.push({ id, path, signature, text, error: errorText(error) })
    }
  }
  return loaded
}
