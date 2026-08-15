import { homedir } from 'node:os';
import { join, sep } from 'node:path';

// Namespace composition matching src/main/xdg.ts: <home>/wrenyard/pet.
const APP_NAMESPACE = ['wrenyard', 'pet'];

export function configHome() {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  return join(homedir(), '.config');
}

export function stateHome() {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  return join(homedir(), '.local', 'state');
}

export function stateDir() {
  return [stateHome(), ...APP_NAMESPACE].join(sep);
}

export function configDir() {
  return [configHome(), ...APP_NAMESPACE].join(sep);
}
