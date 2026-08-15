import * as os from 'node:os';
import * as path from 'node:path';

const NAMESPACE = 'wrenyard';
const APP_NAME = 'pet';

export function configHome(): string {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  return path.join(os.homedir(), '.config');
}

export function stateHome(): string {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  return path.join(os.homedir(), '.local', 'state');
}

export function configDir(): string {
  return path.join(configHome(), NAMESPACE, APP_NAME);
}

export function stateDir(): string {
  return path.join(stateHome(), NAMESPACE, APP_NAME);
}
