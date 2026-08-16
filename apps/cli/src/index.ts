import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RuntimeResolutionError, resolveForgeBinary } from '@wrenyard/runtime-resolver';
import { formatOutcome, parseUpdateArgs, runUpdate } from './release-update.js';

/** Subcommands of the legacy `foreman` binary routed through the unified CLI. */
export type ForemanCommand =
  | 'service'
  | 'pet'
  | 'task'
  | 'taskgraph'
  | 'project'
  | 'message'
  | 'status'
  | 'update';

/** Parsed dispatch target for a CLI command line. */
export type Route =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'foreman'; args: string[] }
  | { kind: 'forge'; args: string[] }
  | { kind: 'desktop'; args: string[] }
  | { kind: 'update'; args: string[] }
  | { kind: 'doctor' }
  | { kind: 'unknown'; command: string };

/** Outcome of a child process, mirroring the relevant `spawnSync` fields. */
export interface SpawnResult {
  status: number | null;
  error?: Error;
  /** Captured child output; present only when the spawn did not inherit stdio. */
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

/** Injected process runner; defaults to `spawnSync` in production. */
export type Runner = (command: string, args: string[], options: SpawnSyncOptions) => SpawnResult;

/** Resolves the Forge binary path; returns null or throws when it cannot be found. */
export type ForgeResolver = (env: NodeJS.ProcessEnv) => string | null;

/** Options injectable from tests; every field falls back to production behavior. */
export interface MainOptions {
  runner?: Runner;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  suiteRoot?: string;
  resolver?: ForgeResolver;
  /** Node executable used to spawn Foreman; defaults to process.execPath. */
  nodeExecutable?: string;
  /** Desktop binary override; wins over WRENYARD_DESKTOP_BIN and layout discovery. */
  desktopBin?: string;
  /** Embedded suite version; overrides the root package.json when bundled. */
  suiteVersion?: string;
  /** Embedded component versions; overrides contracts/versions.json when bundled. */
  componentVersions?: Record<string, string>;
}

interface MainContext {
  runner: Runner;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  suiteRoot: string;
  resolver: ForgeResolver;
  nodeExecutable: string;
  desktopBin?: string;
  suiteVersion?: string;
  componentVersions?: Record<string, string>;
}

const RUN_OPTIONS: SpawnSyncOptions = { shell: false, stdio: 'inherit' };

const HELP_TEXT = `Wrenyard - one CLI for the whole development suite

Usage: wrenyard <command> [args...]

Commands:
  help, -h, --help        Show this help
  version, -v, --version  Show the suite version and component versions
  service <command>       Control the wrenyard service
  pet, task, taskgraph,   Development suite commands
  project, message,
  status
  update [--version V]    Update from the latest release; --json for machine output
  runtime <command>       Control the wrenyard runtime
  desktop                 Launch the wrenyard Desktop application
  doctor                  Diagnostics: service doctor --json, then runtime doctor --json`;

/** Pure route mapping from argv to a dispatch target; performs no I/O. */
export function routeCommand(argv: string[]): Route {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...rest] = normalizedArgv;
  if (command === undefined) {
    return { kind: 'help' };
  }
  switch (command) {
    case 'help':
    case '-h':
    case '--help':
      return { kind: 'help' };
    case 'version':
    case '-v':
    case '--version':
      return { kind: 'version' };
    case 'service':
    case 'daemon':
      return { kind: 'foreman', args: ['daemon', ...rest] };
    case 'pet':
    case 'task':
    case 'taskgraph':
    case 'project':
    case 'message':
    case 'status':
      return { kind: 'foreman', args: [command, ...rest] };
    case 'update':
      // Public updates are release-based and never touch the internal Git
      // updater: the release updater drives the bundled installer.
      return { kind: 'update', args: rest };
    case 'runtime':
      return { kind: 'forge', args: rest };
    case 'desktop':
      return { kind: 'desktop', args: rest };
    case 'doctor':
      return { kind: 'doctor' };
    default:
      return { kind: 'unknown', command };
  }
}

/** True when the suite's release-manifest.json marks the tree as development. */
export function isDevelopmentSuite(suiteRoot: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(suiteRoot, 'release-manifest.json'), 'utf8'),
    ) as { release_status?: unknown };
    return manifest.release_status === 'development';
  } catch {
    return false;
  }
}

/** Locate the suite root from WRENYARD_ROOT, or via the src layout as a fallback. */
export function locateSuiteRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env.WRENYARD_ROOT === 'string' && env.WRENYARD_ROOT.length > 0) {
    return env.WRENYARD_ROOT;
  }
  // apps/cli/src/index.ts -> ../../.. is the suite root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function versionText(
  suiteRoot: string,
  suiteVersionOverride?: string,
  componentVersionsOverride?: Record<string, string>,
): string {
  let suiteVersion = 'unknown';
  if (suiteVersionOverride === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(suiteRoot, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      if (typeof pkg.version === 'string') {
        suiteVersion = pkg.version;
      }
    } catch {
      // No root package.json; report unknown.
    }
  } else {
    suiteVersion = suiteVersionOverride;
  }
  const lines = [`wrenyard ${suiteVersion}`];
  if (componentVersionsOverride !== undefined) {
    for (const [name, value] of Object.entries(componentVersionsOverride)) {
      lines.push(`${name}: ${String(value)}`);
    }
  } else {
    try {
      const versions = JSON.parse(
        readFileSync(resolve(suiteRoot, 'contracts', 'versions.json'), 'utf8'),
      ) as Record<string, unknown>;
      for (const [name, value] of Object.entries(versions)) {
        lines.push(`${name}: ${String(value)}`);
      }
    } catch {
      // No component versions file; the suite version alone is reported.
    }
  }
  return lines.join('\n');
}

function exitCode(result: SpawnResult): number {
  if (result.error !== undefined) {
    return 1;
  }
  return result.status === 0 ? 0 : 1;
}

function runForeman(args: string[], ctx: MainContext): number {
  // The internal service entry remains the canonical control; the root
  // `foreman` alias was removed. It is a .mts source file, so it is spawned
  // through the staged tsx CLI with the suite runtime node.
  const tsxCli = resolve(ctx.suiteRoot, 'services', 'foreman', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const control = resolve(ctx.suiteRoot, 'services', 'foreman', 'bin', 'foreman.mts');
  const result = ctx.runner(ctx.nodeExecutable, [tsxCli, control, ...args], RUN_OPTIONS);
  if (result.error) {
    ctx.stderr(`wrenyard: failed to spawn wrenyard service: ${result.error.message}`);
  }
  return exitCode(result);
}

function runForge(args: string[], ctx: MainContext): number {
  let binary: string | null = null;
  let reportedError: string | null = null;
  // WRENYARD_RUNTIME_BIN is the primary way to pin the runtime binary.
  const runtimeBin = ctx.env.WRENYARD_RUNTIME_BIN;
  if (typeof runtimeBin === 'string' && runtimeBin.length > 0) {
    binary = runtimeBin;
  } else {
    // Legacy read fallback: the pre-1.0 WRENYARD_FORGE_BIN override still wins
    // over on-disk discovery when set.
    const envBinary = ctx.env.WRENYARD_FORGE_BIN;
    if (typeof envBinary === 'string' && envBinary.length > 0) {
      binary = envBinary;
    } else {
      const adjacent = resolve(ctx.suiteRoot, 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge');
      if (existsSync(adjacent)) {
        binary = adjacent;
      }
    }
  }
  if (binary === null) {
    try {
      const resolved = ctx.resolver(ctx.env);
      binary = typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
    } catch (error) {
      binary = null;
      if (error instanceof RuntimeResolutionError) {
        reportedError = error.message;
        ctx.stderr(reportedError);
      }
    }
  }
  if (binary === null) {
    if (isDevelopmentSuite(ctx.suiteRoot)) {
      binary = 'forge';
    } else {
      if (reportedError === null) {
        ctx.stderr('Unable to locate the Forge binary.');
      }
      return 1;
    }
  }
  const result = ctx.runner(binary, args, RUN_OPTIONS);
  if (result.error) {
    ctx.stderr(`wrenyard: failed to spawn runtime: ${result.error.message}`);
  }
  return exitCode(result);
}

/** Resolve the Desktop launch target, or null when nothing can be launched. */
function resolveDesktop(ctx: MainContext): { command: string; args: string[] } | null {
  if (typeof ctx.desktopBin === 'string' && ctx.desktopBin.length > 0) {
    return { command: ctx.desktopBin, args: [] };
  }
  const envBinary = ctx.env.WRENYARD_DESKTOP_BIN;
  if (typeof envBinary === 'string' && envBinary.length > 0) {
    return { command: envBinary, args: [] };
  }
  // Known packaged desktop artifact inside the suite layout.
  const artifact = resolve(
    ctx.suiteRoot,
    'desktop',
    'dist',
    process.platform === 'win32' ? 'wrenyard-desktop.exe' : 'wrenyard-desktop',
  );
  if (existsSync(artifact)) {
    return { command: artifact, args: [] };
  }
  // Development layout: run the desktop sources with the workspace Electron.
  const electron = resolve(ctx.suiteRoot, 'node_modules', '.bin', 'electron');
  if (isDevelopmentSuite(ctx.suiteRoot) && existsSync(electron)) {
    return { command: electron, args: [resolve(ctx.suiteRoot, 'apps', 'desktop')] };
  }
  return null;
}

function runDesktop(args: string[], ctx: MainContext): number {
  const target = resolveDesktop(ctx);
  if (target === null) {
    ctx.stderr('Unable to locate the Desktop application.');
    return 1;
  }
  const result = ctx.runner(target.command, [...target.args, ...args], RUN_OPTIONS);
  if (result.error) {
    ctx.stderr(`wrenyard: failed to spawn Desktop application: ${result.error.message}`);
  }
  return exitCode(result);
}

/** `wrenyard update [--version V] [--json]`: release-based public updater. */
function runUpdateCommand(args: string[], ctx: MainContext): number {
  let parsed: { version?: string; json: boolean };
  try {
    parsed = parseUpdateArgs(args);
  } catch (error) {
    ctx.stderr(`wrenyard: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const outcome = runUpdate({
    suiteRoot: ctx.suiteRoot,
    version: parsed.version,
    env: ctx.env,
    // Adapt the main runner (which surfaces spawn errors) to the updater.
    runner: (command, commandArgs, options) => {
      const result = ctx.runner(command, commandArgs, options);
      return {
        status: result.status,
        error: result.error,
        stdout: result.stdout === undefined || result.stdout === null ? '' : String(result.stdout),
        stderr: result.stderr === undefined || result.stderr === null ? '' : String(result.stderr),
      };
    },
  });
  if (!outcome.ok) {
    ctx.stderr(outcome.installError ?? outcome.healthError ?? 'wrenyard update failed');
  }
  ctx.stdout(formatOutcome(outcome, parsed.json));
  return outcome.ok ? 0 : 1;
}

/** Unified CLI entry point; returns a numeric exit code and never touches the network. */
export function main(argv: string[] = process.argv.slice(2), options: MainOptions = {}): number {
  const env = options.env ?? process.env;
  const suiteRoot = options.suiteRoot ?? locateSuiteRoot(env);
  const ctx: MainContext = {
    runner: options.runner ?? ((command, args, opts) => spawnSync(command, args, opts)),
    stdout: options.stdout ?? ((text) => process.stdout.write(`${text}\n`)),
    stderr: options.stderr ?? ((text) => process.stderr.write(`${text}\n`)),
    env,
    suiteRoot,
    resolver:
      options.resolver ??
      ((resolverEnv: NodeJS.ProcessEnv) =>
        resolveForgeBinary({
          env: resolverEnv,
          allowPathFallback: isDevelopmentSuite(suiteRoot),
        })),
    nodeExecutable: options.nodeExecutable ?? process.execPath,
    desktopBin: options.desktopBin,
    suiteVersion: options.suiteVersion,
    componentVersions: options.componentVersions,
  };

  const route = routeCommand(argv);
  switch (route.kind) {
    case 'help':
      ctx.stdout(HELP_TEXT);
      return 0;
    case 'version':
      ctx.stdout(versionText(ctx.suiteRoot, ctx.suiteVersion, ctx.componentVersions));
      return 0;
    case 'foreman':
      return runForeman(route.args, ctx);
    case 'forge':
      return runForge(route.args, ctx);
    case 'desktop':
      return runDesktop(route.args, ctx);
    case 'update':
      return runUpdateCommand(route.args, ctx);
    case 'doctor': {
      const foremanStatus = runForeman(['doctor'], ctx);
      const forgeStatus = runForge(['doctor', '--json'], ctx);
      return foremanStatus !== 0 ? foremanStatus : forgeStatus;
    }
    case 'unknown':
      ctx.stderr(`Unknown command: ${route.command}`);
      ctx.stderr('Run "wrenyard help" for usage.');
      return 2;
  }
}

// Run only when this module is the entry point; importing it (e.g. from tests) is inert.
const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entryUrl !== undefined && entryUrl === import.meta.url) {
  process.exitCode = main();
}
