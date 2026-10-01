import { describe, expect, it } from 'vitest';
import { buildSummaryLines, formatCount } from '../../src/pet/features/house/presenter';

/**
 * The house quota/summary card is now React DOM; only its pure text projection
 * remains testable here. The bar geometry tests moved to the shared
 * `QuotaTips`/`QuotaBar` components.
 */

describe('formatCount', () => {
  it('formats token counts into the Lamplight ktok/mtok tokens', () => {
    expect(formatCount(0)).toBe('0 ktok');
    expect(formatCount(1)).toBe('<1 ktok');
    expect(formatCount(999)).toBe('<1 ktok');
    expect(formatCount(1_000)).toBe('1 ktok');
    expect(formatCount(1_499)).toBe('1 ktok');
    expect(formatCount(1_500)).toBe('2 ktok');
    expect(formatCount(999_999)).toBe('1000 ktok');
    expect(formatCount(1_000_000)).toBe('1 mtok');
    expect(formatCount(193_000_000)).toBe('193 mtok');
  });

  it('clamps non-finite and negative values to zero', () => {
    expect(formatCount(Number.NaN)).toBe('0');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatCount(-5)).toBe('0 ktok');
  });
});

describe('buildSummaryLines', () => {
  it('keeps the Chinese activity line and adds queued and graph counts', () => {
    expect(buildSummaryLines({
      runningWorkerCount: 1,
      queuedCount: 0,
      taskgraphCount: 2,
    })).toEqual(['1 个任务运行中 · 2 张图纸', 'total 0 ktok']);

    expect(buildSummaryLines({
      runningWorkerCount: 2,
      queuedCount: 3,
      taskgraphCount: 1,
    })).toEqual(['2 个任务运行中 · 3 个排队 · 1 张图纸', 'total 0 ktok']);
  });

  it('omits queued and graph segments when they are zero or absent', () => {
    expect(buildSummaryLines({ runningWorkerCount: 0, queuedCount: 0 })).toEqual([
      '0 个任务运行中',
      'total 0 ktok',
    ]);
    expect(buildSummaryLines({ runningWorkerCount: 1, queuedCount: 0, taskgraphCount: 0 })).toEqual([
      '1 个任务运行中',
      'total 0 ktok',
    ]);
  });

  it('renders the sqlite token line with in/out/total', () => {
    expect(buildSummaryLines({
      runningWorkerCount: 1,
      queuedCount: 0,
      taskgraphCount: 2,
      dailyStats: {
        dispatchCount: 7,
        totalTokens: 193_000_000,
        inputTokens: 191_000_000,
        outputTokens: 2_000_000,
        source: 'sqlite',
      },
    })).toEqual(['1 个任务运行中 · 2 张图纸', 'in 191 mtok · out 2 mtok · total 193 mtok']);
  });

  it('keeps the counts and shows the signal-lost line when activity is stale', () => {
    expect(buildSummaryLines({
      runningWorkerCount: 2,
      queuedCount: 1,
      activityStale: true,
      dailyStats: {
        dispatchCount: 1,
        totalTokens: 5,
        inputTokens: 2,
        outputTokens: 3,
        source: 'sqlite',
      },
    })).toEqual(['2 个任务运行中 · 1 个排队', '信号暂失']);
  });

  it('falls back to total/unavailable lines without sqlite stats', () => {
    expect(buildSummaryLines({ runningWorkerCount: 0, queuedCount: 0, dailyStatsUnavailable: true })).toEqual([
      '0 个任务运行中',
      'stats unavailable',
    ]);
    expect(buildSummaryLines({
      runningWorkerCount: 0,
      queuedCount: 0,
      dailyStats: { dispatchCount: 0, totalTokens: 3_000_000, inputTokens: 0, outputTokens: 0, source: 'memory' },
    })).toEqual(['0 个任务运行中', 'total 3 mtok']);
  });
});
