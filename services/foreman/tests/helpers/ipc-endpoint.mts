import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveIpcPath } from '../../lib/transport/ipc-server.mts'

export interface TestIpcEndpoint {
  path: string
  dir: string
}

let endpointCounter = 0

function shortTmpDir(): string {
  if (process.platform !== 'win32') {
    try {
      return realpathSync('/tmp')
    } catch {
      return realpathSync(tmpdir())
    }
  }

  return tmpdir()
}

function shortPrefix(prefix: string): string {
  return prefix.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 8) || 'ipc'
}

export function createTestIpcEndpoint(prefix: string): TestIpcEndpoint {
  const dir = mkdtempSync(join(shortTmpDir(), 'fm-'))
  const counter = endpointCounter++

  if (process.platform === 'win32') {
    return {
      path: resolveIpcPath(`fm-${shortPrefix(prefix)}-${process.pid}-${counter}`, dir),
      dir,
    }
  }

  return {
    path: resolveIpcPath(`fm-${process.pid}-${counter}`, dir),
    dir,
  }
}
