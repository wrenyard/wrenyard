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

// The daemon entrypoint starts the daemon server directly. It never imports the
// CLI application: task/execution lifecycle and the product IPC server are the
// daemon's own responsibility.
const { runForemanService } = await import('../lib/server-bootstrap/service.mts')

runForemanService().then((code) => {
  if (code !== 0) process.exit(code)
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
