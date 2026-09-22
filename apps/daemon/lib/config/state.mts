import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function foremanStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const wrenyardStateHome = env.WRENYARD_STATE_HOME?.trim()
  if (wrenyardStateHome) return resolve(wrenyardStateHome)
  const xdgStateHome = env.XDG_STATE_HOME?.trim()
  const stateHome = xdgStateHome ? resolve(xdgStateHome) : join(homedir(), '.local', 'state')
  return join(stateHome, 'wrenyard')
}
