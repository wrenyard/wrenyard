import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { COMPONENTS } from './graph.mjs';
import { goBuildInvocation, pnpmInvocation, spawnArgv } from './spawn.mjs';
import { defaultRuntimeBin, runtimeGenerationBin, runtimeGenerationDir } from './paths.mjs';

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

export function needsGoBuild(components) {
  return components.includes(COMPONENTS.runtime);
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
  const artifacts = { runtimeBin: options.currentRuntimeBin };
  const logs = [];

  if (options.signal?.aborted) {
    return { ok: false, logs, error: 'build cancelled' };
  }

  if (needsSharedBuild(generation.components)) {
    const pnpm = pnpmInvocation(checkout, ['-r', '--filter', './packages/*', '--filter', './packages/features/*', '--if-present', 'run', 'build'], nodeExecutable, exists);
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

  if (needsGoBuild(generation.components)) {
    const outDir = runtimeGenerationDir(checkout, generation.id);
    mkdirSync(outDir, { recursive: true });
    const output = runtimeGenerationBin(checkout, generation.id, platform);
    const invocation = goBuildInvocation(checkout, output);
    const result = await run(invocation.command, invocation.args, { cwd: checkout, env: options.env, signal: options.signal, platform });
    logs.push(result.stderr || result.stdout);
    if (result.status !== 0) {
      return { ok: false, logs, error: `Go runtime build failed:\n${result.stderr || result.stdout}` };
    }
    artifacts.runtimeBin = output;
    artifacts.runtimeGeneration = generation.id;
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

export function cleanupRuntimeGeneration(checkout, generationId, inUse) {
  if (!generationId || inUse.has(generationId)) return;
  try {
    rmSync(runtimeGenerationDir(checkout, generationId), { recursive: true, force: true });
  } catch {
    // Windows may still have the exe mapped; keep it until the next idle cleanup.
  }
}
