/**
 * Routine definition files.
 *
 * A bot's routines on this device are files in its device directory,
 * `<config root>/bots/<bot id>/routines/<routine id>.md`:
 *
 * ```
 * ---
 * name: todo-sweep
 * intervalMinutes: 30
 * state: active
 * ---
 * The short trigger text the bot is woken with.
 * ```
 *
 * The files are the definition; the scheduler keeps only run state (next run,
 * last run, run count) for the same ids. Keep the text short: a routine fires
 * on a schedule into the bot's own conversation, so procedure details belong
 * in the bot's memory.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { TODO_STATUSES } from '../workspace-todo-service.mts'

/** One routine as its file defines it. */
export interface RoutineDefinition {
  /** 8 lowercase hex characters, the file name without `.md`. */
  id: string
  name?: string
  intervalMinutes?: number
  on?: string
  match?: string[]
  state: 'active' | 'paused'
  prompt: string
}

export const ROUTINE_ID_PATTERN = /^[0-9a-f]{8}$/
export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 10_080
export const MAX_PROMPT_LENGTH = 4_000
const MAX_NAME_LENGTH = 64
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/
const KEYS = new Set(['name', 'intervalMinutes', 'on', 'match', 'state'])

function validateMatch(value: string): string {
  if (value === 'comment') return value
  if (value.startsWith('status:') && (TODO_STATUSES as readonly string[]).includes(value.slice(7))) return value
  const tag = /^[+-]([^\s\p{Cc}*]+)(\*)?$/u.exec(value)
  if (tag !== null && tag[1] !== '') return value
  throw new Error(`invalid routine match: ${value}`)
}

/** Validate one definition; throws naming the first problem. */
export function validateRoutine(definition: RoutineDefinition): RoutineDefinition {
  if (!ROUTINE_ID_PATTERN.test(definition.id)) throw new Error('routine id must be 8 lowercase hex characters')
  const prompt = definition.prompt.trim()
  if (prompt === '') throw new Error('routine prompt must not be empty')
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`routine prompt must be at most ${MAX_PROMPT_LENGTH} characters`)
  if (definition.on === undefined) {
    if (definition.match !== undefined || !Number.isInteger(definition.intervalMinutes)
      || definition.intervalMinutes! < MIN_INTERVAL_MINUTES || definition.intervalMinutes! > MAX_INTERVAL_MINUTES) {
      throw new Error(`intervalMinutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`)
    }
  } else {
    if (definition.on !== 'todo') throw new Error('only on: todo is supported')
    if (definition.intervalMinutes !== undefined) throw new Error('on/match and intervalMinutes are mutually exclusive')
    if (!Array.isArray(definition.match) || definition.match.length === 0) throw new Error('event routines require a non-empty match array')
    definition.match = definition.match.map(validateMatch)
  }
  if (definition.state !== 'active' && definition.state !== 'paused') throw new Error('state must be active or paused')
  const name = definition.name?.trim()
  if (name !== undefined && (name === '' || name.length > MAX_NAME_LENGTH || name.includes('\n'))) {
    throw new Error(`routine name must be one line of at most ${MAX_NAME_LENGTH} characters`)
  }
  return {
    id: definition.id,
    ...(name === undefined ? {} : { name }),
    ...(definition.intervalMinutes === undefined ? {} : { intervalMinutes: definition.intervalMinutes }),
    ...(definition.on === undefined ? {} : { on: definition.on, match: [...definition.match!] }),
    state: definition.state,
    prompt,
  }
}

/** Parse one routine file; `id` comes from its file name. */
export function parseRoutine(id: string, text: string): RoutineDefinition {
  const match = FRONT_MATTER.exec(text.replace(/\r\n/g, '\n'))
  if (match === null) throw new Error('routine file has no YAML front matter')
  const data: unknown = parseYaml(match[1]!)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('routine front matter must be a mapping')
  const record = data as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) throw new Error(`unknown routine key: ${key}`)
  }
  if (record.name !== undefined && typeof record.name !== 'string') throw new Error('routine name must be a string')
  if (record.on !== undefined && typeof record.on !== 'string') throw new Error('routine on must be a string')
  if (record.match !== undefined && (!Array.isArray(record.match) || record.match.some(item => typeof item !== 'string'))) throw new Error('routine match must be an array of strings')
  if (record.on === undefined && record.match !== undefined) throw new Error('match requires on: todo')
  if (record.on !== undefined && record.intervalMinutes !== undefined) throw new Error('on/match and intervalMinutes are mutually exclusive')
  if (record.on !== undefined && record.match === undefined) throw new Error('event routines require a non-empty match array')
  if (record.on === undefined && record.intervalMinutes === undefined) throw new Error('intervalMinutes is required')
  return validateRoutine({
    id,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(record.intervalMinutes === undefined ? {} : { intervalMinutes: record.intervalMinutes as number }),
    ...(record.on === undefined ? {} : { on: record.on, ...(record.match === undefined ? {} : { match: record.match as string[] }) }),
    state: (record.state ?? 'active') as RoutineDefinition['state'],
    prompt: match[2]!,
  })
}

/** Render one definition in the layout {@link parseRoutine} reads. */
export function formatRoutine(definition: RoutineDefinition): string {
  const data: Record<string, unknown> = {}
  if (definition.name !== undefined) data.name = definition.name
  if (definition.intervalMinutes !== undefined) data.intervalMinutes = definition.intervalMinutes
  if (definition.on !== undefined) { data.on = definition.on; data.match = definition.match }
  data.state = definition.state
  return `---\n${stringifyYaml(data).trimEnd()}\n---\n\n${definition.prompt.trim()}\n`
}

/**
 * Read every routine of one directory. A missing directory yields `undefined`
 * (the bot has no routine files yet). Files that exist but fail to parse are
 * listed in `invalidIds` and `errors` while valid routines are still returned.
 */
export async function readRoutines(
  directory: string,
): Promise<{ routines: RoutineDefinition[]; invalidIds: string[]; errors: string[]; signature: string } | undefined> {
  let names: string[]
  try {
    const info = await lstat(directory)
    if (!info.isDirectory()) return { routines: [], invalidIds: [], errors: ['routines is not a directory'], signature: 'invalid' }
    names = (await readdir(directory)).filter(name => name.endsWith('.md')).sort()
  } catch {
    return undefined
  }
  const routines: RoutineDefinition[] = []
  const invalidIds: string[] = []
  const errors: string[] = []
  const stamps: string[] = []
  for (const name of names) {
    const id = name.slice(0, -3)
    const path = join(directory, name)
    try {
      const info = await lstat(path)
      if (!info.isFile()) throw new Error('not a regular file')
      routines.push(parseRoutine(id, await readFile(path, 'utf-8')))
      stamps.push(`${name}:${info.size}:${info.mtimeMs}`)
    } catch (error) {
      invalidIds.push(id)
      try {
        const info = await lstat(path)
        if (info.isFile()) stamps.push(`${name}:${info.size}:${info.mtimeMs}:invalid`)
        else stamps.push(`${name}:invalid`)
      } catch {
        stamps.push(`${name}:invalid`)
      }
      errors.push(`routine ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { routines, invalidIds, errors, signature: stamps.join('|') }
}

/** Atomically write one routine file, creating the directory when needed. */
export async function writeRoutine(directory: string, definition: RoutineDefinition): Promise<RoutineDefinition> {
  const valid = validateRoutine(definition)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${valid.id}.md`)
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, formatRoutine(valid), 'utf-8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return valid
}

/** Remove one routine file; a missing file is not an error. */
export async function removeRoutine(directory: string, id: string): Promise<void> {
  if (!ROUTINE_ID_PATTERN.test(id)) throw new Error('routine id must be 8 lowercase hex characters')
  await unlink(join(directory, `${id}.md`)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

/** A fresh routine id not in `taken`. */
export function newRoutineId(taken: Iterable<string>): string {
  const used = new Set(taken)
  let id = randomBytes(4).toString('hex')
  while (used.has(id)) id = randomBytes(4).toString('hex')
  return id
}
