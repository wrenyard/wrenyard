import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

/**
 * Why in-app installation is unavailable. Every surface (snapshot, menu,
 * renderer) reports exactly one of these so the reason stays consistent.
 */
export type InstallCapabilityReason =
  | 'unsupported-platform'
  | 'missing-cli'
  | 'missing-runtime'
  | 'missing-helper';

/** The Wrenyard suite layout: <root>/wrenyard + <root>/runtime/node(.exe). */
export interface InstallationDiscovery {
  cliPath?: string;
  /** Bundled Node runtime that belongs to the *same* resolved suite as cliPath. */
  runtimePath?: string;
  reason?: InstallCapabilityReason;
}

export interface InstallationDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Bounded file probe; injected so tests never touch a real installation. */
  exists?: (path: string) => boolean;
}

function isFile(path: string, exists: (path: string) => boolean): boolean {
  if (!exists(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve a possibly-symlinked path without requiring the leaf to exist. */
function canonicalPath(path: string, exists: (path: string) => boolean): string {
  let candidate = path;
  for (let depth = 0; depth < 40; depth += 1) {
    if (exists(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) return path;
    candidate = parent;
  }
  return path;
}

/** Rebuild an absolute path from a leading '/', or a drive letter on Windows. */
function joinSegments(segments: string[], absolute: boolean, drive?: string): string {
  const joined = segments.join(sep);
  if (drive) return `${drive}${sep}${joined}`;
  return absolute ? `${sep}${joined}` : joined;
}

/**
 * Candidate suite roots for one CLI executable, most specific first.
 *
 * The suite keeps `wrenyard` next to `runtime/node` (the release staging
 * layout), while the npm-style package stage hides the runtime under
 * `.wrenyard/runtime`. A launcher shim may also live beside the suite or sit
 * under a separate bin directory, so each shape contributes a candidate.
 */
function cliSuiteRoots(cliPath: string, exists: (path: string) => boolean): string[] {
  const roots: string[] = [];
  const push = (root: string): void => {
    if (root && !roots.includes(root)) roots.push(root);
  };

  // Resolve every symlink first: a custom `current` link (including the
  // Windows junction/link the installer creates) and a launcher shim both
  // point at the real version directory, which is where the runtime lives.
  const resolved = canonicalPath(cliPath, exists);
  const resolvedDir = dirname(resolved);
  push(resolvedDir);

  const base = basename(resolved).toLowerCase();
  if (base === 'wrenyard.mjs') {
    // <package>/bin/wrenyard.mjs -> <package>/.wrenyard/runtime
    push(join(resolvedDir, '..', '.wrenyard'));
  }

  // A public launcher shim (<prefix>/bin/wrenyard) points at, or sits beside,
  // the `current` link of the suite.
  const absolute = resolved.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(resolved);
  const drive = /^([A-Za-z]:)[\\/]/u.exec(resolved)?.[1];
  const segments = resolved.split(/[\\/]+/u).filter((segment) => segment.length > 0
    && !/^[A-Za-z]:$/u.test(segment));
  const binIndex = segments.lastIndexOf('bin');
  if (binIndex > 0) {
    const prefix = joinSegments(segments.slice(0, binIndex), absolute, drive);
    push(join(prefix, 'current'));
    push(prefix);
  }

  return roots;
}

function runtimeCandidates(root: string, exeSuffix: string): string[] {
  return [
    // Suite layout: <root>/runtime/node(.exe)
    join(root, 'runtime', `node${exeSuffix}`),
    // npm package layout: <root>/.wrenyard/runtime/node(.exe)
    join(root, '.wrenyard', 'runtime', `node${exeSuffix}`),
  ];
}

/** Explicit WRENYARD_CLI, then the working directory, then the default install. */
function cliCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const exeSuffix = platform === 'win32' ? '.exe' : '';
  const candidates = [env.WRENYARD_CLI];
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    candidates.push(
      join(process.cwd(), `wrenyard${exeSuffix}`),
      join(localAppData, 'wrenyard', 'current', `wrenyard${exeSuffix}`),
      join(localAppData, 'wrenyard', 'bin', 'wrenyard.cmd'),
    );
  } else {
    candidates.push(
      join(process.cwd(), 'wrenyard'),
      join(home, '.local', 'bin', 'wrenyard'),
      join(home, '.local', 'share', 'wrenyard', 'bin', 'wrenyard'),
      join(home, '.local', 'share', 'wrenyard', 'current', 'wrenyard'),
    );
  }
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * Resolve the installed CLI together with the Node runtime of the *same*
 * suite. A custom CLI must never pair with the old default runtime: when the
 * runtime cannot be derived from the resolved CLI, discovery reports
 * `missing-runtime` instead of falling back to an unrelated installation.
 */
export function resolveInstallation(
  options: InstallationDiscoveryOptions = {},
): InstallationDiscovery {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;
  const exeSuffix = platform === 'win32' ? '.exe' : '';

  // An explicit Node override is an operator decision, never a silent mix.
  const explicitNode = env.WRENYARD_NODE_BIN;
  if (explicitNode && !isFile(explicitNode, exists)) {
    return { reason: 'missing-runtime' };
  }

  for (const candidate of cliCandidates(platform, env, home)) {
    if (!isFile(candidate, exists)) continue;
    // Report the canonical executable: a launcher shim and a custom `current`
    // link both resolve to the same real path the runtime is derived from.
    const cliPath = canonicalPath(candidate, exists);
    if (explicitNode) return { cliPath, runtimePath: explicitNode };
    for (const root of cliSuiteRoots(cliPath, exists)) {
      for (const candidateRuntime of runtimeCandidates(root, exeSuffix)) {
        if (isFile(candidateRuntime, exists)) {
          return { cliPath, runtimePath: canonicalPath(candidateRuntime, exists) };
        }
      }
    }
    // The CLI exists but its suite runtime does not: report the precise reason
    // rather than borrowing a runtime from another installation.
    return { cliPath, reason: 'missing-runtime' };
  }

  if (explicitNode) return { runtimePath: explicitNode, reason: 'missing-cli' };
  return { reason: 'missing-cli' };
}
