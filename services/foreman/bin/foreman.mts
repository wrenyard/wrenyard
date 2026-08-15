#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entryPath = fileURLToPath(import.meta.url)
const runningWithTsx = process.execArgv.some((arg) => arg.includes('tsx'))

if (!runningWithTsx) {
  const tsxCli = join(dirname(entryPath), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const result = spawnSync(process.execPath, [tsxCli, entryPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }

  process.exit(result.signal ? 1 : (result.status ?? 0))
}

const [
  { errorMessage },
  { isCliEntrypoint, runCliEntrypoint },
] = await Promise.all([
  import('../lib/client/cli/shared.mts'),
  import('../lib/client/cli/index.mts'),
])

if (isCliEntrypoint()) {
  runCliEntrypoint().catch((error) => {
    console.error(errorMessage(error))
    process.exit(1)
  })
}
