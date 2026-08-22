import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const STORAGE_VERSION = 2;
const STORAGE_RELATIVE = join('storages', 'workspace.json');

export interface WorkspaceRecord {
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceStorage {
  unit: { name: 'workspace'; version: number };
  global: {
    initialized: boolean;
    workspaceIds: string[];
    archivedSessionIds: string[];
  };
  tables: {
    workspaces: Record<string, WorkspaceRecord>;
  };
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
  const override = env.WRENYARD_DESKTOP_WORKSPACE?.trim();
  if (override) {
    return assertDirectory(override, 'WRENYARD_DESKTOP_WORKSPACE');
  }
  const configPath = resolveWrenyardConfigPath(env);
  const configured = readWorkspaceRootFromConfig(configPath);
  if (!configured) {
    throw new Error(
      `Wrenyard workspace.root is missing in ${configPath}; set workspace.root or WRENYARD_DESKTOP_WORKSPACE`,
    );
  }
  return assertDirectory(configured, 'Wrenyard workspace.root');
}

export function workspaceStoragePath(dshHome: string): string {
  return join(dshHome, STORAGE_RELATIVE);
}

function emptyStorage(): WorkspaceStorage {
  return {
    unit: { name: 'workspace', version: STORAGE_VERSION },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
    },
    tables: { workspaces: {} },
  };
}

function parseStorage(raw: string, path: string): WorkspaceStorage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`DSH workspace storage is not valid JSON: ${path}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`DSH workspace storage is not an object: ${path}`);
  }
  const doc = parsed as Partial<WorkspaceStorage>;
  const tables = doc.tables && typeof doc.tables === 'object' ? doc.tables : { workspaces: {} };
  const workspaces =
    tables.workspaces && typeof tables.workspaces === 'object' && !Array.isArray(tables.workspaces)
      ? tables.workspaces
      : {};
  const global = (doc.global && typeof doc.global === 'object' ? doc.global : {}) as {
    workspaceIds?: unknown;
    archivedSessionIds?: unknown;
  };
  const workspaceIds = Array.isArray(global.workspaceIds)
    ? global.workspaceIds.filter((id): id is string => typeof id === 'string')
    : [];
  const archivedSessionIds = Array.isArray(global.archivedSessionIds)
    ? global.archivedSessionIds.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    unit: { name: 'workspace', version: STORAGE_VERSION },
    global: {
      initialized: true,
      workspaceIds,
      archivedSessionIds,
    },
    tables: { workspaces },
  };
}

function findWorkspaceIdByPath(storage: WorkspaceStorage, canonicalPath: string): string | undefined {
  for (const [id, record] of Object.entries(storage.tables.workspaces)) {
    if (typeof record?.path !== 'string') continue;
    let stored = resolve(record.path);
    try {
      stored = realpathSync(record.path);
    } catch {
      // Keep the unresolved path when the registered directory is missing.
    }
    if (stored === canonicalPath) return id;
  }
  return undefined;
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

/**
 * Ensure DSH's durable workspace registry contains the product workspace so
 * `startInitialSelection` can auto-connect a blank session. Existing records
 * for the same canonical path are left unchanged (including title and sessions).
 */
export async function ensureProductWorkspaceRegistered(
  dshHome: string,
  canonicalPath: string,
  title = basename(canonicalPath),
): Promise<{ id: string; created: boolean }> {
  const path = workspaceStoragePath(dshHome);
  let storage = emptyStorage();
  if (existsSync(path)) {
    storage = parseStorage(readFileSync(path, 'utf8'), path);
  }

  const existingId = findWorkspaceIdByPath(storage, canonicalPath);
  if (existingId !== undefined) {
    return { id: existingId, created: false };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  storage.tables.workspaces[id] = {
    path: canonicalPath,
    title,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
  storage.global.workspaceIds = [id, ...storage.global.workspaceIds];
  storage.global.initialized = true;
  await atomicWriteJson(path, storage);
  return { id, created: true };
}
