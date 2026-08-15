import type { Phase } from '../shared/snapshot';

export type WorkerBehaviorStage = 'spawn' | 'fadeIn' | 'work' | 'fadeOut' | 'despawn';

export function nextWorkerBehaviorStage(
  previous: WorkerBehaviorStage | undefined,
  phase: Phase | undefined,
): WorkerBehaviorStage {
  if (phase === undefined) return 'despawn';

  if (phase === 'celebrating' || phase === 'dejected') {
    if (previous === undefined || previous === 'spawn') return 'fadeIn';
    if (previous === 'fadeOut') return 'fadeOut';
    return 'work';
  }

  // working / sleeping → show as work
  return 'work';
}

export function isFadeOutStage(stage: WorkerBehaviorStage): boolean {
  return stage === 'fadeOut';
}
