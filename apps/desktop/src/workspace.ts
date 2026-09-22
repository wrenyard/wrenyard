import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rmdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { WORKSPACE_TEMPLATE_FILES } from './workspace-template.js';

export interface WorkspaceConfiguration {
  status: 'configured' | 'missing' | 'invalid';
  source: 'environment' | 'user-config' | 'none';
  configPath: string;
  path?: string;
  message?: string;
  readOnly: boolean;
}

/**
 * Locate Wrenyard `config.json`. Matches Foreman `resolveDefaultForemanConfigPath`:
 * `WRENYARD_CONFIG_HOME` (the directory itself), else `$XDG_CONFIG_HOME/wrenyard`,
 * else `~/.config/wrenyard`, with a legacy `foreman/config.json` read fallback
 * when the primary file is absent.
 */
export function resolveWrenyardConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.WRENYARD_CONFIG_HOME?.trim();
  const xdgRoot = resolve(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'));
  const primary = configHome
    ? join(resolve(configHome), 'config.json')
    : join(xdgRoot, 'wrenyard', 'config.json');
  const legacy = join(xdgRoot, 'foreman', 'config.json');
  return existsSync(legacy) && !existsSync(primary) ? legacy : primary;
}

function readWorkspaceRootFromConfig(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Wrenyard config is not valid JSON: ${configPath}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Wrenyard config is not an object: ${configPath}`);
  }
  const workspace = (parsed as { workspace?: unknown }).workspace;
  if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) {
    return undefined;
  }
  const root = (workspace as { root?: unknown }).root;
  return typeof root === 'string' && root.trim() ? root.trim() : undefined;
}

export async function inspectProductWorkspace(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceConfiguration> {
  const configPath = resolveWrenyardConfigPath(env);
  const override = env.WRENYARD_DESKTOP_WORKSPACE?.trim();
  if (override) {
    try {
      return {
        status: 'configured',
        source: 'environment',
        configPath,
        path: await assertDirectory(override, 'WRENYARD_DESKTOP_WORKSPACE'),
        readOnly: true,
      };
    } catch (error) {
      return {
        status: 'invalid',
        source: 'environment',
        configPath,
        path: resolve(override),
        message: error instanceof Error ? error.message : String(error),
        readOnly: true,
      };
    }
  }

  let configured: string | undefined;
  try {
    configured = readWorkspaceRootFromConfig(configPath);
  } catch (error) {
    return {
      status: 'invalid',
      source: 'user-config',
      configPath,
      message: error instanceof Error ? error.message : String(error),
      readOnly: false,
    };
  }
  if (!configured) {
    return { status: 'missing', source: 'none', configPath, readOnly: false };
  }
  try {
    return {
      status: 'configured',
      source: 'user-config',
      configPath,
      path: await assertDirectory(configured, 'Wrenyard workspace.root'),
      readOnly: false,
    };
  } catch (error) {
    return {
      status: 'invalid',
      source: 'user-config',
      configPath,
      path: resolve(configured),
      message: error instanceof Error ? error.message : String(error),
      readOnly: false,
    };
  }
}

export async function saveProductWorkspace(
  requestedPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceConfiguration> {
  if (env.WRENYARD_DESKTOP_WORKSPACE?.trim()) {
    throw new Error('当前工作区由 WRENYARD_DESKTOP_WORKSPACE 环境变量管理，无法在 App 内修改');
  }
  if (!requestedPath.trim()) throw new Error('请输入 workspace 路径');
  const canonicalPath = await assertDirectory(requestedPath.trim(), 'Workspace');
  const configPath = resolveWrenyardConfigPath(env);
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Wrenyard config is not valid JSON: ${configPath}`, { cause: error });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Wrenyard config is not an object: ${configPath}`);
    }
    config = parsed as Record<string, unknown>;
  }
  const currentWorkspace = config.workspace;
  const workspace = currentWorkspace !== null
    && typeof currentWorkspace === 'object'
    && !Array.isArray(currentWorkspace)
    ? currentWorkspace as Record<string, unknown>
    : {};
  await atomicWriteJson(configPath, {
    ...config,
    workspace: { ...workspace, root: canonicalPath },
  });
  return {
    status: 'configured',
    source: 'user-config',
    configPath,
    path: canonicalPath,
    readOnly: false,
  };
}

/**
 * Create a new Wrenyard product workspace directory and register it.
 *
 * Only a new (or existing empty) directory may be created. A nonempty
 * destination is refused so an existing workspace is selected instead of being
 * overwritten. Template files are written exclusively (never overwriting), and
 * on any failure only the exact files and empty directories created by this
 * invocation are removed.
 */
export async function createProductWorkspace(
  requestedPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceConfiguration> {
  if (env.WRENYARD_DESKTOP_WORKSPACE?.trim()) {
    throw new Error('当前工作区由 WRENYARD_DESKTOP_WORKSPACE 环境变量管理，无法在 App 内修改');
  }
  if (!requestedPath.trim()) throw new Error('请输入 workspace 路径');

  const target = resolve(requestedPath.trim());
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  let directoryExists = false;
  try {
    directoryExists = (await stat(target)).isDirectory();
  } catch {
    directoryExists = false;
  }
  if (directoryExists && (await readdir(target)).length > 0) {
    throw new Error(`目录不是空的，请选择已有 workspace：${target}`);
  }

  try {
    if (!directoryExists) {
      await mkdir(target, { recursive: true });
      createdDirs.push(target);
    }
    for (const [relative, contents] of Object.entries(WORKSPACE_TEMPLATE_FILES)) {
      const filePath = join(target, relative);
      const parent = dirname(filePath);
      if (parent !== target && !existsSync(parent)) createdDirs.push(parent);
      await mkdir(parent, { recursive: true });
      await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' });
      createdFiles.push(filePath);
    }
    return await saveProductWorkspace(target, env);
  } catch (error) {
    for (const filePath of createdFiles.reverse()) {
      await rm(filePath, { force: true });
    }
    for (const dir of createdDirs.reverse()) {
      if (dir === target) continue;
      try {
        await rmdir(dir);
      } catch {
        // Leave non-empty directories in place.
      }
    }
    if (createdDirs.includes(target)) {
      try {
        await rmdir(target);
      } catch {
        // Leave the directory when other content appeared meanwhile.
      }
    }
    throw error;
  }

}

async function assertDirectory(path: string, label: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${canonical}`);
  }
  return canonical;
}

/**
 * Product workspace for Desktop: `WRENYARD_DESKTOP_WORKSPACE` override, else
 * Wrenyard `workspace.root`. No homedir fallback — missing config is a boot error.
 */
export async function resolveProductWorkspace(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configuration = await inspectProductWorkspace(env);
  if (configuration.status === 'configured' && configuration.path) return configuration.path;
  throw new Error(configuration.message
    ?? `Wrenyard workspace.root is missing in ${configuration.configPath}; set workspace.root or WRENYARD_DESKTOP_WORKSPACE`);
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}
