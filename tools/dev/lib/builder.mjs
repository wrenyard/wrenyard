import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { COMPONENTS } from './graph.mjs';
import { pnpmInvocation, spawnArgv } from './spawn.mjs';

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ status: 1, stdout: '', stderr: 'cancelled', error: new Error('cancelled') });
      return;
    }
    const resolved = spawnArgv(command, args, options.platform ?? process.platform, options.env ?? process.env);
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: options.stdio ?? 'pipe',
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const finish = (status, error) => {
      options.signal?.removeEventListener?.('abort', onAbort);
      resolve({ status: status ?? 1, stdout, stderr, error });
    };
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may already have exited.
      }
    };
    options.signal?.addEventListener?.('abort', onAbort);
    child.on('error', (error) => finish(1, error));
    child.on('close', (status) => finish(status, undefined));
  });
}

export function desktopBuildArgs(targets, noClean = true) {
  const args = [join('apps', 'desktop', 'tools', 'build.mjs')];
  if (noClean) args.push('--no-clean');
  if (targets && targets.length > 0 && !targets.includes('all')) {
    args.push(`--only=${targets.join(',')}`);
  }
  return args;
}

/**
 * Every target `pnpm build` produces for the Desktop app. First startup uses
 * this list instead of depending on whatever a previous build happened to
 * leave behind.
 */
export const COMPONENT_BUILD_TARGETS = Object.freeze(['renderer', 'main', 'preload', 'pet']);

export function desktopTargetsFor(components) {
  const targets = [];
  if (components.includes(COMPONENTS.renderer)) targets.push('renderer');
  if (components.includes(COMPONENTS.desktopMain)) targets.push('main');
  if (components.includes(COMPONENTS.desktopPreload)) targets.push('preload');
  if (components.includes(COMPONENTS.pet) || components.includes(COMPONENTS.desktopMain)) targets.push('pet');
  return [...new Set(targets)];
}

export function needsPetBuild(components) {
  return components.includes(COMPONENTS.pet) || components.includes(COMPONENTS.shared);
}

export function needsSharedBuild(components) {
  return components.includes(COMPONENTS.shared);
}

export async function buildGeneration(options) {
  const {
    checkout,
    generation,
    nodeExecutable = process.execPath,
    platform = process.platform,
    run = runCommand,
    exists,
  } = options;
  const artifacts = {};
  const logs = [];

  if (options.signal?.aborted) {
    return { ok: false, logs, error: 'build cancelled' };
  }

  if (needsSharedBuild(generation.components)) {
    const pnpm = pnpmInvocation(checkout, ['-r', '--filter', './packages/*', '--filter', './packages/features/*', '--filter', './packages/clients/*', '--if-present', 'run', 'build'], nodeExecutable, exists);
    const result = await run(pnpm.command, pnpm.args, { cwd: checkout, env: options.env, signal: options.signal, platform });
    logs.push(result.stderr || result.stdout);
    if (result.status !== 0) {
      return { ok: false, logs, error: `shared package build failed:\n${result.stderr || result.stdout}` };
    }
  }

  if (needsPetBuild(generation.components)) {
    const pnpm = pnpmInvocation(checkout, ['--filter', '@wrenyard/pet', 'run', 'build'], nodeExecutable, exists);
    const result = await run(pnpm.command, pnpm.args, { cwd: checkout, env: options.env, signal: options.signal, platform });
    logs.push(result.stderr || result.stdout);
    if (result.status !== 0) {
      return { ok: false, logs, error: `pet build failed:\n${result.stderr || result.stdout}` };
    }
  }

  const desktopTargets = desktopTargetsFor(generation.components);
  if (desktopTargets.length > 0 || generation.components.includes(COMPONENTS.shared)) {
    const args = desktopBuildArgs(desktopTargets.length > 0 ? desktopTargets : ['main', 'preload', 'renderer', 'pet']);
    const result = await run(nodeExecutable, args, { cwd: checkout, env: options.env, signal: options.signal, platform });
    logs.push(result.stderr || result.stdout);
    if (result.status !== 0) {
      return { ok: false, logs, error: `desktop build failed:\n${result.stderr || result.stdout}` };
    }
  }

  if (options.signal?.aborted) {
    return { ok: false, logs, error: 'build cancelled' };
  }

  return { ok: true, logs, artifacts, generation };
}

export function checkToolchain(options) {
  const { checkout, nodeVersion = process.versions.node } = options;
  const exists = options.exists ?? existsSync;
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
  const { checkout, exists = existsSync } = options;
  const errors = [];
  const desktopMain = join(checkout, 'apps', 'desktop', 'dist', 'main.js');
  if (!exists(desktopMain)) {
    errors.push('Desktop dist is missing. Run: pnpm build');
  }
  const electronCli = [
    join(checkout, 'apps', 'desktop', 'node_modules', 'electron', 'cli.js'),
    join(checkout, 'node_modules', 'electron', 'cli.js'),
  ].some((candidate) => exists(candidate));
  if (!electronCli) {
    errors.push('Electron was not installed. Re-run pnpm install --frozen-lockfile; pnpm-workspace.yaml already allows the electron build script.');
  }
  return { errors };
}
