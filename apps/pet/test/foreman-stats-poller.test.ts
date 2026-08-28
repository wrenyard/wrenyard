import { describe, expect, it, vi } from 'vitest';
import {
  ForemanStatsPoller,
  normalizeStatsPayload,
} from '../src/main/foreman-stats-poller';

const payload = {
  dayKey: '2026-08-28',
  startAt: '2026-08-27T16:00:00.000Z',
  endAt: '2026-08-28T16:00:00.000Z',
  dispatchCount: 12,
  inputTokens: 3_000,
  outputTokens: 900,
  totalTokens: 3_900,
  source: 'sqlite',
} as const;

describe('ForemanStatsPoller observational boundary', () => {
  it('requests only the bounded today projection', async () => {
    const request = vi.fn(async () => payload);
    const onStats = vi.fn();
    const poller = new ForemanStatsPoller({ request, onStats });

    await poller.pollOnce();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('stats.today', {});
    expect(onStats).toHaveBeenCalledWith(payload);
  });

  it('reports unavailable when the request or payload fails', async () => {
    const onUnavailable = vi.fn();
    const poller = new ForemanStatsPoller({
      request: async () => ({ ...payload, totalTokens: -1 }),
      onStats: vi.fn(),
      onUnavailable,
    });

    await poller.pollOnce();

    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping polls', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    const request = vi.fn(() => new Promise<unknown>((resolve) => { resolveRequest = resolve; }));
    const onStats = vi.fn();
    const poller = new ForemanStatsPoller({ request, onStats });

    const first = poller.pollOnce();
    const second = poller.pollOnce();
    resolveRequest?.(payload);
    await Promise.all([first, second]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledTimes(1);
  });

  it('suppresses stale callbacks after stop', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    const onStats = vi.fn();
    const poller = new ForemanStatsPoller({
      request: () => new Promise<unknown>((resolve) => { resolveRequest = resolve; }),
      onStats,
    });

    poller.start();
    poller.stop();
    resolveRequest?.(payload);
    await Promise.resolve();
    await Promise.resolve();

    expect(onStats).not.toHaveBeenCalled();
  });
});

describe('normalizeStatsPayload', () => {
  it('accepts the public stats.today projection', () => {
    expect(normalizeStatsPayload(payload)).toEqual(payload);
  });

  it.each([
    null,
    [],
    { ...payload, source: 'memory' },
    { ...payload, dayKey: 1 },
    { ...payload, dispatchCount: Number.NaN },
    { ...payload, inputTokens: -1 },
  ])('rejects malformed or unbounded payload %#', (value) => {
    expect(() => normalizeStatsPayload(value)).toThrow(TypeError);
  });
});
