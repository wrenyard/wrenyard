import { describe, expect, it } from 'vitest';
import { nextWorkerBehaviorStage } from '../src/main/worker-behavior';

describe('worker behavior state machine', () => {
  it('new worker starts at spawn', () => {
    expect(nextWorkerBehaviorStage(undefined, 'working')).toBe('work');
    expect(nextWorkerBehaviorStage(undefined, 'sleeping')).toBe('work');
  });

  it('transitions to work for active phases', () => {
    expect(nextWorkerBehaviorStage('spawn', 'working')).toBe('work');
    expect(nextWorkerBehaviorStage('spawn', 'sleeping')).toBe('work');
  });

  it('stays at work during celebrating/dejected linger period', () => {
    expect(nextWorkerBehaviorStage('work', 'celebrating')).toBe('work');
    expect(nextWorkerBehaviorStage('work', 'dejected')).toBe('work');
    expect(nextWorkerBehaviorStage('fadeIn', 'celebrating')).toBe('work');
    expect(nextWorkerBehaviorStage('fadeIn', 'dejected')).toBe('work');
  });

  it('fades in when spawn transitions to terminal phase', () => {
    expect(nextWorkerBehaviorStage('spawn', 'celebrating')).toBe('fadeIn');
    expect(nextWorkerBehaviorStage('spawn', 'dejected')).toBe('fadeIn');
  });

  it('despawns when the model no longer reports the worker', () => {
    expect(nextWorkerBehaviorStage('fadeOut', undefined)).toBe('despawn');
    expect(nextWorkerBehaviorStage('work', undefined)).toBe('despawn');
  });
});
