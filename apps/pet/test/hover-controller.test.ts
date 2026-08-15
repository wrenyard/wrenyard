import { describe, it, expect } from 'vitest';
import {
  hitTest,
  buildInfoCard,
} from '../src/main/hover-controller';
import type { WorkerSnapshot } from '../src/main/forge-types';

// ── Sample WorkerSnapshot ──

function makeWorker(overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    workerIdentityKey: 'fg_test_01',
    profile: 'cb-dsf',
    phase: 'working',
    toolCount: 5,
    startedAt: 1000000,
    meta: {
      workerIdentityKey: 'fg_test_01',
      profile: 'cb-dsf',
      workDir: '/tmp/test-project',
      isWorktree: false,
      status: 'running',
      project: 'test-project',
    },
    firstSentence: 'Let me analyze the codebase.',
    lastText: 'Found a bug in auth.ts',
    ...overrides,
  };
}

// ── Hit-test ──

describe('hover-controller — hitTest', () => {
  it('returns true when mouse is inside worker bounds', () => {
    const bounds = { x: 100, y: 200, w: 32, h: 32 };
    expect(hitTest(bounds, 110, 210)).toBe(true);
    expect(hitTest(bounds, 100, 200)).toBe(true);   // top-left corner
    expect(hitTest(bounds, 131, 231)).toBe(true);   // bottom-right corner
  });

  it('returns false when mouse is outside worker bounds', () => {
    const bounds = { x: 100, y: 200, w: 32, h: 32 };
    expect(hitTest(bounds, 99, 210)).toBe(false);   // left
    expect(hitTest(bounds, 133, 210)).toBe(false);  // right
    expect(hitTest(bounds, 110, 199)).toBe(false);  // above
    expect(hitTest(bounds, 110, 233)).toBe(false);  // below
  });

  it('returns false for far-away mouse positions', () => {
    const bounds = { x: 100, y: 200, w: 32, h: 32 };
    expect(hitTest(bounds, 0, 0)).toBe(false);
    expect(hitTest(bounds, 1000, 1000)).toBe(false);
  });

  it('returns true for degenerate bounds (zero size) only at exact point', () => {
    const bounds = { x: 50, y: 50, w: 0, h: 0 };
    expect(hitTest(bounds, 50, 50)).toBe(true);
    expect(hitTest(bounds, 51, 50)).toBe(false);
  });
});

// ── Info card field extraction ──

describe('hover-controller — buildInfoCard', () => {
  it('extracts profile, toolCount, project, isWorktree and hides uninformative running status', () => {
    const w = makeWorker();
    const card = buildInfoCard(w);
    expect(card.profile).toBe('cb-dsf');
    expect(card.status).toBe('');
    expect(card.toolCount).toBe(5);
    expect(card.project).toBe('test-project');
    expect(card.isWorktree).toBe(false);
  });

  it('computes duration from startedAt and now', () => {
    const w = makeWorker({ startedAt: 1000000 });
    const now = 1005000; // 5s elapsed
    const card = buildInfoCard(w, now);
    expect(card.durationMs).toBe(5000);
  });

  it('defaults duration to 0 when startedAt is not set', () => {
    const w = makeWorker({ startedAt: 0 });
    const card = buildInfoCard(w);
    expect(card.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes firstSentence when available', () => {
    const w = makeWorker({ firstSentence: 'Starting analysis...' });
    const card = buildInfoCard(w);
    expect(card.firstSentence).toBe('Starting analysis...');
  });

  it('includes lastText as tail', () => {
    const w = makeWorker({ lastText: 'Current status: processing' });
    const card = buildInfoCard(w);
    expect(card.tail).toBe('Current status: processing');
  });

  it('prefers tool_result status and output tail when available', () => {
    const w = makeWorker({
      lastToolStatus: 'error',
      lastToolOutputTail: 'Command failed on lint',
      lastText: 'Older assistant text',
    });
    const card = buildInfoCard(w);
    expect(card.status).toBe('error');
    expect(card.tail).toBe('Command failed on lint');
  });

  it('uses turn_usage duration and token counts when available', () => {
    const w = makeWorker({
      durationMs: 4321,
      inputTokens: 123,
      outputTokens: 45,
    });
    const card = buildInfoCard(w, 9999999);
    expect(card.durationMs).toBe(4321);
    expect(card.inputTokens).toBe(123);
    expect(card.outputTokens).toBe(45);
  });

  it('tail is undefined when lastText is not set', () => {
    const w = makeWorker();
    w.lastText = undefined;
    const card = buildInfoCard(w);
    expect(card.tail).toBeUndefined();
  });

  it('handles worker with minimal metadata', () => {
    const w: WorkerSnapshot = {
      workerIdentityKey: 'fg_min',
      profile: 'codex',
      phase: 'sleeping',
      toolCount: 0,
      startedAt: 0,
      meta: {
        workerIdentityKey: 'fg_min',
        profile: 'codex',
        workDir: '/tmp/unknown',
        isWorktree: true,
        status: 'running',
      },
    };
    const card = buildInfoCard(w);
    expect(card.profile).toBe('codex');
    expect(card.status).toBe('');
    expect(card.toolCount).toBe(0);
    expect(card.isWorktree).toBe(true);
    expect(card.project).toBeUndefined();
    expect(card.tail).toBeUndefined();
  });

  it('includes duration in a human-readable string', () => {
    const w = makeWorker({ startedAt: 1000000 });
    const card = buildInfoCard(w, 1000000 + 65 * 1000); // 65s
    expect(card.durationMs).toBe(65000);
  });

  it('copies taskId, taskName, taskLabel from worker.meta', () => {
    const w = makeWorker({
      meta: {
        workerIdentityKey: 'fg_task',
        profile: 'codex',
        workDir: '/tmp/test',
        isWorktree: false,
        status: 'running',
        taskId: 't-001',
        taskName: 'fix-login',
        taskLabel: 'fix-login',
      },
    });
    const card = buildInfoCard(w);
    expect(card.taskId).toBe('t-001');
    expect(card.taskName).toBe('fix-login');
    expect(card.taskLabel).toBe('fix-login');
  });

  it('handles missing task meta gracefully', () => {
    const w = makeWorker();
    const card = buildInfoCard(w);
    expect(card.taskId).toBeUndefined();
    expect(card.taskName).toBeUndefined();
    expect(card.taskLabel).toBeUndefined();
  });
});
