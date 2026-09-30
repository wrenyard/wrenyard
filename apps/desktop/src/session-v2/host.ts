/**
 * Desktop session-v2 host: the only bridge between the session-v2 feature and
 * the local daemon.
 *
 * Every host method is a thin projection of one owner-only NDJSON IPC method
 * (or a read-only `git rev-parse` probe); the session-v2 feature owns all
 * session state, prompts, ledger and drivers. Desktop never imports the old
 * session package, `protocol/session` or the daemon internals here.
 */

import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

import { WrenyardIpcClient, type WrenyardGatewayConnection } from '@wrenyard/control-client';
import type { ProjectInfo, SessionV2Host } from '@wrenyard/session-v2';

/** Canonical cheap (summary) model the host falls back to when none is chosen. */
const DEFAULT_CHEAP_CANONICAL_MODEL = 'deepseek-v4.1-flash';

/** Bounded deadline for ordinary host round-trips (never a task wait). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Task creation and catalog reads may cold-load the workspace and model catalog. */
const COLD_REQUEST_TIMEOUT_MS = 30_000;
/** Read-only git probes must never block the host on a hung repository. */
const GIT_TIMEOUT_MS = 5_000;

/** One `project.list` entry as projected by the daemon. */
interface DaemonProjectEntry {
  name: string;
  path?: string;
  displayName?: string;
  gitRemote?: string;
  defaultBranch?: string;
}

/** One `task.definition.list` summary as projected by the daemon. */
interface DaemonTaskSummary {
  name: string;
  source?: string;
  displayName?: string;
  description?: string;
  project?: string;
}

/** One `task.definition.describe` detail as projected by the daemon. */
interface DaemonTaskDetail extends DaemonTaskSummary {
  input_schema?: unknown;
}

/** The accepted shape `task.run.create` returns on a successful launch. */
interface DaemonTaskRunAccepted {
  task_run_id?: string;
}

/** The terminal `task.run.wait` projection. */
interface DaemonTaskRunTerminal {
  status?: string;
  output?: unknown;
  error?: string | null;
}

/** Minimal projection of `session.summary.model.get` (the daemon owns the rest). */
interface DaemonSummaryModelResult {
  summary?: {
    selectedCanonicalModel?: unknown;
    options?: Array<{ canonicalModel?: unknown; publicId?: unknown; available?: unknown }>;
  };
}

export interface DesktopSessionV2HostOptions {
  /** Current configured workspace root (absolute path). */
  workspaceRoot: string;
  /** Desktop userData directory; the ledger lives under `<stateRoot>/session-v2`. */
  stateRoot: string;
  /** Owner-only daemon NDJSON socket path. */
  ipcPath: string;
  /** Device label surfaced in the frozen workspace snapshot. */
  deviceName?: string;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/**
 * Resolve a canonical cheap-model id to the exact `provider/model` public id the
 * local Gateway expects: an exact public id, then the provider-local model id,
 * then the model id, then a canonical substring. Returns undefined when the
 * live gateway projection cannot serve the model.
 */
function resolveCheapPublicId(
  connection: WrenyardGatewayConnection,
  canonicalModel: string,
): string | undefined {
  const usable = connection.models.filter(
    (model) => !model.taskOnly && typeof model.publicId === 'string' && model.publicId.includes('/'),
  );
  const exact = usable.find((model) => model.publicId === canonicalModel);
  if (exact) return exact.publicId;
  const tail = usable.find(
    (model) => model.publicId.slice(model.publicId.indexOf('/') + 1) === canonicalModel,
  );
  if (tail) return tail.publicId;
  const byId = usable.find((model) => model.id === canonicalModel);
  if (byId) return byId.publicId;
  return undefined;
}

/** Best-effort canonical id from the daemon summary projection, else undefined. */
function selectedCanonicalModel(result: DaemonSummaryModelResult | undefined): string | undefined {
  const selected = result?.summary?.selectedCanonicalModel;
  return typeof selected === 'string' && selected.trim() ? selected.trim() : undefined;
}

/** Public id the daemon already resolved for the canonical model, when usable. */
function resolvedPublicId(
  result: DaemonSummaryModelResult | undefined,
  canonicalModel: string,
): string | undefined {
  const options = result?.summary?.options;
  if (!Array.isArray(options)) return undefined;
  const option = options.find(
    (entry) => entry.canonicalModel === canonicalModel
      && entry.available === true
      && typeof entry.publicId === 'string'
      && entry.publicId.includes('/'),
  );
  return typeof option?.publicId === 'string' ? option.publicId : undefined;
}

/** Read-only branch/HEAD probe; a missing repo or git returns an empty result. */
function readGitHead(checkoutPath: string): { branch?: string; head?: string } {
  if (!checkoutPath) return {};
  const read = (args: string[]): string =>
    execFileSync('git', ['-C', checkoutPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  try {
    const branch = read(['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = read(['rev-parse', '--short', 'HEAD']);
    return {
      ...(branch && branch !== 'HEAD' ? { branch } : {}),
      ...(head ? { head } : {}),
    };
  } catch {
    return {};
  }
}

/** Create the {@link SessionV2Host} the Desktop main process serves. */
export function createDesktopSessionV2Host(options: DesktopSessionV2HostOptions): SessionV2Host {
  const request = async <T>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> => {
    const client = new WrenyardIpcClient({ path: options.ipcPath, requestTimeoutMs: timeoutMs });
    try {
      return await client.request<T>(method, params, { timeoutMs });
    } finally {
      client.close();
    }
  };

  const gateway = (): Promise<WrenyardGatewayConnection> =>
    request<WrenyardGatewayConnection>('gateway.connection', {}, COLD_REQUEST_TIMEOUT_MS);

  const cheapModel = async (): Promise<string> => {
    const connection = await gateway();
    let result: DaemonSummaryModelResult | undefined;
    try {
      result = await request<DaemonSummaryModelResult>('session.summary.model.get', {});
    } catch {
      // The daemon may not have a summary preference yet; the host default stands.
      result = undefined;
    }
    const canonical = selectedCanonicalModel(result) ?? DEFAULT_CHEAP_CANONICAL_MODEL;
    const publicId = resolvedPublicId(result, canonical) ?? resolveCheapPublicId(connection, canonical);
    if (!publicId || !connection.models.some((model) => model.publicId === publicId && !model.taskOnly)) {
      throw new Error(`本地模型网关无法解析便宜模型 ${canonical}`);
    }
    return publicId;
  };

  const listProjects = async (): Promise<ProjectInfo[]> => {
    const entries = await request<DaemonProjectEntry[]>('project.list', {}, COLD_REQUEST_TIMEOUT_MS);
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => ({
      id: entry.name,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      // The session-v2 workspace scope is always the registered project dir,
      // independent of where the project checkout actually lives on disk.
      workspaceDir: `projects/${entry.name}`,
      ...(entry.path ? { checkoutPath: entry.path } : {}),
      ...(entry.gitRemote ? { gitRemote: entry.gitRemote } : {}),
      ...(entry.defaultBranch ? { defaultBranch: entry.defaultBranch } : {}),
    }));
  };

  const gitHead = async (checkoutPath: string): Promise<{ branch?: string; head?: string }> =>
    readGitHead(checkoutPath);

  const listTaskDefinitions = async (): Promise<{ id: string; description: string; project?: string }[]> => {
    const definitions: { id: string; description: string; project?: string }[] = [];
    const seen = new Set<string>();
    const add = (summary: DaemonTaskSummary, project?: string): void => {
      if (typeof summary?.name !== 'string') return;
      const owner = summary.source === 'builtin' ? undefined : summary.project ?? project;
      const key = `${owner ?? ''}:${summary.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      definitions.push({
        id: summary.name,
        description: summary.description ?? summary.displayName ?? summary.name,
        ...(owner === undefined ? {} : { project: owner }),
      });
    };

    const builtins = await request<DaemonTaskSummary[]>('task.definition.list', {}, COLD_REQUEST_TIMEOUT_MS);
    if (Array.isArray(builtins)) for (const summary of builtins) add(summary);

    // With a project scope the daemon re-includes the generic definitions, so
    // Dedupe by owning project and definition id, retaining scoped overrides.
    for (const project of await listProjects()) {
      const scoped = await request<DaemonTaskSummary[]>(
        'task.definition.list',
        { project: project.id },
        COLD_REQUEST_TIMEOUT_MS,
      );
      if (!Array.isArray(scoped)) continue;
      for (const summary of scoped) add(summary, summary.project ?? project.id);
    }
    return definitions;
  };

  const describeTask = async (
    id: string,
    project?: string,
  ): Promise<{ description: string; inputSchema: unknown }> => {
    const params: Record<string, unknown> = { task_id: id };
    if (project !== undefined) params.project = project;
    const detail = await request<DaemonTaskDetail>('task.definition.describe', params, COLD_REQUEST_TIMEOUT_MS);
    return {
      description: detail.description ?? detail.displayName ?? detail.name ?? id,
      inputSchema: detail.input_schema,
    };
  };

  const createTaskRun = async (params: {
    task: string;
    project?: string;
    input: unknown;
    ctx?: Record<string, unknown>;
  }): Promise<{ taskRunId: string }> => {
    const payload: Record<string, unknown> = { task_id: params.task, input: params.input };
    if (params.project !== undefined) payload.project = params.project;
    if (params.ctx !== undefined) payload.ctx = params.ctx;
    const result = await request<DaemonTaskRunAccepted>('task.run.create', payload, COLD_REQUEST_TIMEOUT_MS);
    const taskRunId = result?.task_run_id;
    if (typeof taskRunId !== 'string' || !taskRunId) {
      throw new Error(`task.run.create 未返回 task_run_id: ${outputText(result)}`);
    }
    return { taskRunId };
  };

  const waitTaskRun = async (
    taskRunId: string,
    signal: AbortSignal,
  ): Promise<{ status: string; output: string }> => {
    const client = new WrenyardIpcClient({ path: options.ipcPath, requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
    const onAbort = (): void => client.close();
    if (signal.aborted) {
      client.close();
      throw abortError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      // No explicit deadline: task.run.wait blocks until the authoritative
      // terminal status, and the caller's signal is the only way out.
      const terminal = await client.request<DaemonTaskRunTerminal>(
        'task.run.wait',
        { task_run_id: taskRunId },
        { timeoutMs: null },
      );
      const output = outputText(terminal?.output);
      return { status: typeof terminal?.status === 'string' ? terminal.status : 'unknown', output: output || terminal?.error || '' };
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      client.close();
    }
  };

  const cancelTaskRun = async (taskRunId: string): Promise<void> => {
    await request('task.run.cancel', { task_run_id: taskRunId }, 5_000);
  };

  const createWorkspaceDoc = async (path: string, content: string): Promise<void> => {
    await request('workspace.doc.create', { path, content });
  };

  const updateWorkspaceDoc = async (
    path: string,
    content: string,
    expectedContent: string,
  ): Promise<void> => {
    await request('workspace.doc.update', { path, content, expectedContent });
  };

  return {
    workspaceRoot: options.workspaceRoot,
    stateRoot: options.stateRoot,
    deviceName: options.deviceName ?? hostname(),
    gateway,
    cheapModel,
    listProjects,
    gitHead,
    listTaskDefinitions,
    describeTask,
    createTaskRun,
    waitTaskRun,
    cancelTaskRun,
    createWorkspaceDoc,
    updateWorkspaceDoc,
  };
}
