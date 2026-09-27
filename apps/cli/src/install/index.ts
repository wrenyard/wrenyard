/** `wrenyard install` / `wrenyard update` command surface (spec section 5.1). */

import type { CommandRunner } from './platform.js';
import type { ControlBridge, EngineOutcome, InstallEngineOptions } from './engine.js';
import { runInstallEngine } from './engine.js';
import type { FetchLike } from './download.js';

export const INSTALL_USAGE = `Usage:
  wrenyard install [--version <v>] [--suite-zip <path>] [--artifacts <dir>]
                   [--prefix <dir>] [--bin-dir <dir>] [--no-desktop] [--json]
  wrenyard update  [--version <v>] [--no-desktop] [--wait-pid <pid>]
                   [--relaunch-desktop] [--result-file <path>] [--json]`;

export interface ParsedEngineArgs {
  help: boolean;
  json: boolean;
  version?: string;
  suiteZip?: string;
  artifactsDir?: string;
  prefix?: string;
  binDir?: string;
  noDesktop: boolean;
  waitPid?: number;
  relaunchDesktop: boolean;
  resultFile?: string;
}

function takeValue(argv: string[], index: number, flag: string): { value: string; next: number } {
  const inline = argv[index];
  const eq = inline.indexOf('=');
  if (eq !== -1) {
    return { value: inline.slice(eq + 1), next: index + 1 };
  }
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return { value, next: index + 2 };
}

/** Parse install/update flags into engine options. */
export function parseEngineArgs(argv: string[], mode: 'install' | 'update'): ParsedEngineArgs {
  const parsed: ParsedEngineArgs = {
    help: false,
    json: false,
    noDesktop: false,
    relaunchDesktop: false,
  };
  for (let index = 0; index < argv.length; ) {
    const arg = argv[index] as string;
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      index += 1;
    } else if (arg === '--json') {
      parsed.json = true;
      index += 1;
    } else if (arg === '--no-desktop') {
      parsed.noDesktop = true;
      index += 1;
    } else if (arg === '--relaunch-desktop') {
      parsed.relaunchDesktop = true;
      index += 1;
    } else if (arg === '--version' || arg === '-V' || arg.startsWith('--version=')) {
      const { value, next } = takeValue(argv, index, '--version');
      parsed.version = value;
      index = next;
    } else if (arg === '--suite-zip' || arg.startsWith('--suite-zip=')) {
      const { value, next } = takeValue(argv, index, '--suite-zip');
      parsed.suiteZip = value;
      index = next;
    } else if (arg === '--artifacts' || arg.startsWith('--artifacts=')) {
      const { value, next } = takeValue(argv, index, '--artifacts');
      parsed.artifactsDir = value;
      index = next;
    } else if (arg === '--prefix' || arg.startsWith('--prefix=')) {
      const { value, next } = takeValue(argv, index, '--prefix');
      parsed.prefix = value;
      index = next;
    } else if (arg === '--bin-dir' || arg.startsWith('--bin-dir=')) {
      const { value, next } = takeValue(argv, index, '--bin-dir');
      parsed.binDir = value;
      index = next;
    } else if (arg === '--wait-pid' || arg.startsWith('--wait-pid=')) {
      const { value, next } = takeValue(argv, index, '--wait-pid');
      const pid = Number(value);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('--wait-pid requires a positive integer');
      parsed.waitPid = pid;
      index = next;
    } else if (arg === '--result-file' || arg.startsWith('--result-file=')) {
      const { value, next } = takeValue(argv, index, '--result-file');
      parsed.resultFile = value;
      index = next;
    } else {
      throw new Error(`unknown ${mode} argument: ${arg}`);
    }
  }
  if (mode === 'update' && parsed.suiteZip !== undefined) {
    throw new Error('--suite-zip is only valid for install');
  }
  if (mode === 'update' && parsed.artifactsDir !== undefined) {
    throw new Error('--artifacts is only valid for install');
  }
  return parsed;
}

/** Everything the engine needs that the caller (tests, SEA entry) supplies. */
export interface InstallCommandContext {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
  runner?: CommandRunner;
  fetchImpl?: FetchLike;
  control?: ControlBridge;
  now?: () => number;
  pid?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  log?: (line: string) => void;
  installSignalHandlers?: boolean;
}

function engineOptions(
  parsed: ParsedEngineArgs,
  ctx: InstallCommandContext,
  mode: 'install' | 'update',
): InstallEngineOptions {
  return {
    ...parsed,
    mode,
    env: ctx.env,
    platform: ctx.platform,
    arch: ctx.arch,
    execPath: ctx.execPath,
    runner: ctx.runner,
    fetchImpl: ctx.fetchImpl,
    control: ctx.control,
    now: ctx.now,
    pid: ctx.pid,
    log: ctx.log,
    installSignalHandlers: ctx.installSignalHandlers,
  };
}

/** Renders an engine outcome for the CLI: JSON when asked, else one line. */
export function formatEngineOutcome(outcome: EngineOutcome, json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        status: outcome.status,
        from: outcome.from ?? null,
        to: outcome.to ?? null,
        rolled_back: outcome.rolledBack,
        message: outcome.message ?? null,
      },
      null,
      2,
    );
  }
  if (outcome.status === 'ok') return `wrenyard updated to ${outcome.to}`;
  if (outcome.status === 'up-to-date') return `wrenyard is already at ${outcome.to}`;
  return outcome.message ?? 'wrenyard install/update failed';
}

async function runCommand(
  argv: string[],
  ctx: InstallCommandContext,
  mode: 'install' | 'update',
): Promise<number> {
  const stdout = ctx.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const stderr = ctx.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  let parsed: ParsedEngineArgs;
  try {
    parsed = parseEngineArgs(argv, mode);
  } catch (error) {
    stderr(`wrenyard: ${(error as Error).message}`);
    return 2;
  }
  if (parsed.help) {
    stdout(INSTALL_USAGE);
    return 0;
  }
  const outcome = await runInstallEngine(engineOptions(parsed, ctx, mode));
  if (!outcome.ok) {
    stderr(outcome.message ?? 'wrenyard install/update failed');
  }
  stdout(formatEngineOutcome(outcome, parsed.json));
  return outcome.ok ? 0 : 1;
}

/** `wrenyard install [...]`: fresh/repeat install, including local artifacts. */
export function runInstallCommand(argv: string[], ctx: InstallCommandContext = {}): Promise<number> {
  return runCommand(argv, ctx, 'install');
}

/** `wrenyard update [...]`: update an installed suite and Desktop in place. */
export function runUpdateEngineCommand(
  argv: string[],
  ctx: InstallCommandContext = {},
): Promise<number> {
  return runCommand(argv, ctx, 'update');
}
