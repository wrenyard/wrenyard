/**
 * Task results as plain text.
 *
 * A finished run reports in prose and carries the facts the daemon collected
 * itself. Both enter the model's context as text: the run's own report first,
 * then the facts as a flat bullet list. Nothing is rephrased, nothing is
 * invented and absent facts are omitted.
 */

import type { TaskRunFacts } from '@wrenyard/protocol/task';

/** One run's report followed by the facts the daemon collected, as plain text. */
export function renderTaskRunResult(report: string, facts?: TaskRunFacts): string {
  const rendered = facts === undefined ? '' : renderRunFacts(facts);
  if (rendered === '') return report;
  return report.trim() === '' ? rendered : `${report}\n\n${rendered}`;
}

/** The facts of one run as a flat bullet list. */
function renderRunFacts(facts: TaskRunFacts): string {
  const lines: string[] = [`- status: ${facts.status}`];
  if (isFilled(facts.failure_category)) lines.push(`- failure: ${facts.failure_category}`);
  if (facts.duration_ms !== null) lines.push(`- duration: ${facts.duration_ms} ms`);
  lines.push(`- timed out: ${facts.timed_out ? 'yes' : 'no'}`);
  if (isFilled(facts.worktree_id)) lines.push(`- worktree: ${facts.worktree_id}`);
  else if (isFilled(facts.checkout_path)) lines.push(`- checkout: ${facts.checkout_path}`);
  writeList(lines, 'changed files', facts.changed_files);
  writeList(lines, 'commits', facts.commits.map((commit) => `${commit.sha} ${commit.subject}`.trim()));
  writeList(lines, 'artifact files', facts.artifact_files.map((file) => `${file.path} (${file.bytes} bytes)`));
  return lines.join('\n');
}

function writeList(lines: string[], label: string, entries: readonly string[]): void {
  if (entries.length === 0) return;
  lines.push(`- ${label}:`);
  for (const entry of entries) lines.push(`  - ${entry}`);
}

function isFilled(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '';
}
