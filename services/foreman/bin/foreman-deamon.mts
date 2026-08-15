#!/usr/bin/env tsx
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export { runForemanService } from '../lib/client/cli/commands/daemon-service.mts'
import { runForemanService } from '../lib/client/cli/commands/daemon-service.mts'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runForemanService().then((code) => {
    if (code !== 0) process.exit(code)
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
