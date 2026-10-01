import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source text of the shell window plus its per-domain IPC modules
 * (`src/main/ipc/*.ts`), for tests that assert on handler registrations.
 */
export function shellIpcSource(desktopRoot: string): string {
  const ipcDir = join(desktopRoot, 'src', 'main', 'ipc');
  const modules = readdirSync(ipcDir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => readFileSync(join(ipcDir, name), 'utf8'));
  return [readFileSync(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8'), ...modules].join('\n');
}
