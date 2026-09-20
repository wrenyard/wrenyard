import { mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { COMPONENTS } from './graph.mjs';
import { goBuildInvocation, pnpmInvocation, spawnArgv } from './spawn.mjs';
import { runtimeGenerationBin, runtimeGenerationDir } from './paths.mjs';

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
    const pnpm = pnpmInvocation(checkout, ['-r', '--filter', './packages/*', '--if-present', 'run', 'build'], nodeExecutable, exists);
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

export function cleanupRuntimeGeneration(checkout, generationId, inUse) {
  if (!generationId || inUse.has(generationId)) return;
  try {
    rmSync(runtimeGenerationDir(checkout, generationId), { recursive: true, force: true });
  } catch {
    // Windows may still have the exe mapped; keep it until the next idle cleanup.
  }
}
