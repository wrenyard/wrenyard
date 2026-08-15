import { describe, expect, it, vi } from 'vitest';
import {
  ForemanStatsPoller,
  normalizeStatsPayload,
  normalizeStatsSummaryPayload,
} from '../src/main/foreman-stats-poller';
import type { DailyStatsSnapshot } from '../src/shared/snapshot';
import type { SummaryStatsPayload } from '../src/main/foreman-stats-poller';

describe('ForemanStatsPoller', () => {
  it('fetches DB-backed daily stats from Foreman service via summary-first', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const seen: DailyStatsSnapshot[] = [];
    const seenSummary: Array<{ daily: DailyStatsSnapshot[] }> = [];
    const poller = new ForemanStatsPoller({
      request: async (method, params) => {
        requests.push({ method, params });
        return {
          daily: [
            {
              dayKey: '2026-06-25',
              startAt: '2026-06-24T16:00:00.000Z',
              endAt: '2026-06-25T16:00:00.000Z',
              dispatchCount: 7,
              inputTokens: 1200,
              outputTokens: 340,
              totalTokens: 1540,
              source: 'sqlite',
            },
          ],
        };
      },
      onStats: (stats) => seen.push(stats),
      onSummaryStats: (summary) => seenSummary.push(summary),
    });

    await poller.pollOnce();

    expect(requests).toEqual([{ method: 'stats.summary', params: { days: 31, limit: 20 } }]);
    expect(seen).toEqual([
      {
        dayKey: '2026-06-25',
        startAt: '2026-06-24T16:00:00.000Z',
        endAt: '2026-06-25T16:00:00.000Z',
        dispatchCount: 7,
        inputTokens: 1200,
        outputTokens: 340,
        totalTokens: 1540,
        source: 'sqlite',
      },
    ]);
    expect(seenSummary).toHaveLength(1);
  });

  it('falls back to stats.today when stats.summary is unavailable (old daemon)', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const seen: DailyStatsSnapshot[] = [];
    const poller = new ForemanStatsPoller({
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === 'stats.summary') {
          throw new Error('method not found');
        }
        return {
          dayKey: '2026-06-27',
          startAt: '2026-06-26T16:00:00.000Z',
          endAt: '2026-06-27T16:00:00.000Z',
          dispatchCount: 3,
          inputTokens: 500,
          outputTokens: 120,
          totalTokens: 620,
          source: 'sqlite',
        };
      },
      onStats: (stats) => seen.push(stats),
    });

    await poller.pollOnce();

    expect(requests).toEqual([
      { method: 'stats.summary', params: { days: 31, limit: 20 } },
      { method: 'stats.today', params: {} },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].dayKey).toBe('2026-06-27');
  });

  it('recovers from sticky summary failure — retries summary on every poll', async () => {
    let callCount = 0;
    const requests: Array<{ method: string; params: unknown }> = [];
    const seenStats: DailyStatsSnapshot[] = [];
    const seenSummary: Array<unknown> = [];

    const poller = new ForemanStatsPoller({
      request: async (method, params) => {
        requests.push({ method, params });
        callCount++;
        if (callCount <= 2) {
          // First two calls (first poll): summary fails
          if (method === 'stats.summary') throw new Error('timeout');
          return {
            dayKey: '2026-06-27',
            startAt: '2026-06-26T16:00:00.000Z',
            endAt: '2026-06-27T16:00:00.000Z',
            dispatchCount: 3,
            inputTokens: 500,
            outputTokens: 120,
            totalTokens: 620,
            source: 'sqlite',
          };
        }
        // Third call (second poll): summary succeeds
        return {
          daily: [
            {
              dayKey: '2026-06-28',
              startAt: '2026-06-27T16:00:00.000Z',
              endAt: '2026-06-28T16:00:00.000Z',
              dispatchCount: 10,
              inputTokens: 2000,
              outputTokens: 500,
              totalTokens: 2500,
              source: 'sqlite',
            },
          ],
        };
      },
      onStats: (stats) => seenStats.push(stats),
      onSummaryStats: (summary) => seenSummary.push(summary),
    });

    // First poll: summary fails → today fallback
    await poller.pollOnce();
    expect(seenStats).toHaveLength(1);
    expect(seenStats[0].dayKey).toBe('2026-06-27');
    expect(seenSummary).toHaveLength(0);

    // Second poll: summary succeeds → publishes full IPC summary
    await poller.pollOnce();
    expect(seenStats).toHaveLength(2);
    expect(seenStats[1].dayKey).toBe('2026-06-28');
    expect(seenSummary).toHaveLength(1);

    // Both polls tried summary first
    expect(requests.filter(r => r.method === 'stats.summary')).toHaveLength(2);
  });

  it('requires 30000ms timeout for stats.summary and exponential backoff on failure, resetting on success', async () => {
    vi.useFakeTimers();

    const calls: Array<{ method: string; params?: unknown; timeoutMs?: number }> = [];
    let summaryAttempt = 0;

    const poller = new ForemanStatsPoller({
      intervalMs: 5000,
      request: async (method, params, options) => {
        calls.push({ method, params, timeoutMs: options?.timeoutMs });
        if (method === 'stats.summary') {
          summaryAttempt++;
          if (summaryAttempt === 1) throw new Error('timeout');
          return {
            daily: [
              {
                dayKey: '2026-06-28',
                startAt: '2026-06-27T16:00:00.000Z',
                endAt: '2026-06-28T16:00:00.000Z',
                dispatchCount: 10,
                inputTokens: 2000,
                outputTokens: 500,
                totalTokens: 2500,
                source: 'sqlite',
              },
            ],
          };
        }
        return {
          dayKey: '2026-06-27',
          startAt: '2026-06-26T16:00:00.000Z',
          endAt: '2026-06-27T16:00:00.000Z',
          dispatchCount: 3,
          inputTokens: 500,
          outputTokens: 120,
          totalTokens: 620,
          source: 'sqlite',
        };
      },
      onStats: () => {},
      onSummaryStats: () => {},
    });

    try {
      poller.start();
      // Flush the immediate pollOnce from start() and its microtask chain
      await vi.advanceTimersByTimeAsync(0);

      // PROOF: stats.summary carries a 30000ms timeout override.
      expect(calls[0]).toHaveProperty('timeoutMs', 30_000);
      // stats.today has no override — timeoutMs is present in the capture record but set to undefined
      expect(calls[1].timeoutMs).toBeUndefined();

      calls.length = 0;

      // Advance exactly one base interval (5000ms) — backoff should prevent firing
      await vi.advanceTimersByTimeAsync(5000);

      // PROOF: After a failed summary, the next scheduled summary should be
      // delayed exponentially (base interval * 2 = 10000ms).
      expect(calls.length).toBe(0);

      // Advance to 10000ms total (5000 more)
      await vi.advanceTimersByTimeAsync(5000);

      // PROOF: summary should fire at 10000ms (2x backoff after first failure)
      expect(calls.length).toBe(1);
      expect(calls[0].method).toBe('stats.summary');
      // summaryAttempt == 2 → returns valid non-empty daily → consecutiveSummaryFailures reset to 0
      expect(calls[0]).toHaveProperty('timeoutMs', 30_000);

      calls.length = 0;

      // Advance another base interval (5000ms) — should fire because reset to base
      await vi.advanceTimersByTimeAsync(5000);

      // PROOF: after successful summary, next poll is at base interval (5000ms)
      expect(calls.length).toBe(1);
      expect(calls[0].method).toBe('stats.summary');
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('does not send stats.today fallback when a stopped generation\'s deferred summary rejects', async () => {
    vi.useFakeTimers();

    let deferredReject!: (err: Error) => void;
    const deferred = new Promise<unknown>((_, reject) => { deferredReject = reject; });

    const todayCalls: string[] = [];
    const statsCalls: DailyStatsSnapshot[] = [];

    const poller = new ForemanStatsPoller({
      intervalMs: 5000,
      request: async (method) => {
        if (method === 'stats.summary') return deferred;
        todayCalls.push(method);
        return {
          dayKey: '2026-07-27',
          startAt: '2026-07-26T16:00:00.000Z',
          endAt: '2026-07-27T16:00:00.000Z',
          dispatchCount: 3,
          inputTokens: 500,
          outputTokens: 120,
          totalTokens: 620,
          source: 'sqlite',
        };
      },
      onStats: (s) => statsCalls.push(s),
    });

    try {
      poller.start(); // generation 1 — pollStats(1) awaits deferred
      await vi.advanceTimersByTimeAsync(0);

      poller.stop(); // generation 2
      poller.start(); // generation 3 — pollOnce(3) hits inFlight, scheduleNext fires
      await vi.advanceTimersByTimeAsync(0);

      deferredReject(new Error('timeout'));
      await vi.advanceTimersByTimeAsync(0);

      // Bug: catch path does not check generation, proceeds to stats.today
      expect(todayCalls).toHaveLength(0);
      expect(statsCalls).toHaveLength(0);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('publishes summary.today when summary has today but empty daily array', async () => {
    vi.useFakeTimers();

    const calls: Array<{ method: string }> = [];
    const todayCalls: string[] = [];
    const statsCalls: DailyStatsSnapshot[] = [];
    const summaryCalls: SummaryStatsPayload[] = [];

    const poller = new ForemanStatsPoller({
      intervalMs: 5000,
      request: async (method) => {
        calls.push({ method });
        if (method === 'stats.summary') {
          return {
            source: 'sqlite',
            today: {
              dayKey: '2026-07-23',
              startAt: '2026-07-22T16:00:00.000Z',
              endAt: '2026-07-23T16:00:00.000Z',
              dispatchCount: 15,
              inputTokens: 5000,
              outputTokens: 8000,
              totalTokens: 13000,
              source: 'sqlite',
            },
            daily: [],
          };
        }
        todayCalls.push(method);
        return {
          dayKey: '2026-07-27',
          startAt: '2026-07-26T16:00:00.000Z',
          endAt: '2026-07-27T16:00:00.000Z',
          dispatchCount: 3,
          inputTokens: 500,
          outputTokens: 120,
          totalTokens: 620,
          source: 'sqlite',
        };
      },
      onStats: (s) => statsCalls.push(s),
      onSummaryStats: (s) => summaryCalls.push(s),
    });

    try {
      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      // First poll: summary with today-only data → publishes, no fallback
      expect(todayCalls).toHaveLength(0);
      expect(statsCalls).toHaveLength(1);
      expect(statsCalls[0].dispatchCount).toBe(15);
      expect(statsCalls[0].dayKey).toBe('2026-07-23');
      expect(summaryCalls).toHaveLength(1);
      expect(calls.filter(c => c.method === 'stats.summary')).toHaveLength(1);

      statsCalls.length = 0;
      todayCalls.length = 0;
      summaryCalls.length = 0;
      calls.length = 0;

      // Advance one base interval — should schedule at base cadence, not backoff
      await vi.advanceTimersByTimeAsync(5000);

      // Second summary fires at base cadence (5000ms), no fallback
      expect(todayCalls).toHaveLength(0);
      expect(calls.filter(c => c.method === 'stats.summary')).toHaveLength(1);
      expect(statsCalls).toHaveLength(1);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('caps backoff at MAX_BACKOFF_MS=60000 when intervalMs=40000 with one summary failure', async () => {
    vi.useFakeTimers();

    const calls: Array<{ method: string; params?: unknown }> = [];
    let summaryAttempt = 0;

    const poller = new ForemanStatsPoller({
      intervalMs: 40000,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'stats.summary') {
          summaryAttempt++;
          if (summaryAttempt === 1) throw new Error('timeout');
          return {
            daily: [
              {
                dayKey: '2026-07-23',
                startAt: '2026-07-22T16:00:00.000Z',
                endAt: '2026-07-23T16:00:00.000Z',
                dispatchCount: 5,
                inputTokens: 100,
                outputTokens: 200,
                totalTokens: 300,
                source: 'sqlite',
              },
            ],
          };
        }
        return {
          dayKey: '2026-07-22',
          startAt: '2026-07-21T16:00:00.000Z',
          endAt: '2026-07-22T16:00:00.000Z',
          dispatchCount: 3,
          inputTokens: 500,
          outputTokens: 120,
          totalTokens: 620,
          source: 'sqlite',
        };
      },
      onStats: () => {},
      onSummaryStats: () => {},
    });

    try {
      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      // First poll: summary fails → today fallback
      expect(calls.filter(c => c.method === 'stats.summary')).toHaveLength(1);
      expect(calls.filter(c => c.method === 'stats.today')).toHaveLength(1);

      calls.length = 0;

      // At 40000ms (base interval): 2x backoff = 80000, but cap is 60000 → should not fire yet
      await vi.advanceTimersByTimeAsync(40000);
      expect(calls.filter(c => c.method === 'stats.summary')).toHaveLength(0);

      // Advance another 20000ms (to 60000ms total from start): should fire at the 60000ms cap
      await vi.advanceTimersByTimeAsync(20000);
      expect(calls.filter(c => c.method === 'stats.summary')).toHaveLength(1);
      // summaryAttempt == 2 → returns valid data
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('rejects non-Foreman or malformed stats payloads', () => {
    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: 1,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      source: 'local',
    })).toThrow();

    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: -1,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      source: 'sqlite',
    })).toThrow();
  });

  it('throws on stats.today payload missing dispatchCount', () => {
    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: 'sqlite',
    })).toThrow();
  });

  it('throws on stats.today payload with NaN dispatchCount', () => {
    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: NaN,
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      source: 'sqlite',
    })).toThrow();
  });

  it('throws on stats.today payload with Infinity totalTokens', () => {
    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: 1,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: Infinity,
      source: 'sqlite',
    })).toThrow();
  });

  it('throws on stats.today payload with wrong source', () => {
    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: 'foreman-remote',
    })).toThrow();
  });

  it('throws on stats.today payload with non-integer dispatchCount', () => {
    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: '7',
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      source: 'sqlite',
    })).toThrow();
  });

  it('throws on stats.today payload with string nested where number expected', () => {
    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: 1,
      inputTokens: 'one',
      outputTokens: 2,
      totalTokens: 3,
      source: 'sqlite',
    })).toThrow();
  });

  it('throws on stats.today payload with negative inputTokens', () => {
    expect(() => normalizeStatsPayload({
      dayKey: '2026-06-25',
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: 1,
      inputTokens: -5,
      outputTokens: 2,
      totalTokens: 3,
      source: 'sqlite',
    })).toThrow();
  });

  it('throws on stats.today payload missing dayKey', () => {
    expect(() => normalizeStatsPayload({
      startAt: '2026-06-24T16:00:00.000Z',
      endAt: '2026-06-25T16:00:00.000Z',
      dispatchCount: 1,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      source: 'sqlite',
    })).toThrow();
  });

  describe('normalizeStatsSummaryPayload', () => {
    it('rejects undefined payload with a thrown error', () => {
      expect(() => normalizeStatsSummaryPayload(undefined)).toThrow();
    });

    it('rejects null payload with a thrown error', () => {
      expect(() => normalizeStatsSummaryPayload(null)).toThrow();
    });

    it('accepts summary payload with top-level source and per-row dayKey/count/token/outcomes (regression)', () => {
      const result = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-06-25',
            count: 7,
            token: 1540,
            outcomes: { inputTokens: 1200, outputTokens: 340 },
          },
        ],
      });
      expect(result).toEqual({
        daily: [
          {
            dayKey: '2026-06-25',
            startAt: '2026-06-24T16:00:00.000Z',
            endAt: '2026-06-25T16:00:00.000Z',
            dispatchCount: 7,
            inputTokens: 1200,
            outputTokens: 340,
            totalTokens: 1540,
            source: 'sqlite',
          },
        ],
        source: 'sqlite',
      });
    });

    it('normalizes current-contract payload preserving all sections and prefers today over daily[0]', async () => {
      const requests: Array<{ method: string; params: unknown }> = [];
      const seenStats: DailyStatsSnapshot[] = [];
      const seenSummary: Array<{ daily: DailyStatsSnapshot[] }> = [];

      const poller = new ForemanStatsPoller({
        request: async (method, params) => {
          requests.push({ method, params });
          return {
            source: 'sqlite',
            today: {
              dayKey: '2026-07-23',
              startAt: '2026-07-22T16:00:00.000Z',
              endAt: '2026-07-23T16:00:00.000Z',
              dispatchCount: 15,
              inputTokens: 5000,
              outputTokens: 8000,
              totalTokens: 13000,
              source: 'sqlite',
              outcomes: { done: 12, failed: 2, cancelled: 1 },
            },
            daily: [
              {
                dayKey: '2026-07-22',
                startAt: '2026-07-21T16:00:00.000Z',
                endAt: '2026-07-22T16:00:00.000Z',
                dispatchCount: 10,
                inputTokens: 3000,
                outputTokens: 5000,
                totalTokens: 8000,
                source: 'sqlite',
                outcomes: { done: 8, failed: 1, cancelled: 1 },
              },
            ],
            byProfile: [
              { profile: 'coder', dispatchCount: 8, inputTokens: 3000, outputTokens: 5000, totalTokens: 8000 },
              { profile: 'writer', dispatchCount: 7, inputTokens: 2000, outputTokens: 3000, totalTokens: 5000 },
            ],
            byTask: [
              { taskName: 'refactor', dispatchCount: 5, inputTokens: 2000, outputTokens: 3000, totalTokens: 5000 },
              { taskName: 'review', dispatchCount: 3, inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 },
            ],
          };
        },
        onStats: (stats) => seenStats.push(stats),
        onSummaryStats: (summary) => seenSummary.push(summary),
      });

      await poller.pollOnce();

      // Normalization result — onStats should receive today (different from daily[0])
      expect(seenStats).toHaveLength(1);
      expect(seenStats[0].dispatchCount).toBe(15); // from today, not daily[0] which has 10
      expect(seenStats[0].dayKey).toBe('2026-07-23');

      // Summary received with all sections
      expect(seenSummary).toHaveLength(1);
      expect(seenSummary[0].today?.dispatchCount).toBe(15);
      expect(seenSummary[0].byProfile).toHaveLength(2);
      expect(seenSummary[0].byProfile![0].profile).toBe('coder');
      expect(seenSummary[0].byProfile![0].dispatchCount).toBe(8);
      expect(seenSummary[0].byTask).toHaveLength(2);
      expect(seenSummary[0].byTask![0].taskName).toBe('refactor');
      expect(seenSummary[0].byTask![0].dispatchCount).toBe(5);

      // Daily outcomes survive normalization
      const normalized = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-07-22',
            startAt: '2026-07-21T16:00:00.000Z',
            endAt: '2026-07-22T16:00:00.000Z',
            dispatchCount: 10,
            inputTokens: 3000,
            outputTokens: 5000,
            totalTokens: 8000,
            source: 'sqlite',
            outcomes: { done: 8, failed: 1, cancelled: 1 },
          },
        ],
      });
      expect(normalized.daily[0].outcomes).toEqual({ done: 8, failed: 1, cancelled: 1 });
    });

    it('normalizes a valid atomic timing capability round-trip', () => {
      const result = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-07-23',
            startAt: '2026-07-22T16:00:00.000Z',
            endAt: '2026-07-23T16:00:00.000Z',
            dispatchCount: 15,
            inputTokens: 5000,
            outputTokens: 8000,
            totalTokens: 13000,
            source: 'sqlite',
          },
        ],
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [
          { taskName: 'refactor', durationMs: 4_440_000 },
          { taskName: 'review', durationMs: 2_040_000 },
          { taskName: 'docs', durationMs: 900_000 },
        ],
      });
      expect(result.totalTaskDurationMs).toBe(8_040_000);
      expect(result.byTaskDuration).toEqual([
        { taskName: 'refactor', durationMs: 4_440_000 },
        { taskName: 'review', durationMs: 2_040_000 },
        { taskName: 'docs', durationMs: 900_000 },
      ]);
      // Non-timing sections still normalize untouched
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0].totalTokens).toBe(13000);
    });

    it('keeps legacy payloads unchanged when both timing fields are absent', () => {
      const result = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-07-23',
            startAt: '2026-07-22T16:00:00.000Z',
            endAt: '2026-07-23T16:00:00.000Z',
            dispatchCount: 15,
            inputTokens: 5000,
            outputTokens: 8000,
            totalTokens: 13000,
            source: 'sqlite',
          },
        ],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
      expect(result).toEqual({
        daily: [
          {
            dayKey: '2026-07-23',
            startAt: '2026-07-22T16:00:00.000Z',
            endAt: '2026-07-23T16:00:00.000Z',
            dispatchCount: 15,
            inputTokens: 5000,
            outputTokens: 8000,
            totalTokens: 13000,
            source: 'sqlite',
          },
        ],
        source: 'sqlite',
      });
    });

    it('omits the timing capability as a unit when only one field is present', () => {
      const onlyTotal = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-07-23',
            startAt: '2026-07-22T16:00:00.000Z',
            endAt: '2026-07-23T16:00:00.000Z',
            dispatchCount: 15,
            inputTokens: 5000,
            outputTokens: 8000,
            totalTokens: 13000,
            source: 'sqlite',
          },
        ],
        totalTaskDurationMs: 8_040_000,
      });
      expect(onlyTotal).not.toHaveProperty('totalTaskDurationMs');
      expect(onlyTotal).not.toHaveProperty('byTaskDuration');

      const onlyRows = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-07-23',
            startAt: '2026-07-22T16:00:00.000Z',
            endAt: '2026-07-23T16:00:00.000Z',
            dispatchCount: 15,
            inputTokens: 5000,
            outputTokens: 8000,
            totalTokens: 13000,
            source: 'sqlite',
          },
        ],
        byTaskDuration: [{ taskName: 'refactor', durationMs: 1000 }],
      });
      expect(onlyRows).not.toHaveProperty('totalTaskDurationMs');
      expect(onlyRows).not.toHaveProperty('byTaskDuration');
    });

    it.each([
      ['negative total', -1],
      ['fractional total', 1.5],
      ['NaN total', NaN],
      ['Infinity total', Infinity],
      ['string total', '1000'],
    ])('omits timing when totalTaskDurationMs is malformed (%s)', (_label, total) => {
      const result = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-07-23',
            startAt: '2026-07-22T16:00:00.000Z',
            endAt: '2026-07-23T16:00:00.000Z',
            dispatchCount: 15,
            inputTokens: 5000,
            outputTokens: 8000,
            totalTokens: 13000,
            source: 'sqlite',
          },
        ],
        totalTaskDurationMs: total,
        byTaskDuration: [{ taskName: 'refactor', durationMs: 1000 }],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
      expect(result.daily).toHaveLength(1);
    });

    it.each([
      ['missing taskName', { taskName: '', durationMs: 1000 }],
      ['non-string taskName', { taskName: 5, durationMs: 1000 }],
      ['negative durationMs', { taskName: 'refactor', durationMs: -1 }],
      ['fractional durationMs', { taskName: 'refactor', durationMs: 1.5 }],
      ['NaN durationMs', { taskName: 'refactor', durationMs: NaN }],
      ['Infinity durationMs', { taskName: 'refactor', durationMs: Infinity }],
      ['string durationMs', { taskName: 'refactor', durationMs: '1000' }],
      ['non-object row', 'refactor'],
    ])('omits timing when a byTaskDuration row is malformed (%s)', (_label, row) => {
      const result = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-07-23',
            startAt: '2026-07-22T16:00:00.000Z',
            endAt: '2026-07-23T16:00:00.000Z',
            dispatchCount: 15,
            inputTokens: 5000,
            outputTokens: 8000,
            totalTokens: 13000,
            source: 'sqlite',
          },
        ],
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [row],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
    });

    it('keeps valid zero timing so the renderer can show the empty state', () => {
      const result = normalizeStatsSummaryPayload({
        source: 'sqlite',
        daily: [
          {
            dayKey: '2026-07-23',
            startAt: '2026-07-22T16:00:00.000Z',
            endAt: '2026-07-23T16:00:00.000Z',
            dispatchCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            source: 'sqlite',
          },
        ],
        totalTaskDurationMs: 0,
        byTaskDuration: [],
      });
      expect(result.totalTaskDurationMs).toBe(0);
      expect(result.byTaskDuration).toEqual([]);
    });

    it('malformed timing does not mutate retry/fallback behavior (summary still publishes)', async () => {
      const requests: Array<{ method: string }> = [];
      const statsCalls: DailyStatsSnapshot[] = [];
      const summaryCalls: Array<SummaryStatsPayload> = [];

      const poller = new ForemanStatsPoller({
        request: async (method) => {
          requests.push({ method });
          if (method === 'stats.summary') {
            return {
              source: 'sqlite',
              today: {
                dayKey: '2026-07-23',
                startAt: '2026-07-22T16:00:00.000Z',
                endAt: '2026-07-23T16:00:00.000Z',
                dispatchCount: 15,
                inputTokens: 5000,
                outputTokens: 8000,
                totalTokens: 13000,
                source: 'sqlite',
              },
              daily: [],
              totalTaskDurationMs: 8_040_000,
              byTaskDuration: [{ taskName: 'refactor', durationMs: -1 }],
            };
          }
          throw new Error('stats.today should not be reached');
        },
        onStats: (s) => statsCalls.push(s),
        onSummaryStats: (s) => summaryCalls.push(s),
      });

      await poller.pollOnce();

      // Summary path succeeds despite malformed timing — no fallback, no retry state change
      expect(requests.map((r) => r.method)).toEqual(['stats.summary']);
      expect(statsCalls).toHaveLength(1);
      expect(statsCalls[0].dispatchCount).toBe(15);
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0]).not.toHaveProperty('totalTaskDurationMs');
      expect(summaryCalls[0]).not.toHaveProperty('byTaskDuration');
    });

    const timingBase = {
      source: 'sqlite',
      today: {
        dayKey: '2026-07-23',
        startAt: '2026-07-22T16:00:00.000Z',
        endAt: '2026-07-23T16:00:00.000Z',
        dispatchCount: 15,
        inputTokens: 5000,
        outputTokens: 8000,
        totalTokens: 13000,
        source: 'sqlite',
      },
      daily: [
        {
          dayKey: '2026-07-22',
          startAt: '2026-07-21T16:00:00.000Z',
          endAt: '2026-07-22T16:00:00.000Z',
          dispatchCount: 10,
          inputTokens: 3000,
          outputTokens: 5000,
          totalTokens: 8000,
          source: 'sqlite',
        },
      ],
      byProfile: [{ profile: 'coder', dispatchCount: 8, inputTokens: 3000, outputTokens: 5000, totalTokens: 8000 }],
      byTask: [{ taskName: 'refactor', dispatchCount: 5, inputTokens: 2000, outputTokens: 3000, totalTokens: 5000 }],
    };

    it('accepts valid zero total with empty rows', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 0,
        byTaskDuration: [],
      });
      expect(result.totalTaskDurationMs).toBe(0);
      expect(result.byTaskDuration).toEqual([]);
    });

    it('rejects zero total with non-empty rows', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 0,
        byTaskDuration: [{ taskName: 'refactor', durationMs: 1000 }],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
    });

    it('rejects positive total with empty rows', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
    });

    it('rejects positive total with only zero-duration rows', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [
          { taskName: 'refactor', durationMs: 0 },
          { taskName: 'review', durationMs: 0 },
        ],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
    });

    it('rejects any row whose duration exceeds the total', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [
          { taskName: 'refactor', durationMs: 9_000_000 },
          { taskName: 'review', durationMs: 1000 },
        ],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
    });

    it('rejects multiple rows whose summed durations exceed the total', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [
          { taskName: 'refactor', durationMs: 4_440_000 },
          { taskName: 'review', durationMs: 4_000_000 },
        ],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
    });

    it('accepts rows whose summed durations equal the total', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [
          { taskName: 'refactor', durationMs: 4_040_000 },
          { taskName: 'review', durationMs: 4_000_000 },
        ],
      });
      expect(result.totalTaskDurationMs).toBe(8_040_000);
      expect(result.byTaskDuration).toEqual([
        { taskName: 'refactor', durationMs: 4_040_000 },
        { taskName: 'review', durationMs: 4_000_000 },
      ]);
    });

    it('accepts truncated rows whose summed durations are below the total', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [
          { taskName: 'refactor', durationMs: 4_440_000 },
          { taskName: 'review', durationMs: 2_040_000 },
        ],
      });
      expect(result.totalTaskDurationMs).toBe(8_040_000);
      expect(result.byTaskDuration).toEqual([
        { taskName: 'refactor', durationMs: 4_440_000 },
        { taskName: 'review', durationMs: 2_040_000 },
      ]);
    });

    it('rejection omits both timing fields while preserving non-timing summary fields and fallback state', () => {
      const result = normalizeStatsSummaryPayload({
        ...timingBase,
        totalTaskDurationMs: 8_040_000,
        byTaskDuration: [
          { taskName: 'refactor', durationMs: 4_440_000 },
          { taskName: 'review', durationMs: 4_000_000 },
        ],
      });
      expect(result).not.toHaveProperty('totalTaskDurationMs');
      expect(result).not.toHaveProperty('byTaskDuration');
      // today, daily/history, token rankings and outcomes survive intact
      expect(result.today?.dispatchCount).toBe(15);
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0].totalTokens).toBe(8000);
      expect(result.byProfile).toHaveLength(1);
      expect(result.byProfile![0].profile).toBe('coder');
      expect(result.byTask).toHaveLength(1);
      expect(result.byTask![0].taskName).toBe('refactor');
      expect(result.source).toBe('sqlite');
    });
  });

  describe('windows capability — atomic validation', () => {
    const baseWindow = (period: '24h' | '7d' | '1mo'): unknown => ({
      period,
      startAt: '2026-06-29T16:00:00.000Z',
      endAt: '2026-06-30T16:00:00.000Z',
      dispatchCount: 10,
      totalTokens: 1000,
      byProfile: [{ profile: 'architect', runCount: 5, totalTokens: 500, averageTps: 12.345 }],
      taskStats: {
        totalDurationMs: 600000,
        byTask: [{ taskId: 'refactor', source: 'builtin', runCount: 3, durationMs: 400000 }],
        builtinTotalDurationMs: 400000,
        byBuiltinTask: [{ taskId: 'refactor', runCount: 3, durationMs: 400000 }],
      },
    });

    const makeSummary = (windows: unknown): unknown => ({
      source: 'sqlite',
      daily: [
        {
          dayKey: '2026-06-30',
          startAt: '2026-06-29T16:00:00.000Z',
          endAt: '2026-06-30T16:00:00.000Z',
          dispatchCount: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 1,
          source: 'sqlite',
        },
      ],
      windows,
    });

    it('accepts an exact coherent three-window payload including unknown task rows', () => {
      const windows = [
        {
          ...(baseWindow('24h') as object),
          dispatchCount: 31,
          totalTokens: 93000,
          byProfile: [
            { profile: 'architect', runCount: 14, totalTokens: 1500000, averageTps: 41.5 },
            { profile: 'scribe', runCount: 10, totalTokens: 240000, averageTps: null },
            { profile: 'taskmaster', runCount: 7, totalTokens: 90000 },
          ],
          taskStats: {
            totalDurationMs: 8040000,
            byTask: [
              { taskId: 'refactor', source: 'builtin', runCount: 9, durationMs: 4440000 },
              { taskId: 'docs', source: 'project', runCount: 6, durationMs: 900000 },
              { taskId: 'legacy-run', source: 'unknown', runCount: 2, durationMs: 30000 },
            ],
            builtinTotalDurationMs: 7080000,
            byBuiltinTask: [
              { taskId: 'refactor', runCount: 9, durationMs: 4440000 },
              { taskId: 'review', runCount: 8, durationMs: 2040000 },
            ],
          },
        },
        baseWindow('7d'),
        baseWindow('1mo'),
      ];

      const result = normalizeStatsSummaryPayload(makeSummary(windows) as any);
      expect(result.windows).toHaveLength(3);
      expect(result.windows!.map((w) => w.period)).toEqual(['24h', '7d', '1mo']);
      const w24 = result.windows![0];
      expect(w24.dispatchCount).toBe(31);
      expect(w24.totalTokens).toBe(93000);
      expect(w24.byProfile).toHaveLength(3);
      expect(w24.byProfile[0].averageTps).toBe(41.5);
      // null averageTps is treated as absent
      expect(w24.byProfile[1].averageTps).toBeUndefined();
      expect(w24.byProfile[2].averageTps).toBeUndefined();
      expect(w24.taskStats.byTask).toHaveLength(3);
      expect(w24.taskStats.byTask[2]).toEqual({ taskId: 'legacy-run', source: 'unknown', runCount: 2, durationMs: 30000 });
      expect(w24.taskStats.builtinTotalDurationMs).toBe(7080000);
      expect(w24.taskStats.byBuiltinTask).toHaveLength(2);
    });

    it.each<[string, (windows: unknown[]) => unknown[]]>([
      ['non-array', () => '24h'],
      ['wrong count', (w) => w.slice(0, 2)],
      ['wrong period order', (w) => [w[1], w[0], w[2]]],
      ['missing startAt', (w) => [{ ...w[0], startAt: undefined }, w[1], w[2]]],
      ['missing endAt', (w) => [{ ...w[0], endAt: undefined }, w[1], w[2]]],
      ['negative dispatchCount', (w) => [{ ...w[0], dispatchCount: -1 }, w[1], w[2]]],
      ['NaN totalTokens', (w) => [{ ...w[0], totalTokens: NaN }, w[1], w[2]]],
      ['string totalTokens', (w) => [{ ...w[0], totalTokens: '1000' }, w[1], w[2]]],
      ['missing byProfile', (w) => [{ ...w[0], byProfile: undefined }, w[1], w[2]]],
      ['non-array byProfile', (w) => [{ ...w[0], byProfile: {} }, w[1], w[2]]],
      ['Infinity averageTps', (w) => [{ ...w[0], byProfile: [{ profile: 'a', runCount: 1, totalTokens: 1, averageTps: Infinity }] }, w[1], w[2]]],
      ['string averageTps', (w) => [{ ...w[0], byProfile: [{ profile: 'a', runCount: 1, totalTokens: 1, averageTps: '12' }] }, w[1], w[2]]],
      ['missing taskStats', (w) => [{ ...w[0], taskStats: undefined }, w[1], w[2]]],
      ['bad task source', (w) => [{ ...w[0], taskStats: { ...(w[0] as any).taskStats, byTask: [{ taskId: 'x', source: 'projectx', runCount: 1, durationMs: 1 }] } }, w[1], w[2]]],
      ['negative durationMs', (w) => [{ ...w[0], taskStats: { ...(w[0] as any).taskStats, byTask: [{ taskId: 'x', source: 'builtin', runCount: 1, durationMs: -1 }] } }, w[1], w[2]]],
      ['missing byBuiltinTask', (w) => [{ ...w[0], taskStats: { ...(w[0] as any).taskStats, byBuiltinTask: undefined } }, w[1], w[2]]],
      ['empty taskId in byBuiltinTask', (w) => [{ ...w[0], taskStats: { ...(w[0] as any).taskStats, byBuiltinTask: [{ taskId: '', runCount: 1, durationMs: 1 }] } }, w[1], w[2]]],
      ['missing totalDurationMs', (w) => [{ ...w[0], taskStats: { ...(w[0] as any).taskStats, totalDurationMs: undefined } }, w[1], w[2]]],
    ])('rejects partial/malformed windows — %s', (_label, mutate) => {
      const windows = [baseWindow('24h'), baseWindow('7d'), baseWindow('1mo')];
      expect(() => normalizeStatsSummaryPayload(makeSummary(mutate(windows)) as any)).toThrow();
    });

    it('malformed windows falls back to stats.today at the poller level', async () => {
      const requests: Array<{ method: string }> = [];
      const statsCalls: DailyStatsSnapshot[] = [];
      const summaryCalls: SummaryStatsPayload[] = [];

      const poller = new ForemanStatsPoller({
        request: async (method) => {
          requests.push({ method });
          if (method === 'stats.summary') {
            return {
              source: 'sqlite',
              today: {
                dayKey: '2026-06-30',
                startAt: '2026-06-29T16:00:00.000Z',
                endAt: '2026-06-30T16:00:00.000Z',
                dispatchCount: 31,
                inputTokens: 1000,
                outputTokens: 2000,
                totalTokens: 3000,
                source: 'sqlite',
              },
              daily: [],
              windows: [baseWindow('24h')], // partial — only one window
            };
          }
          return {
            dayKey: '2026-06-30',
            startAt: '2026-06-29T16:00:00.000Z',
            endAt: '2026-06-30T16:00:00.000Z',
            dispatchCount: 31,
            inputTokens: 1000,
            outputTokens: 2000,
            totalTokens: 3000,
            source: 'sqlite',
          };
        },
        onStats: (s) => statsCalls.push(s),
        onSummaryStats: (s) => summaryCalls.push(s),
      });

      await poller.pollOnce();

      // Malformed windows rejects the summary and degrades to stats.today
      expect(requests.map((r) => r.method)).toEqual(['stats.summary', 'stats.today']);
      expect(summaryCalls).toHaveLength(0);
      expect(statsCalls).toHaveLength(1);
      expect(statsCalls[0].dispatchCount).toBe(31);
    });
  });
});
