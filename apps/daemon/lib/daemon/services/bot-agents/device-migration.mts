/**
 * One-time move of device bots from `<config root>/bot-agents` into
 * `<config root>/bots`, run once at daemon start before bots load.
 *
 * - A flat `<id>.json` bot becomes a `<id>/` directory: `bot.json`,
 *   `identity.md`, `memory/`, and one routine file per declared routine. The
 *   flat file is kept as `<id>.json.migrated`.
 * - A `<id>/` directory moves as a whole when `bots/<id>` does not exist yet;
 *   otherwise only its `routines/` moves, when the target has none.
 * - Anything that cannot move stays where it is and is reported.
 *
 * Only `bot-agents` is read: the legacy bot mode's own `*.json` files in
 * `bots` are never touched.
 */

import { mkdir, readdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, formatIdentity, isBotId, validateTools } from './config.mts'
import { newRoutineId, writeRoutine, MAX_INTERVAL_MINUTES, MAX_PROMPT_LENGTH } from './routine-files.mts'

/** The keys an old flat bot file may carry; `denyModels` and `deliver` are dropped. */
const FLAT_KEYS = new Set(['id', 'name', 'enabled', 'instructions', 'tools', 'routines', 'denyModels'])

interface FlatRoutine {
  name: string
  prompt: string
  intervalMinutes: number
}

interface FlatBot {
  name: string
  enabled: boolean
  instructions: string
  tools: Record<string, true>
  routines: FlatRoutine[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFlatBot(text: string, id: string): FlatBot {
  const parsed: unknown = JSON.parse(text)
  if (!isPlainObject(parsed)) throw new Error('bot file must be a JSON object')
  for (const key of Object.keys(parsed)) {
    if (!FLAT_KEYS.has(key)) throw new Error(`unknown field: ${key}`)
  }
  if (parsed.id !== undefined && parsed.id !== id) throw new Error(`declared id ${String(parsed.id)} does not match the file name`)
  const { name, enabled, instructions } = parsed
  if (name !== undefined && typeof name !== 'string') throw new Error('name must be a string')
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
  if (instructions !== undefined && typeof instructions !== 'string') throw new Error('instructions must be a string')
  if (parsed.routines !== undefined && !Array.isArray(parsed.routines)) throw new Error('routines must be an array')
  const routines = ((parsed.routines ?? []) as unknown[]).map((value) => {
    if (!isPlainObject(value)) throw new Error('routine must be an object')
    const { prompt, intervalMinutes } = value
    if (typeof value.name !== 'string' || value.name.trim() === '') throw new Error('routine name must be a nonempty string')
    if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`routine ${value.name}: invalid prompt`)
    }
    if (typeof intervalMinutes !== 'number' || !Number.isInteger(intervalMinutes)
      || intervalMinutes < 1 || intervalMinutes > MAX_INTERVAL_MINUTES) {
      throw new Error(`routine ${value.name}: invalid intervalMinutes`)
    }
    return { name: value.name, prompt, intervalMinutes }
  })
  return {
    name: name ?? id,
    enabled: enabled ?? true,
    instructions: instructions ?? '',
    tools: Object.fromEntries(validateTools(parsed.tools ?? {}).map(tool => [tool, true as const])),
    routines,
  }
}

/** Turn one flat bot file into a bot directory in the target root. */
async function migrateFlatBot(source: string, targetRoot: string, id: string): Promise<void> {
  const bot = parseFlatBot(await readFile(source, 'utf-8'), id)
  const directory = join(targetRoot, id)
  await mkdir(join(directory, 'memory'), { recursive: true })
  await writeFile(join(directory, 'bot.json'), `${JSON.stringify({ enabled: bot.enabled, tools: bot.tools }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(directory, 'identity.md'), formatIdentity({ name: bot.name, body: bot.instructions }))
  const routinesDir = join(directory, 'routines')
  const ids: string[] = []
  for (const routine of bot.routines) {
    const routineId = newRoutineId(ids)
    ids.push(routineId)
    await writeRoutine(routinesDir, { id: routineId, name: routine.name, intervalMinutes: routine.intervalMinutes, state: 'active', prompt: routine.prompt })
  }
  await rename(source, `${source}.migrated`)
}

/**
 * Move every device bot of `legacyRoot` into `targetRoot`. Returns what could
 * not be moved, for the daemon log; a missing legacy root moves nothing.
 */
export async function migrateDeviceBots(legacyRoot: string, targetRoot: string): Promise<string[]> {
  const notes: string[] = []
  let names: string[]
  try {
    names = (await readdir(legacyRoot)).sort()
  } catch {
    return notes
  }
  await mkdir(targetRoot, { recursive: true })
  for (const name of names) {
    const source = join(legacyRoot, name)
    try {
      if (name.endsWith('.json') && isBotId(name.slice(0, -'.json'.length))) {
        const id = name.slice(0, -'.json'.length)
        if (await exists(join(targetRoot, id))) {
          notes.push(`device bot file ${name} not migrated: bots/${id} already exists`)
          continue
        }
        await migrateFlatBot(source, targetRoot, id)
        continue
      }
      if (!isBotId(name) || !(await exists(join(source, '.')))) continue
      const target = join(targetRoot, name)
      if (!(await exists(target))) {
        await rename(source, target)
      } else if (await exists(join(source, 'routines')) && !(await exists(join(target, 'routines')))) {
        await rename(join(source, 'routines'), join(target, 'routines'))
        await rmdir(source).catch(() => notes.push(`bot-agents/${name} kept: it still holds other files`))
      } else {
        notes.push(`bot-agents/${name} kept: bots/${name} already has it`)
      }
    } catch (error) {
      notes.push(`device bot ${name} not migrated: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await rmdir(legacyRoot).catch(() => {})
  return notes
}
