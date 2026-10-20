import type {
  TaskResolvedDispatch,
  TaskSettingsLayer,
  TaskSettingsPatch,
  TaskSettingsSnapshot,
  TaskSettingsTaskRow,
} from '@/shell-contract';

/* Pure, React-free Task Settings model: tree grouping and patch helpers. */

export type TaskTreeLoadError = NonNullable<TaskSettingsSnapshot['load_errors']>[number];

export interface TaskTreeProjectGroup {
  key: string;
  project: string;
  label: string;
  rows: TaskSettingsTaskRow[];
  errors: TaskTreeLoadError[];
}

export interface TaskTreeModel {
  builtin: TaskSettingsTaskRow[];
  projects: TaskTreeProjectGroup[];
  unknownErrors: TaskTreeLoadError[];
  /** Project-category count: one per project group plus the unknown-error bucket. */
  projectCategoryCount: number;
}

/**
 * Groups the flat daemon row list into builtin and project buckets, preserving
 * backend order. Backend load failures join their project group when known,
 * otherwise an unknown-source bucket, and stay non-executable leaves.
 */
export function buildTaskTree(snapshot: TaskSettingsSnapshot | null | undefined): TaskTreeModel {
  const rows = snapshot?.rows ?? [];
  const loadErrors = snapshot?.load_errors ?? [];
  const projectLabels = new Map(
    loadErrors
      .filter((entry) => entry.project !== undefined && entry.project_display_name !== undefined)
      .map((entry) => [entry.project!, entry.project_display_name!] as const),
  );
  const projectErrors = new Map<string, TaskTreeLoadError[]>();
  const unknownErrors: TaskTreeLoadError[] = [];
  for (const entry of loadErrors) {
    if (entry.project !== undefined) {
      const bucket = projectErrors.get(entry.project) ?? [];
      bucket.push(entry);
      projectErrors.set(entry.project, bucket);
    } else {
      unknownErrors.push(entry);
    }
  }
  const builtin: TaskSettingsTaskRow[] = [];
  const projectRows = new Map<string, TaskSettingsTaskRow[]>();
  for (const row of rows) {
    if (row.project === undefined) {
      builtin.push(row);
      continue;
    }
    const bucket = projectRows.get(row.project) ?? [];
    bucket.push(row);
    projectRows.set(row.project, bucket);
  }
  const projectKeys = new Set<string>([...projectRows.keys(), ...projectErrors.keys()]);
  const projects: TaskTreeProjectGroup[] = [];
  for (const project of projectKeys) {
    const groupRows = projectRows.get(project) ?? [];
    const errors = projectErrors.get(project) ?? [];
    if (groupRows.length === 0 && errors.length === 0) continue;
    projects.push({
      key: `project:${project}`,
      project,
      label: groupRows[0]?.project_display_name ?? projectLabels.get(project) ?? project,
      rows: groupRows,
      errors,
    });
  }
  return {
    builtin,
    projects,
    unknownErrors,
    projectCategoryCount: projectKeys.size + (unknownErrors.length > 0 ? 1 : 0),
  };
}

/** Strip the IPC wrapper the bridge adds so only the daemon message remains. */
export function tasksErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }
  return String(error);
}

/** Visible detail identity: only the leading `builtin:` prefix is stripped. */
export function taskIdentityLabel(identity: string): string {
  return identity.startsWith('builtin:') ? identity.slice('builtin:'.length) : identity;
}

/** Paired resolved Provider · Model display labels; null unless both exist, so
 *  raw canonical ids are never promoted onto the product line. */
export function resolvedTaskLabel(
  resolved: Pick<TaskResolvedDispatch, 'provider_display_name' | 'model_display_name'> | null | undefined,
): string | null {
  if (!resolved) return null;
  const provider = resolved.provider_display_name;
  const model = resolved.model_display_name;
  if (!provider || !model) return null;
  return `${provider} · ${model}`;
}

/** Title-band runtime line: clean display-label identity on success only. */
export function taskRuntimeLine(row: TaskSettingsTaskRow): string {
  return resolvedTaskLabel(row.automatic_selection?.resolved) ?? '';
}

/** First structured resolution-failure message on the row, or null when none. */
export function taskResolutionFailureMessage(row: TaskSettingsTaskRow): string | null {
  const issue = row.issues.find((candidate) => candidate.resolutionFailure !== undefined);
  return issue?.resolutionFailure?.message ?? null;
}

/** Per-task layer patch from visible controls (currently no per-task fields). */
export function buildLayerPatch(): TaskSettingsPatch {
  return {};
}

/** Field-level reset of every writable field present on this layer. */
export function resetPatch(layer: TaskSettingsLayer): TaskSettingsPatch {
  const patch: TaskSettingsPatch = {};
  for (const field of ['automatic'] as const) {
    if (layer[field] !== undefined) patch[field] = null as never;
  }
  return patch;
}

/**
 * Splices a scoped single-row snapshot into the cached full snapshot so the
 * task tree is never replaced by one filtered row.
 */
export function mergeSnapshots(
  base: TaskSettingsSnapshot | undefined,
  incoming: TaskSettingsSnapshot,
): TaskSettingsSnapshot {
  const rows = new Map<string, TaskSettingsTaskRow>();
  for (const row of base?.rows ?? []) rows.set(row.identity, row);
  for (const row of incoming.rows) rows.set(row.identity, row);
  return { ...incoming, rows: [...rows.values()] };
}
