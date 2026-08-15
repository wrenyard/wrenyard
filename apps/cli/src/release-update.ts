import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Public, release-based updater for `wrenyard update`.
 *
 * It locates the bundled install.sh/install.ps1 (falling back to the source
 * scripts only for a local development checkout), invokes the installer with
 * `--update` plus an optional `--version`, and never runs git, pnpm, go or any
 * source build on the consumer machine. When the service was running it
 * restarts the installed Wrenyard and health-checks it; on install or health
 * failure the previous `current` target is restored and restarted.
 */

export interface UpdateSpawnResult {
  status: number | null;
  error?: Error;
  stdout: string;
  stderr: string;
}

export type UpdateRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => UpdateSpawnResult;

export interface UpdateOptions {
  suiteRoot?: string;
  prefix?: string;
  launcher?: string;
  version?: string;
  runner?: UpdateRunner;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export interface UpdateOutcome {
  ok: boolean;
  version?: string;
  previous?: string;
  rolledBack: boolean;
  installError?: string;
  healthError?: string;
}

const RUN_OPTIONS: SpawnSyncOptions = { shell: false, stdio: ['ignore', 'pipe', 'pipe'] };

function isWinFor(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

function defaultRunner(): UpdateRunner {
  return (command, args, options) => {
    const result = spawnSync(command, args, { encoding: 'utf8', ...RUN_OPTIONS, ...options });
    return {
      status: result.status,
      error: result.error,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  };
}

function suiteRootOf(options: UpdateOptions, env: NodeJS.ProcessEnv): string {
  if (typeof options.suiteRoot === 'string' && options.suiteRoot.length > 0) return options.suiteRoot;
  if (typeof env.WRENYARD_ROOT === 'string' && env.WRENYARD_ROOT.length > 0) return env.WRENYARD_ROOT;
  // apps/cli/src/release-update.ts -> ../../.. is the suite root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function defaultPrefix(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (typeof env.WRENYARD_PREFIX === 'string' && env.WRENYARD_PREFIX.length > 0) return env.WRENYARD_PREFIX;
  if (isWinFor(platform)) return join(env.LOCALAPPDATA ?? '', 'wrenyard');
  return join(env.HOME ?? '', '.local', 'share', 'wrenyard');
}

function resolveLauncher(prefix: string, platform: NodeJS.Platform): string {
  const exe = isWinFor(platform) ? 'wrenyard.cmd' : 'wrenyard';
  const bin = join(prefix, 'bin', exe);
  if (existsSync(bin)) return bin;
  const current = join(prefix, 'current', isWinFor(platform) ? 'wrenyard.exe' : 'wrenyard');
  return existsSync(current) ? current : bin;
}

/** Bundled installer at the suite root; source scripts only as a dev fallback. */
function locateInstaller(suiteRoot: string, platform: NodeJS.Platform): string | null {
  const name = isWinFor(platform) ? 'install.ps1' : 'install.sh';
  const bundled = join(suiteRoot, name);
  if (existsSync(bundled)) return bundled;
  const source = join(suiteRoot, 'scripts', name);
  if (existsSync(source)) return source;
  return null;
}

function installerArgs(script: string, version: string | undefined): string[] {
  if (script.endsWith('.ps1')) {
    const args = ['-NoProfile', '-File', script, '-Update'];
    if (version !== undefined) args.push('-Version', version);
    return args;
  }
  const args = [script, '--update'];
  if (version !== undefined) args.push('--version', version);
  return args;
}

/** Redact GitHub tokens from any diagnostic text captured from child processes. */
function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      out = out.split(value).join('***');
    }
  }
  return out;
}

function readCurrent(currentPath: string): string | null {
  try {
    return readlinkSync(currentPath);
  } catch {
    return null;
  }
}

function succeeded(result: UpdateSpawnResult): boolean {
  return result.error === undefined && result.status === 0;
}

function serviceRunning(
  launcher: string,
  runner: UpdateRunner,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!existsSync(launcher)) return false;
  return succeeded(runner(launcher, ['service', 'status'], { env }));
}

function restartAndHealthCheck(
  launcher: string,
  runner: UpdateRunner,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!succeeded(runner(launcher, ['service', 'restart'], { env }))) return false;
  return succeeded(runner(launcher, ['service', 'status'], { env }));
}

function restoreCurrent(
  previous: string,
  prefix: string,
  runner: UpdateRunner,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const current = join(prefix, 'current');
  if (isWinFor(platform)) {
    // A relative previous target must be resolved against the prefix so the
    // recreated junction points at an absolute path on the Windows box.
    const target = resolve(prefix, previous);
    const command = [
      '-NoProfile',
      '-Command',
      `$p = '${current}'; ` +
        `if (Test-Path -LiteralPath $p) { ` +
        `  $i = Get-Item -Force -LiteralPath $p; ` +
        `  if ($i.LinkType -eq 'SymbolicLink') { Remove-Item -LiteralPath $p -Force } ` +
        `  elseif ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { [System.IO.Directory]::Delete($p) } ` +
        `  else { Remove-Item -LiteralPath $p -Force -Recurse } ` +
        `}; ` +
        `New-Item -ItemType Junction -Path $p -Target '${target}' -Force | Out-Null`,
    ];
    return succeeded(runner('powershell.exe', command, { env }));
  }
  return succeeded(runner('ln', ['-sfn', previous, current], { env }));
}

export function runUpdate(options: UpdateOptions = {}): UpdateOutcome {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner();
  const suiteRoot = suiteRootOf(options, env);
  const prefix = options.prefix ?? defaultPrefix(env, platform);
  const launcher = options.launcher ?? resolveLauncher(prefix, platform);

  const script = locateInstaller(suiteRoot, platform);
  if (script === null) {
    const installError =
      'wrenyard update requires an installed release: no bundled installer found';
    return { ok: false, rolledBack: false, installError };
  }

  const wasRunning = serviceRunning(launcher, runner, env);
  const current = join(prefix, 'current');
  const previous = readCurrent(current);

  // Only the packaged installer is ever invoked; never git/pnpm/go or a source
  // build. The token-carrying environment is inherited so private releases work.
  const result = runner(
    isWinFor(platform) ? 'powershell.exe' : 'bash',
    installerArgs(script, options.version),
    { env: { ...env, WRENYARD_UPDATE: '1' } },
  );

  if (!succeeded(result)) {
    const detail = redact(`${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim(), env);
    const installError =
      `wrenyard update failed (installer exited ${result.status ?? result.error?.message ?? 'unknown'}): ${detail || 'no installer output'}`;
    const rolledBack =
      previous !== null && restoreCurrent(previous, prefix, runner, env, platform);
    if (rolledBack && wasRunning) restartAndHealthCheck(launcher, runner, env);
    return { ok: false, previous: previous ?? undefined, rolledBack, installError };
  }

  if (wasRunning) {
    if (!restartAndHealthCheck(launcher, runner, env)) {
      let healthError =
        'wrenyard update installed but the restarted service failed its health check';
      const rolledBack =
        previous !== null && restoreCurrent(previous, prefix, runner, env, platform);
      if (rolledBack) {
        healthError += `; restored previous version ${previous}`;
        restartAndHealthCheck(launcher, runner, env);
      }
      return { ok: false, previous: previous ?? undefined, rolledBack, healthError };
    }
  }

  return { ok: true, version: options.version, previous: previous ?? undefined, rolledBack: false };
}

export function parseUpdateArgs(args: string[]): { version?: string; json: boolean } {
  let version: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--version' || arg === '-V') {
      const value = args[index + 1];
      if (value === undefined) throw new Error('--version requires a value');
      version = value;
      index += 1;
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length);
    } else {
      throw new Error(`unknown update argument: ${arg}`);
    }
  }
  return { version, json };
}

export function formatOutcome(outcome: UpdateOutcome, json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        ok: outcome.ok,
        version: outcome.version ?? null,
        previous: outcome.previous ?? null,
        rolledBack: outcome.rolledBack,
        error: outcome.installError ?? outcome.healthError ?? null,
      },
      null,
      2,
    );
  }
  if (outcome.ok) {
    return `wrenyard updated${outcome.version ? ` to ${outcome.version}` : ''}`;
  }
  return outcome.healthError ?? outcome.installError ?? 'wrenyard update failed';
}
