import type { StatsWindowSnapshot, TaskRunSnapshot, TaskSettingsSnapshot } from '@/shell-contract';

/** Resolved display-name tables the ledger tables read. */
export interface TaskNameTables {
  /** Authoritative display name keyed by stable TaskSettings identity. */
  byIdentity: ReadonlyMap<string, string>;
  /** Investment label keyed by `${source}:${name}`, only when identically named definitions agree. */
  investment: ReadonlyMap<string, string>;
}

/** Labels for definitions that no longer exist in TaskSettings. */
export const HISTORICAL_TASK_NAMES: Readonly<Record<string, string>> = {
  'builtin:explore-code': '代码探索',
  'project:retire-builtin-files': '清理旧内置任务',
};

/**
 * Builds the read-only display-name tables from authoritative TaskSettings rows.
 * The identity map is the exact per-definition label. The investment map
 * aggregates projects by task name and drops a key when identically named
 * definitions disagree, so no arbitrary project's label is picked.
 */
export function buildTaskNameTables(settings: TaskSettingsSnapshot | null): TaskNameTables {
  const byIdentity = new Map<string, string>();
  const grouped = new Map<string, Set<string>>();
  for (const row of settings?.rows ?? []) {
    byIdentity.set(row.identity, row.display_name);
    const key = `${row.identity.startsWith('builtin:') ? 'builtin' : 'project'}:${row.name}`;
    const names = grouped.get(key) ?? new Set<string>();
    names.add(row.display_name);
    grouped.set(key, names);
  }
  const investment = new Map<string, string>(
    [...grouped].flatMap(([key, names]) => names.size === 1 ? [[key, [...names][0]!] as const] : []),
  );
  return { byIdentity, investment };
}

/**
 * Candidate identities a run may resolve through, most specific first. Project
 * definitions are inherited: a task recorded under `gol/project` may be the
 * inherited definition of project `gol`, so each parent is tried by repeatedly
 * stripping the final `/` segment. Only the execution project's own inheritance
 * chain is consulted — a sibling or unrelated project is never a candidate.
 */
export function taskRunIdentityCandidates(
  run: Pick<TaskRunSnapshot, 'source' | 'project' | 'taskId'>,
): string[] {
  if (run.source === 'builtin') return [`builtin:${run.taskId}`];
  if (run.source !== 'project') return [];
  const project = run.project;
  if (project === undefined || project.length === 0) return [];
  const candidates: string[] = [];
  let scope: string | undefined = project;
  while (scope !== undefined && scope.length > 0) {
    candidates.push(`project:${scope}:${run.taskId}`);
    const separator = scope.lastIndexOf('/');
    scope = separator === -1 ? undefined : scope.slice(0, separator);
  }
  return candidates;
}

/**
 * Authoritative display name when the identity still exists, else the name
 * recorded on the run row, else the exact identifier. Historical rows whose
 * recorded name is itself the raw id therefore still resolve here first.
 */
export function taskDisplayLabel(
  run: Pick<TaskRunSnapshot, 'source' | 'project' | 'taskId' | 'taskName'>,
  names: TaskNameTables,
): string {
  for (const candidate of taskRunIdentityCandidates(run)) {
    const displayName = names.byIdentity.get(candidate);
    if (displayName !== undefined) return displayName;
  }
  const recorded = run.taskName?.trim();
  if (recorded !== undefined && recorded.length > 0) return recorded;
  return run.taskId;
}

/** Investment table label: authoritative aggregate, then historical, then raw name. */
export function taskInvestmentLabel(
  source: StatsWindowSnapshot['byTask'][number]['source'],
  name: string,
  names: TaskNameTables,
): string {
  const key = `${source}:${name}`;
  return names.investment.get(key) ?? HISTORICAL_TASK_NAMES[key] ?? name;
}
