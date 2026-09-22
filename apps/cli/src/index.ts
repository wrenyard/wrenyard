import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatOutcome, parseUpdateArgs, runUpdate } from './release-update.js';

/** Subcommands of the legacy `foreman` binary routed through the unified CLI. */
export type ForemanCommand =
  | 'service'
  | 'task'
  | 'exec'
  | 'taskgraph'
  | 'project'
  | 'message'
  | 'quota'
  | 'status'
  | 'update';

/** Parsed dispatch target for a CLI command line. */
export type Route =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'foreman'; args: string[] }
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


/** Options injectable from tests; every field falls back to production behavior. */
export interface MainOptions {
  runner?: Runner;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  suiteRoot?: string;
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
  nodeExecutable: string;
  desktopBin?: string;
  suiteVersion?: string;
  componentVersions?: Record<string, string>;
}

const RUN_OPTIONS: SpawnSyncOptions = { shell: false, stdio: 'inherit', windowsHide: true };

const HELP_TEXT = `Wrenyard - one CLI for the whole development suite

Usage: wrenyard <command> [args...]

Commands:
  help, -h, --help        Show this help
  version, -v, --version  Show the suite version and component versions
  service <command>       Control the wrenyard service
  task, taskgraph,        Development suite commands
  project, message,
  status
  quota [provider] [--json]  Query provider quotas
  exec [options] <prompt> Execute a prompt through the daemon
  update [--version V]    Update from the latest release; --json for machine output
  desktop                 Launch the wrenyard Desktop application
  doctor                  Diagnose the Wrenyard service`;

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
    case 'task':
    case 'exec':
    case 'taskgraph':
    case 'project':
    case 'message':
    case 'quota':
    case 'status':
      return { kind: 'foreman', args: [command, ...rest] };
    case 'update':
      // Public updates are release-based and never touch the internal Git
      // updater: the release updater drives the bundled installer.
      return { kind: 'update', args: rest };
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
  // The internal control is this CLI's own command implementation. It is a
  // .mts source tree that imports the daemon through its published subpaths,
  // so it is spawned through the CLI's staged tsx loader with the suite
  // runtime node rather than being bundled into the product entry.
  const cliRoot = resolve(ctx.suiteRoot, 'apps', 'cli');
  const tsxCli = [
    resolve(cliRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    resolve(ctx.suiteRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ].find((candidate) => existsSync(candidate));
  if (tsxCli === undefined) {
    ctx.stderr('Unable to locate the staged tsx loader for the Wrenyard CLI.');
    return 1;
  }
  const control = resolve(cliRoot, 'src', 'index.mts');
  const result = ctx.runner(ctx.nodeExecutable, [tsxCli, control, ...args], RUN_OPTIONS);
  if (result.error) {
    ctx.stderr(`wrenyard: failed to spawn wrenyard service: ${result.error.message}`);
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
  // Development layout: run Electron's official CLI JS with Node so the same
  // spawn works on every platform (no .bin shell shim, no shell:true). pnpm
  // places electron under apps/desktop/node_modules; fall back to the root.
  if (isDevelopmentSuite(ctx.suiteRoot)) {
    const electronCli = [
      resolve(ctx.suiteRoot, 'apps', 'desktop', 'node_modules', 'electron', 'cli.js'),
      resolve(ctx.suiteRoot, 'node_modules', 'electron', 'cli.js'),
    ].find((candidate) => existsSync(candidate));
    if (electronCli !== undefined) {
      return {
        command: ctx.nodeExecutable,
        args: [electronCli, resolve(ctx.suiteRoot, 'apps', 'desktop')],
      };
    }
  }
  // Canonical installed layout used by the official installers.
  const artifact =
    process.platform === 'win32'
      ? join(
          ctx.env.LOCALAPPDATA ?? join(ctx.env.USERPROFILE ?? homedir(), 'AppData', 'Local'),
          'Programs',
          'Wrenyard Desktop',
          'wrenyard-desktop.exe',
        )
      : join(ctx.env.HOME ?? homedir(), 'Applications', '啾啾工坊.app', 'Contents', 'MacOS', '啾啾工坊');
  if (existsSync(artifact)) {
    return { command: artifact, args: [] };
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

/** `wrenyard update [--version V] [--json]`: suite-only release updater. */
function runUpdateCommand(args: string[], ctx: MainContext): number {
  let parsed: { version?: string; json: boolean; suiteOnly: boolean };
  try {
    parsed = parseUpdateArgs(args);
  } catch (error) {
    ctx.stderr(`wrenyard: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const outcome = runUpdate({
    suiteRoot: ctx.suiteRoot,
    version: parsed.version,
    // Desktop owns its own atomic replacement. The CLI updater always changes
    // only the suite; the raw one-click installers bootstrap both products.
    suiteOnly: true,
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
    case 'desktop':
      return runDesktop(route.args, ctx);
    case 'update':
      return runUpdateCommand(route.args, ctx);
    case 'doctor': {
      return runForeman(['doctor'], ctx);
    }
    case 'unknown':
      ctx.stderr(`Unknown command: ${route.command}`);
      ctx.stderr('Run "wrenyard help" for usage.');
      return 2;
  }
}

// Entry identity must survive path respelling: the module resolver canonicalizes
// `import.meta.url` (resolving symlinks, so a staged entry under macOS
// /var/folders is reported as /private/var/folders) while `process.argv[1]` keeps
// the spelling the caller passed, so comparing the two file URLs alone silently
// skipped main() and exited 0 with no output.
function canonicalPath(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/** True when `entry` names the module at `moduleUrl`, in whichever spelling the caller used. */
export function isEntryPoint(entry: string | undefined, moduleUrl: string | undefined): boolean {
  // The SEA bundle is CommonJS; its explicit launcher calls main instead.
  if (!entry || !moduleUrl) return false;
  const self = fileURLToPath(moduleUrl);
  const selfReal = canonicalPath(self) ?? self;
  const entryReal = canonicalPath(entry) ?? entry;
  return entry === self || entry === selfReal || entryReal === self || entryReal === selfReal;
}

// Run only when this module is the entry point; importing it (e.g. from tests) is inert.
if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
