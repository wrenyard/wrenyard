/** Shared live usage cache keyed by gateway execution identity. */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { shell } from './desktop';
import type { TaskUsageLive } from '@/shell-contract';

type LiveRun = { executionId: string; taskRunId: string };
type LiveRecord = { executionId: string; taskRunId?: string; usage: TaskUsageLive };
type RecentTaskRun = {
  taskRunId: string;
  executionId?: string;
  executionMode?: 'gateway' | 'native';
  status?: string;
};

const entries = new Map<string, TaskUsageLive>();
const taskRunToExecution = new Map<string, string>();
const registrations = new Map<string, Map<string, number>>();
const pendingRuns = new Map<string, number>();
const terminalRuns = new Set<string>();
const terminalExecutions = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, TaskUsageLive> = new Map();
let subscribed = false;
let generation = 0;
let queued = new Set<string>();
let inflight = new Set<string>();
let flushQueued = false;
let identityQueued = false;
const queuedIdentityRuns = new Set<string>();

function emit(): void {
  snapshot = new Map(entries);
  for (const listener of listeners) listener();
}

function activeExecutionIds(): string[] {
  return [...registrations.keys()].filter((id) => !terminalExecutions.has(id));
}

function addExecution(run: LiveRun, count = 1): void {
  const { executionId, taskRunId } = run;
  if (!executionId || !taskRunId || terminalRuns.has(taskRunId) || terminalExecutions.has(executionId)) return;
  let taskRuns = registrations.get(executionId);
  const isNewExecution = !taskRuns;
  if (!taskRuns) registrations.set(executionId, taskRuns = new Map());
  taskRuns.set(taskRunId, (taskRuns.get(taskRunId) ?? 0) + count);
  taskRunToExecution.set(taskRunId, executionId);
  if (isNewExecution) queueHydration([executionId]);
}

function removeExecution(run: LiveRun, count = 1): void {
  const { executionId, taskRunId } = run;
  const taskRuns = registrations.get(executionId);
  const currentCount = taskRuns?.get(taskRunId) ?? 0;
  if (currentCount <= count) {
    taskRuns?.delete(taskRunId);
    if (taskRunToExecution.get(taskRunId) === executionId) taskRunToExecution.delete(taskRunId);
  } else {
    taskRuns?.set(taskRunId, currentCount - count);
  }
  if (taskRuns?.size === 0) {
    registrations.delete(executionId);
    queued.delete(executionId);
    inflight.delete(executionId);
    if (entries.delete(executionId)) emit();
  }
}

async function hydrate(ids: readonly string[], requestGeneration: number): Promise<void> {
  const batch = [...new Set(ids)].filter((id) =>
    !terminalExecutions.has(id) && registrations.has(id) && !inflight.has(id),
  );
  if (batch.length === 0) return;
  for (const id of batch) inflight.add(id);
  let usage: Record<string, LiveRecord>;
  try {
    const result = await shell.task('task.usage.liveList', { execution_ids: batch });
    usage = result?.usage ?? {};
  } catch {
    if (requestGeneration === generation) for (const id of batch) inflight.delete(id);
    return;
  }
  if (requestGeneration !== generation) return;
  for (const id of batch) inflight.delete(id);
  let changed = false;
  for (const record of Object.values(usage)) {
    const id = record.executionId;
    if (terminalExecutions.has(id) || !registrations.has(id)) continue;
    if (record.taskRunId && !terminalRuns.has(record.taskRunId)) taskRunToExecution.set(record.taskRunId, id);
    const current = entries.get(id);
    if (current && current.requests > record.usage.requests) continue;
    entries.set(id, { ...record.usage });
    changed = true;
  }
  if (changed) emit();
}

function queueHydration(ids: Iterable<string>): void {
  for (const id of ids) {
    if (!terminalExecutions.has(id) && registrations.has(id) && !inflight.has(id)) queued.add(id);
  }
  if (flushQueued || queued.size === 0) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const batch = [...queued];
    queued.clear();
    void hydrate(batch, generation);
  });
}

function resolvePendingRuns(requestGeneration: number, runIds?: readonly string[]): Promise<void> {
  const candidates = runIds ?? [...pendingRuns.keys()];
  const requested = [...new Set(candidates)].filter((id) =>
    (pendingRuns.get(id) ?? 0) > 0 && !terminalRuns.has(id),
  );
  if (requested.length === 0) return Promise.resolve();
  return shell.getStats().then((stats) => {
    if (requestGeneration !== generation) return;
    const requestedSet = new Set(requested);
    for (const run of (stats?.recentTaskRuns ?? []) as RecentTaskRun[]) {
      if (!requestedSet.has(run.taskRunId) || terminalRuns.has(run.taskRunId)) continue;
      if (run.status !== 'running' || run.executionMode !== 'gateway' || !run.executionId) continue;
      if (terminalExecutions.has(run.executionId)) continue;
      const count = pendingRuns.get(run.taskRunId) ?? 0;
      if (count === 0) continue;
      const prior = taskRunToExecution.get(run.taskRunId);
      if (prior === run.executionId) continue;
      if (prior) removeExecution({ taskRunId: run.taskRunId, executionId: prior }, pendingRuns.get(run.taskRunId) ?? 0);
      taskRunToExecution.set(run.taskRunId, run.executionId);
      addExecution({ taskRunId: run.taskRunId, executionId: run.executionId }, count);
    }
  }).catch(() => undefined);
}

function queueIdentityResolution(): void {
  if (identityQueued || queuedIdentityRuns.size === 0) return;
  identityQueued = true;
  queueMicrotask(() => {
    identityQueued = false;
    const batch = [...queuedIdentityRuns];
    queuedIdentityRuns.clear();
    void resolvePendingRuns(generation, batch);
  });
}

function bindPendingPush(update: { taskRunId: string; executionId: string }): boolean {
  const { taskRunId, executionId } = update;
  const count = pendingRuns.get(taskRunId) ?? 0;
  if (count === 0 || terminalRuns.has(taskRunId) || terminalExecutions.has(executionId)) return false;
  const prior = taskRunToExecution.get(taskRunId);
  if (prior === executionId) return registrations.has(executionId);
  if (prior) removeExecution({ taskRunId, executionId: prior }, count);
  taskRunToExecution.set(taskRunId, executionId);
  addExecution({ taskRunId, executionId }, count);
  return registrations.has(executionId);
}

function ensureSubscribed(): void {
  if (subscribed || typeof shell?.onTaskUsageLive !== 'function') return;
  subscribed = true;
  shell.onTaskUsageLive((update) => {
    const id = update.executionId;
    if (terminalExecutions.has(id)) return;
    const authorized = registrations.has(id) || (!!update.taskRunId && bindPendingPush(update));
    if (!authorized || !registrations.has(id)) return;
    if (update.taskRunId && !terminalRuns.has(update.taskRunId)) taskRunToExecution.set(update.taskRunId, id);
    const current = entries.get(id);
    if (current && update.usage.requests < current.requests) return;
    entries.set(id, { ...update.usage });
    emit();
  });
  shell.onTaskUsageReconnect(() => {
    generation += 1;
    queued.clear();
    inflight.clear();
    const reconnectGeneration = generation;
    void resolvePendingRuns(reconnectGeneration).then(() => {
      if (reconnectGeneration !== generation) return;
      queueHydration(activeExecutionIds());
    });
  });
}

function subscribe(listener: () => void): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ReadonlyMap<string, TaskUsageLive> {
  return snapshot;
}

function acquirePendingRun(taskRunId: string): void {
  ensureSubscribed();
  if (!taskRunId || terminalRuns.has(taskRunId)) return;
  const currentCount = pendingRuns.get(taskRunId) ?? 0;
  pendingRuns.set(taskRunId, currentCount + 1);
  if (currentCount === 0 && !taskRunToExecution.has(taskRunId)) queuedIdentityRuns.add(taskRunId);
  const executionId = taskRunToExecution.get(taskRunId);
  if (executionId) addExecution({ taskRunId, executionId });
}

function releasePendingRun(taskRunId: string): void {
  const activeCount = pendingRuns.get(taskRunId) ?? 0;
  if (activeCount <= 1) pendingRuns.delete(taskRunId);
  else pendingRuns.set(taskRunId, activeCount - 1);
  if (activeCount <= 1) queuedIdentityRuns.delete(taskRunId);
  const executionId = taskRunToExecution.get(taskRunId);
  if (executionId) removeExecution({ taskRunId, executionId });
}

/** Register active gateway executions for one surface; reads batch per microtask. */
export function useTaskUsageLiveExecutions(runs: readonly LiveRun[]): void {
  const current = useRef(new Map<string, LiveRun>());
  const signature = runs.map(({ executionId, taskRunId }) => `${executionId}\u0000${taskRunId}`).join('\u0001');
  useEffect(() => {
    const next = new Map(runs.map((run) => [`${run.executionId}\u0000${run.taskRunId}`, run]));
    for (const [key, run] of current.current) {
      if (next.has(key)) continue;
      removeExecution(run);
      current.current.delete(key);
    }
    for (const [key, run] of next) {
      if (current.current.has(key)) continue;
      addExecution(run);
      current.current.set(key, run);
    }
  }, [signature]);
  useEffect(() => () => {
    for (const run of current.current.values()) removeExecution(run);
    current.current.clear();
  }, []);
}

/** Resolve task run identities for Trace without requiring identity on span.started. */
export function useTaskUsageLiveRuns(taskRunIds: readonly string[]): void {
  const current = useRef(new Set<string>());
  const signature = [...new Set(taskRunIds)].sort().join('\u0001');
  useEffect(() => {
    const next = new Set(taskRunIds.filter(Boolean));
    for (const taskRunId of current.current) {
      if (next.has(taskRunId)) continue;
      releasePendingRun(taskRunId);
      current.current.delete(taskRunId);
    }
    for (const taskRunId of next) {
      if (current.current.has(taskRunId)) continue;
      acquirePendingRun(taskRunId);
      current.current.add(taskRunId);
    }
    queueIdentityResolution();
  }, [signature]);
  useEffect(() => () => {
    for (const taskRunId of current.current) releasePendingRun(taskRunId);
    current.current.clear();
  }, []);
}

/** Preserve final authoritative values by tombstoning completed executions. */
export function dropTaskUsageLive(executionId: string): void {
  terminalExecutions.add(executionId);
  const taskRuns = registrations.get(executionId);
  for (const taskRunId of taskRuns?.keys() ?? []) {
    terminalRuns.add(taskRunId);
    pendingRuns.delete(taskRunId);
    queuedIdentityRuns.delete(taskRunId);
  }
  registrations.delete(executionId);
  queued.delete(executionId);
  inflight.delete(executionId);
  for (const [taskRunId, id] of taskRunToExecution) {
    if (id === executionId) {
      terminalRuns.add(taskRunId);
      pendingRuns.delete(taskRunId);
      queuedIdentityRuns.delete(taskRunId);
      taskRunToExecution.delete(taskRunId);
    }
  }
  if (entries.delete(executionId)) emit();
}

export function dropTaskUsageLiveByRun(taskRunId: string): void {
  terminalRuns.add(taskRunId);
  const executionId = taskRunToExecution.get(taskRunId);
  taskRunToExecution.delete(taskRunId);
  pendingRuns.delete(taskRunId);
  queuedIdentityRuns.delete(taskRunId);
  if (executionId) dropTaskUsageLive(executionId);
}

/** Read the shared cumulative sample by gateway execution identity. */
export function useTaskUsageLive(executionId: string | undefined): TaskUsageLive | undefined {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return executionId === undefined ? undefined : map.get(executionId);
}

export function useTaskUsageLiveByRun(taskRunId: string | undefined): TaskUsageLive | undefined {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const executionId = taskRunId === undefined ? undefined : taskRunToExecution.get(taskRunId);
  return executionId === undefined ? undefined : map.get(executionId);
}
