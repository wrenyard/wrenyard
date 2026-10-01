import type {
  RuntimeAliasEntry,
  TaskResolvedDispatch,
  TaskSettingsExplicitReference,
  TaskSettingsLayer,
  TaskSettingsMode,
  TaskSettingsPatch,
  TaskSettingsSnapshot,
  TaskSettingsTaskRow,
} from '@/shell-contract';
import {
  ERR_RUNTIME_REQUIRED,
  ERR_TIMEOUT_INVALID,
  TIMEOUT_INHERIT_PREFIX,
  TIMEOUT_NOT_SET,
  TIMEOUT_OVERRIDE_PREFIX,
  TIMEOUT_SUFFIX,
} from './describe.js';

/* Pure, React-free Task Settings model: tree grouping, reference/timeout
 * coercion and the patch builder that mirrors the daemon scoped-save contract. */

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
  const mode = row.effective.mode.value;
  const resolved = mode === 'automatic' ? row.automatic_selection?.resolved : row.explicit?.resolved;
  return resolvedTaskLabel(resolved) ?? '';
}

/** First structured resolution-failure message on the row, or null when none. */
export function taskResolutionFailureMessage(row: TaskSettingsTaskRow): string | null {
  const issue = row.issues.find((candidate) => candidate.resolutionFailure !== undefined);
  return issue?.resolutionFailure?.message ?? null;
}

/** Render text for a stored explicit reference: alias name or inline target. */
export function explicitReferenceText(reference: TaskSettingsExplicitReference | null | undefined): string {
  if (!reference) return '';
  return reference.kind === 'alias' ? reference.name : reference.target;
}

/** The stored alias whose name exactly matches the trimmed input, if any. */
export function runtimeAliasEntryForInput(
  value: string,
  aliases: readonly RuntimeAliasEntry[],
): RuntimeAliasEntry | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return aliases.find((entry) => entry.name === trimmed);
}

/** Alias name when it matches a stored alias; otherwise an inline canonical target. */
export function referenceFromRuntimeInput(
  value: string,
  aliases: readonly RuntimeAliasEntry[],
): TaskSettingsExplicitReference {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(ERR_RUNTIME_REQUIRED);
  const alias = runtimeAliasEntryForInput(trimmed, aliases);
  return alias ? { kind: 'alias', name: alias.name } : { kind: 'target', target: trimmed };
}

export function explicitReferencesEqual(
  left: TaskSettingsExplicitReference | null | undefined,
  right: TaskSettingsExplicitReference | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'alias' && right.kind === 'alias') return left.name === right.name;
  if (left.kind === 'target' && right.kind === 'target') return left.target === right.target;
  return false;
}

/** ms -> whole-seconds display text ('' when no override at this layer). */
export function msToSecondsText(value: number | null | undefined): string {
  return value === undefined || value === null ? '' : String(Math.round(value / 1000));
}

/** Whole-seconds user input -> ms wire value (null clears this layer override). */
export function secondsToMilliseconds(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(ERR_TIMEOUT_INVALID);
  return Math.round(parsed * 1000);
}

export interface TimeoutHint {
  text: string;
  /** True when this layer overrides the inherited timeout. */
  overridden: boolean;
}

/** Effective timeout copy from the actual override/inherited/unset data. */
export function timeoutHint(row: TaskSettingsTaskRow): TimeoutHint {
  const override = row.user_task.timeout_ms;
  const effective = row.effective.timeout_ms.value;
  if (override !== undefined && override !== null) {
    return { text: `${TIMEOUT_OVERRIDE_PREFIX} ${msToSecondsText(override)} ${TIMEOUT_SUFFIX}`, overridden: true };
  }
  if (effective !== undefined && effective !== null) {
    return { text: `${TIMEOUT_INHERIT_PREFIX} ${msToSecondsText(effective)} ${TIMEOUT_SUFFIX}`, overridden: false };
  }
  return { text: TIMEOUT_NOT_SET, overridden: false };
}

/**
 * Builds the per-task layer patch from the visible controls. The mode baseline
 * is the effective two-mode value, so saving an unrelated field never silently
 * pins a mode. Timeout is entered in whole seconds and converted back to ms.
 */
export function buildLayerPatch(
  row: TaskSettingsTaskRow,
  mode: TaskSettingsMode,
  runtimeValue: string,
  timeoutValue: string,
  aliases: readonly RuntimeAliasEntry[],
): TaskSettingsPatch {
  const layer = row.user_task;
  const modeChanged = row.effective.mode.value !== mode;
  const patch: TaskSettingsPatch = {};
  if (modeChanged) patch.mode = mode;
  if (mode === 'explicit') {
    const runtime = referenceFromRuntimeInput(runtimeValue, aliases);
    if (!explicitReferencesEqual(row.effective.explicit_runtime.value, runtime)) patch.explicit_runtime = runtime;
  } else if (modeChanged && layer.explicit_runtime) {
    // Switching away from explicit clears only this layer's stored reference.
    patch.explicit_runtime = null;
  }
  const timeout = secondsToMilliseconds(timeoutValue);
  if ((layer.timeout_ms ?? null) !== timeout) patch.timeout_ms = timeout;
  return patch;
}

/** Field-level reset of every writable field present on this layer. */
export function resetPatch(layer: TaskSettingsLayer): TaskSettingsPatch {
  const patch: TaskSettingsPatch = {};
  for (const field of ['mode', 'explicit_runtime', 'timeout_ms', 'automatic'] as const) {
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
