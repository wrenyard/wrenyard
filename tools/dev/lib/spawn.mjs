import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

/**
 * Quote one Windows cmd.exe argument without concatenating a shell script.
 * Used only when the target really is a .cmd/.bat and must be invoked via ComSpec.
 */
export function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s&<>|^()"]/u.test(text)) return text;
  return `"${text.replace(/"/gu, '\\"')}"`;
}

/**
 * Convert a .cmd/.bat invocation into `cmd.exe /d /s /c ...` argv.
 * Callers must still pass command + args separately; this never uses shell:true.
 */
export function windowsCmdInvocation(command, args, comspec = process.env.ComSpec || 'cmd.exe') {
  const line = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ');
  return { command: comspec, args: ['/d', '/s', '/c', line] };
}

export function needsWindowsCmdWrapper(command, platform = process.platform) {
  if (platform !== 'win32') return false;
  return /\.(cmd|bat)$/iu.test(command);
}

/**
 * Resolve a spawn argv that Node can execute with shell:false.
 * .cmd/.bat files are wrapped through ComSpec; everything else is left intact.
 */
export function spawnArgv(command, args, platform = process.platform, env = process.env) {
  if (needsWindowsCmdWrapper(command, platform)) {
    return windowsCmdInvocation(command, args, env.ComSpec || 'cmd.exe');
  }
  return { command, args };
}

export function firstExisting(candidates, exists = existsSync) {
  return candidates.find((candidate) => candidate && exists(candidate));
}

export function electronInvocation(checkout, nodeExecutable = process.execPath, exists = existsSync) {
  const electronCli = firstExisting([
    join(checkout, 'apps', 'desktop', 'node_modules', 'electron', 'cli.js'),
    join(checkout, 'node_modules', 'electron', 'cli.js'),
  ], exists);
  if (!electronCli) {
    throw new Error('Electron CLI was not found. Run pnpm install --frozen-lockfile in the checkout root.');
  }
  return {
    command: nodeExecutable,
    args: [electronCli, join(checkout, 'apps', 'desktop')],
    cwd: join(checkout, 'apps', 'desktop'),
  };
}

export function pnpmInvocation(checkout, pnpmArgs, nodeExecutable = process.execPath, exists = existsSync) {
  const pnpmCli = firstExisting([
    join(checkout, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(checkout, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ], exists);
  if (!pnpmCli) {
    throw new Error('pnpm was not found under node_modules. Run pnpm install --frozen-lockfile in the checkout root.');
  }
  return { command: nodeExecutable, args: [pnpmCli, ...pnpmArgs], cwd: checkout };
}

export function tsxLoaderInvocation(checkout, entry, extraArgs = [], nodeExecutable = process.execPath, exists = existsSync) {
  const tsxRoot = firstExisting([
    join(checkout, 'node_modules', 'tsx'),
    join(checkout, 'services', 'foreman', 'node_modules', 'tsx'),
  ], exists);
  if (!tsxRoot) {
    throw new Error('tsx was not found. Run pnpm install --frozen-lockfile in the checkout root.');
  }
  const preflightPath = join(tsxRoot, 'dist', 'preflight.cjs');
  const loaderPath = join(tsxRoot, 'dist', 'loader.mjs');
  if (!exists(preflightPath) || !exists(loaderPath)) {
    throw new Error('Local tsx loader files were not found. Run pnpm install --frozen-lockfile in the checkout root.');
  }
  return {
    command: nodeExecutable,
    args: ['--require', preflightPath, '--import', pathToFileURL(loaderPath).href, entry, ...extraArgs],
    cwd: checkout,
  };
}

export function sourceCliInvocation(checkout, cliArgs = [], nodeExecutable = process.execPath, exists = existsSync) {
  const tsxCli = firstExisting([
    join(checkout, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(checkout, 'services', 'foreman', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ], exists);
  const cliSource = join(checkout, 'apps', 'cli', 'src', 'index.ts');
  if (!tsxCli || !exists(cliSource)) {
    throw new Error('Source CLI entry was not found. Run pnpm install --frozen-lockfile in the checkout root.');
  }
  return {
    command: nodeExecutable,
    args: [tsxCli, cliSource, ...cliArgs],
    cwd: checkout,
  };
}

export function daemonInvocation(checkout, configPath, extraArgs = [], nodeExecutable = process.execPath, exists = existsSync) {
  const entry = join(checkout, 'services', 'foreman', 'bin', 'foreman-deamon.mts');
  if (!exists(entry)) {
    throw new Error(`Daemon entry missing: ${entry}`);
  }
  const invocation = tsxLoaderInvocation(checkout, entry, ['--config', configPath, ...extraArgs], nodeExecutable, exists);
  invocation.cwd = join(checkout, 'services', 'foreman');
  return invocation;
}

export function goBuildInvocation(checkout, outputPath) {
  return {
    command: 'go',
    args: ['-C', join(checkout, 'runtime', 'forge'), 'build', '-o', outputPath, './cmd/forge'],
    cwd: checkout,
  };
}

/**
 * Spawn a child with shell:false. Windows .cmd is wrapped explicitly.
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnManaged(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const resolved = spawnArgv(command, args, platform, options.env ?? process.env);
  return spawn(resolved.command, resolved.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'pipe',
    windowsHide: true,
    shell: false,
    detached: options.detached === true,
  });
}

export function resolveCheckoutFile(checkout, relativePath) {
  return resolve(checkout, relativePath);
}
