import * as path from 'node:path';
import { resolveWrenyardStateRoot } from '@wrenyard/paths';

const APP_NAME = 'pet';

export function stateHome(): string {
  return resolveWrenyardStateRoot();
}

export function stateDir(): string {
  return path.join(stateHome(), APP_NAME);
}
