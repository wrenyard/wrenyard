import { parseArgs } from 'node:util'
import { connectIpcForemanClient } from '@wrenyard/daemon/control/ipc-client'
import { resolveWrenyardIpcPath } from '@wrenyard/control'
import type { CleanupPreviewResult, CleanupRunResult, StorageCleanupCategoryId } from '@wrenyard/daemon/protocol/registry'
import {
  type IpcForemanClient,
  errorMessage,
  isHelpRequest,
  loadServiceConfigForCli,
} from '../shared.mts'

const STORAGE_USAGE = 'Usage: wrenyard storage [preview] [--category <id>]... [--json] / wrenyard storage run --apply [--category <id>]... [--json]'

/** Recognized managed-cleanup categories, kept in sync with the daemon schema. */
const RECOGNIZED_CATEGORIES: readonly StorageCleanupCategoryId[] = ['artifacts', 'logs', 'clients', 'worktrees', 'debug']

/**
 * Split repeated and/or comma-separated `--category` values and reject any
 * value that is not a recognized managed-cleanup category. Returns `undefined`
 * when no filter was requested, which means "every category".
 */
function parseCategories(inputs: readonly string[] | undefined): StorageCleanupCategoryId[] | undefined {
  if (inputs === undefined || inputs.length === 0) return undefined
  const requested = inputs
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '')
  if (requested.length === 0) return undefined
  const unknown = requested.filter((value) => !(RECOGNIZED_CATEGORIES as readonly string[]).includes(value))
  if (unknown.length > 0) {
    throw new Error(`Unknown cleanup category: ${unknown.join(', ')}. Recognized categories: ${RECOGNIZED_CATEGORIES.join(', ')}`)
  }
  return [...new Set(requested)] as StorageCleanupCategoryId[]
}

/**
 * Preview (default) reports the managed artifacts eligible for reclamation
 * without touching disk; run executes the cleanup and requires an explicit
 * `--apply` acknowledgement so a destructive sweep is never implicit.
 */
export async function handleStorage(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log(STORAGE_USAGE)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      apply: { type: 'boolean' },
      category: { type: 'string', multiple: true },
    },
    allowPositionals: true,
    strict: true,
  })

  if (positionals.length > 1) {
    console.error(`Unexpected positional argument: ${positionals[1]}\n${STORAGE_USAGE}`)
    return 1
  }
  const subcommand = positionals[0] ?? 'preview'
  if (subcommand !== 'preview' && subcommand !== 'run') {
    console.error(`Unknown storage subcommand: ${subcommand}\n${STORAGE_USAGE}`)
    return 1
  }
  if (subcommand === 'run' && values.apply !== true) {
    console.error('Refusing to run managed cleanup without --apply. Re-run: wrenyard storage run --apply')
    return 1
  }

  let categories: StorageCleanupCategoryId[] | undefined
  try {
    categories = parseCategories(values.category)
  } catch (error) {
    console.error(`${errorMessage(error)}\n${STORAGE_USAGE}`)
    return 1
  }
  const params = categories === undefined ? {} : { categories }

  const { config } = loadServiceConfigForCli(values.config)
  const ipcPath = resolveWrenyardIpcPath(process.env, { config })

  let client: IpcForemanClient | undefined
  try {
    client = await connectIpcForemanClient({ path: ipcPath, timeoutMs: 1_000 })
    if (subcommand === 'preview') {
      const result = await client.storage.cleanup.preview(params)
      if (values.json) console.log(JSON.stringify(result, null, 2))
      else printPreview(result)
    } else {
      const result = await client.storage.cleanup.run(params)
      if (values.json) console.log(JSON.stringify(result, null, 2))
      else printRun(result)
    }
    return 0
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  } finally {
    client?.close()
  }
}

function printPreview(result: CleanupPreviewResult): void {
  console.log('Managed storage cleanup preview')
  console.log(`  state root: ${result.stateRoot}`)
  console.log(`  generated:  ${result.generatedAt}`)
  console.log('Categories:')
  for (const category of result.categories) {
    const over = category.overCapacity ? ', over capacity' : ''
    console.log(`  ${category.id}: total ${category.totalBytes} B, eligible ${category.eligibleBytes} B, protected ${category.protectedBytes} B (target ${category.targetBytes} B${over})`)
  }
  console.log('Candidates:')
  for (const candidate of result.candidates) {
    const decision = candidate.eligible ? 'eligible' : 'protected'
    console.log(`  ${candidate.path} | ${candidate.category} | ${decision} | ${candidate.logicalBytes} | ${candidate.reason}`)
  }
}

function printRun(result: CleanupRunResult): void {
  console.log('Managed storage cleanup run')
  console.log(`  state root: ${result.stateRoot}`)
  console.log(`  trigger:    ${result.trigger}`)
  console.log('Outcomes:')
  for (const outcome of result.outcomes) {
    console.log(`  ${outcome.status} | ${outcome.path} | ${outcome.logicalBytes} | ${outcome.reason}`)
  }
  const freedByCategory = new Map<string, number>()
  for (const outcome of result.outcomes) {
    if (outcome.status !== 'removed') continue
    freedByCategory.set(outcome.category, (freedByCategory.get(outcome.category) ?? 0) + outcome.logicalBytes)
  }
  console.log('Freed (logical bytes):')
  for (const category of result.categories) {
    console.log(`  ${category.id}: ${freedByCategory.get(category.id) ?? 0}`)
  }
  console.log(`Run ${result.runId} finished at ${result.generatedAt}: freed ${result.removedLogicalBytes} logical / ${result.removedAllocatedBytes} allocated bytes`)
}
