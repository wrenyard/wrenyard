import { copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultRuntimeBin } from './paths.mjs';

export function checkToolchain(options) {
  const { checkout, platform = process.platform, exists = existsSync, nodeVersion = process.versions.node } = options;
  const errors = [];
  const [major, minor, patch] = nodeVersion.split('.').map((part) => Number(part));
  if (major < 22 || (major === 22 && (minor < 19 || (minor === 19 && patch < 0)))) {
    errors.push(`Node ${nodeVersion} is too old; package.json requires >=22.19.0`);
  }
  if (!exists(join(checkout, 'node_modules'))) {
    errors.push('node_modules is missing. Run: pnpm install --frozen-lockfile');
  }
  if (!exists(join(checkout, 'pnpm-lock.yaml'))) {
    errors.push('pnpm-lock.yaml is missing from this checkout.');
  }
  return errors;
}

export function checkBuildArtifacts(options) {
  const { checkout, platform = process.platform, exists = existsSync, stat = statSync } = options;
  const errors = [];
  const desktopMain = join(checkout, 'apps', 'desktop', 'dist', 'main.js');
  if (!exists(desktopMain)) {
    errors.push('Desktop dist is missing. Run: pnpm build');
  }
  let runtime = defaultRuntimeBin(checkout, platform, exists);
  if (platform === 'win32' && runtime && !runtime.toLowerCase().endsWith('.exe')) {
    const exe = join(dirname(runtime), 'forge.exe');
    try {
      (options.copyFile ?? copyFileSync)(runtime, exe);
      runtime = exe;
    } catch (error) {
      errors.push(`Go runtime binary is missing a .exe suffix and could not be copied to forge.exe: ${error instanceof Error ? error.message : String(error)}`);
      runtime = undefined;
    }
  }
  if (!runtime) {
    errors.push(platform === 'win32'
      ? 'Go runtime binary (.exe) is missing. Run: pnpm build'
      : 'Go runtime binary is missing. Run: pnpm build');
  } else {
    try {
      if (!options.copyFile && !stat(runtime).isFile()) {
        errors.push(`Runtime path is not a file: ${runtime}`);
      }
    } catch {
      if (!options.copyFile) errors.push(`Runtime path is not a file: ${runtime}`);
    }
  }
  const electronCli = [
    join(checkout, 'apps', 'desktop', 'node_modules', 'electron', 'cli.js'),
    join(checkout, 'node_modules', 'electron', 'cli.js'),
  ].some((candidate) => exists(candidate));
  if (!electronCli) {
    errors.push('Electron was not installed. Re-run pnpm install --frozen-lockfile; pnpm-workspace.yaml already allows the electron build script.');
  }
  return { errors, runtimeBin: runtime };
}

export function prepareError(errors) {
  return new Error(errors.join('\n'));
}
