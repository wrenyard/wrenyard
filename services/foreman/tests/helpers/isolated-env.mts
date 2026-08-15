import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from '../../lib/db/connection.mts'

const isolatedKeys = [
  'FOREMAN_DB_PATH',
  'FOREMAN_OPENCODE_BIN',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
] as const

type IsolatedKey = typeof isolatedKeys[number]

export interface IsolatedForemanEnv {
  root: string
  stateHome: string
  configHome: string
  dbPath: string
  restore(): void
}

export function installIsolatedForemanEnv(prefix: string): IsolatedForemanEnv {
  const previous = new Map<IsolatedKey, string | undefined>()
  for (const key of isolatedKeys) previous.set(key, process.env[key])

  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const stateHome = join(root, 'state')
  const configHome = join(root, 'config')
  const dbPath = join(root, 'foreman.sqlite')
  mkdirSync(stateHome, { recursive: true })
  mkdirSync(configHome, { recursive: true })

  process.env.FOREMAN_DB_PATH = dbPath
  process.env.XDG_STATE_HOME = stateHome
  process.env.XDG_CONFIG_HOME = configHome
  process.env.FOREMAN_OPENCODE_BIN = join(root, 'opencode-disabled-for-tests')

  return {
    root,
    stateHome,
    configHome,
    dbPath,
    restore() {
      closeDb()
      for (const key of isolatedKeys) {
        const value = previous.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}
