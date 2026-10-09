import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// App-name leaf appended under each resolved Wrenyard root, matching src/main/xdg.ts.
const APP_NAME = 'pet';

export function configHome() {
  const override = process.env.WRENYARD_CONFIG_HOME?.trim();
  if (override) return resolve(override);
  return join(homedir(), '.config', 'wrenyard');
}

export function stateHome() {
  const override = process.env.WRENYARD_STATE_HOME?.trim();
  if (override) return resolve(override);
  return join(homedir(), '.local', 'state', 'wrenyard');
}

export function stateDir() {
  return join(stateHome(), APP_NAME);
}

export function configDir() {
  return join(configHome(), APP_NAME);
}
