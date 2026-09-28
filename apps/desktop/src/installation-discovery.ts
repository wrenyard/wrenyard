import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Why an installed installation could not be resolved. Every surface (snapshot,
 * menu, renderer) reports the same code so the reason stays consistent.
 */
export type InstallCapabilityReason =
  | 'unsupported-platform'
  | 'missing-cli'
  | 'missing-runtime';

export type InstallationKind = 'packaged' | 'source';

/**
 * A resolved Wrenyard installation. A packaged install is a self-contained suite
 * (`<resources>/wrenyard`); a source install is a checkout whose CLI runs from
 * source through tsx. `rootPath` always names the directory that owns the suite
 * runtime and the control tree, so callers never reconstruct it from a leaf.
 */
export interface InstallationDiscovery {
  kind?: InstallationKind;
  /** Root that owns `wrenyard[.exe]`, `runtime/` and the control tree. */
  rootPath?: string;
  /** Installed CLI executable (`<root>/wrenyard[.exe]`). Absent for a checkout. */
  cliPath?: string;
  /** Node runtime that runs the control tree and the daemon. */
  runtimePath?: string;
  reason?: InstallCapabilityReason;
}

export interface InstallationDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Installed-package detection; the caller passes `app.isPackaged`. */
  packaged?: boolean;
  /** Electron resources directory; defaults to `process.resourcesPath`. */
  resourcesPath?: string;
  /** Start of the upward search for a checkout when no env override exists. */
  searchFrom?: string;
  /** Bounded file probe; injected so tests never touch a real installation. */
  exists?: (path: string) => boolean;
  existsFile?: (path: string) => boolean;
}

const PACKAGED_SUITE_DIR = 'wrenyard';
const CHECKOUT_MARKER = join('bin', 'wrenyard.mjs');
const MAX_CHECKOUT_SEARCH_DEPTH = 8;

function defaultExistsFile(path: string, exists: (path: string) => boolean): boolean {
  if (!exists(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Nearest ancestor (including `start`) that looks like a Wrenyard checkout. */
function findCheckoutRoot(
  start: string,
  existsFile: (path: string) => boolean,
): string | undefined {
  let current = resolve(start);
  for (let depth = 0; depth < MAX_CHECKOUT_SEARCH_DEPTH; depth += 1) {
    if (existsFile(join(current, CHECKOUT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Resolve the CLI together with the Node runtime of the *same* installation.
 *
 * A packaged Desktop always uses the suite shipped next to it
 * (`process.resourcesPath/wrenyard`); a source Desktop uses the checkout it is
 * running from. Legacy per-user suite layouts are intentionally not consulted:
 * a stale installation must never pair with the current Desktop.
 */
export function resolveInstallation(
  options: InstallationDiscoveryOptions = {},
): InstallationDiscovery {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const existsFile = options.existsFile ?? ((path: string) => defaultExistsFile(path, exists));
  const exeSuffix = platform === 'win32' ? '.exe' : '';
  const packaged = options.packaged ?? Boolean(process.resourcesPath);

  if (packaged) {
    const resources = options.resourcesPath ?? process.resourcesPath;
    if (!resources) return { reason: 'missing-cli' };
    const root = join(resources, PACKAGED_SUITE_DIR);
    const cliPath = join(root, `wrenyard${exeSuffix}`);
    const runtimePath = join(root, 'runtime', `node${exeSuffix}`);
    if (!existsFile(cliPath)) return { kind: 'packaged', rootPath: root, runtimePath, reason: 'missing-cli' };
    if (!existsFile(runtimePath)) return { kind: 'packaged', rootPath: root, cliPath, reason: 'missing-runtime' };
    return { kind: 'packaged', rootPath: root, cliPath, runtimePath };
  }

  const override = env.WRENYARD_SOURCE_CHECKOUT?.trim();
  const root = override ? resolve(override) : findCheckoutRoot(options.searchFrom ?? process.cwd(), existsFile);
  if (!root) return { reason: 'missing-cli' };
  // The source runtime is the Node running tsx; an explicit override is honored
  // so a Desktop launched by `pnpm dev:desktop` uses the supervisor's Node.
  const runtimePath = env.WRENYARD_NODE_BIN?.trim() || 'node';
  return { kind: 'source', rootPath: root, runtimePath };
}
