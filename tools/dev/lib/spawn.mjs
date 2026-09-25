import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s&<>|^()"]/u.test(text)) return text;
  return `"${text.replace(/"/gu, '\\"')}"`;
}

/** Convert a .cmd/.bat invocation into `cmd.exe /d /s /c ...` argv (never shell:true). */
function windowsCmdInvocation(command, args) {
  const line = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] };
}

/** Resolve a spawn argv Node can execute with shell:false; .cmd/.bat go via ComSpec. */
export function spawnArgv(command, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command)) return windowsCmdInvocation(command, args);
  return { command, args };
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/** The real Electron executable (not the `node cli.js` wrapper); null when not installed. */
function resolveElectronExecutable(checkout) {
  const binaryName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const distCandidates = process.platform === 'darwin'
    ? ['Electron.app/Contents/MacOS/Electron', binaryName]
    : [binaryName];
  for (const packageDir of [join(checkout, 'apps', 'desktop', 'node_modules', 'electron'), join(checkout, 'node_modules', 'electron')]) {
    const pathTxt = join(packageDir, 'dist', 'path.txt');
    if (existsSync(pathTxt)) {
      try {
        const relative = String(readFileSync(pathTxt, 'utf8') ?? '').trim();
        if (relative && existsSync(join(packageDir, 'dist', relative))) return join(packageDir, 'dist', relative);
      } catch { /* fall through to the conventional dist paths */ }
    }
    for (const name of distCandidates) {
      const binary = join(packageDir, 'dist', name);
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

/**
 * Desktop invocation for source development. Ownership must track the real
 * Electron main process, so a resolvable platform Electron binary is required:
 * the `node cli.js` wrapper spawns Electron as a grandchild and would leave the
 * supervisor owning the wrong PID.
 */
export function electronDesktopInvocation(checkout) {
  const appPath = join(checkout, 'apps', 'desktop');
  const binary = resolveElectronExecutable(checkout);
  if (!binary) {
    throw new Error(`Electron executable was not found for ${process.platform}. Run pnpm install --frozen-lockfile in the checkout root so apps/desktop/node_modules/electron/dist is populated.`);
  }
  return { command: binary, args: [appPath], cwd: appPath, direct: true };
}

export function pnpmInvocation(checkout, pnpmArgs) {
  const pnpmCli = firstExisting([
    join(checkout, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(checkout, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ]);
  if (!pnpmCli) throw new Error('pnpm was not found under node_modules. Run pnpm install --frozen-lockfile in the checkout root.');
  return { command: process.execPath, args: [pnpmCli, ...pnpmArgs], cwd: checkout };
}

function tsxLoaderInvocation(checkout, entry, extraArgs = []) {
  const tsxRoot = firstExisting([
    join(checkout, 'node_modules', 'tsx'),
    join(checkout, 'apps', 'daemon', 'node_modules', 'tsx'),
    join(checkout, 'apps', 'cli', 'node_modules', 'tsx'),
  ]);
  if (!tsxRoot) throw new Error('tsx was not found. Run pnpm install --frozen-lockfile in the checkout root.');
  const preflightPath = join(tsxRoot, 'dist', 'preflight.cjs');
  const loaderPath = join(tsxRoot, 'dist', 'loader.mjs');
  if (!existsSync(preflightPath) || !existsSync(loaderPath)) {
    throw new Error('Local tsx loader files were not found. Run pnpm install --frozen-lockfile in the checkout root.');
  }
  return {
    command: process.execPath,
    args: ['--require', preflightPath, '--import', pathToFileURL(loaderPath).href, entry, ...extraArgs],
    cwd: checkout,
  };
}

export function sourceCliInvocation(checkout, cliArgs = []) {
  const tsxCli = firstExisting([
    join(checkout, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(checkout, 'apps', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(checkout, 'apps', 'daemon', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ]);
  const cliSource = join(checkout, 'apps', 'cli', 'src', 'index.ts');
  if (!tsxCli || !existsSync(cliSource)) {
    throw new Error('Source CLI entry was not found. Run pnpm install --frozen-lockfile in the checkout root.');
  }
  return { command: process.execPath, args: [tsxCli, cliSource, ...cliArgs], cwd: checkout };
}

export function daemonInvocation(checkout, configPath, extraArgs = []) {
  const entry = join(checkout, 'apps', 'daemon', 'bin', 'daemon.mts');
  if (!existsSync(entry)) throw new Error(`Daemon entry missing: ${entry}`);
  const invocation = tsxLoaderInvocation(checkout, entry, ['--config', configPath, ...extraArgs]);
  invocation.cwd = join(checkout, 'apps', 'daemon');
  return invocation;
}
