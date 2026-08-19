import { describe, expect, it } from 'vitest';
import { buildQuotaTips, formatQuotaBarMenuRows } from '../src/main/panel-view-model';
import type { QuotaProviderState } from '../src/shared/entities';

describe('quota panel view model', () => {
  it('projects structured bar data into quota tips while retaining all enabled providers including error/unavailable', () => {
    const providers: QuotaProviderState[] = [
      {
        id: 'codex',
        label: 'Codex',
        displayLine: 'Codex 5h 60% · 7d 40%',
        error: null,
        status: 'ok',
        stale: false,
        bars: {
          remainingPct: 55,
          expectedRemainingPct: 30,
          windows: [
            { name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 },
            { name: '7d', usedPct: 60, remainingPct: 40, expectedRemainingPct: 25 },
          ],
        },
      },
      {
        id: 'openai',
        label: 'OpenAI',
        displayLine: null,
        error: 'rate limited',
        status: 'error',
        stale: false,
      },
      {
        id: 'gemini',
        label: 'Gemini',
        displayLine: null,
        error: null,
        status: 'unavailable',
        stale: true,
      },
    ];

    const order = ['codex', 'openai', 'gemini'];
    const tips = buildQuotaTips(providers, order);

    expect(tips).toHaveLength(3);
    // Codex should have bars projected
    expect(tips[0].bars).toBeDefined();
    expect(tips[0].bars).toHaveLength(1);
    expect(tips[0].bars![0].label).toBe('codex');
    expect(tips[0].bars![0].provider.windows).toHaveLength(2);
    expect(tips[0].bars![0].provider.windows[0].remainingPct).toBe(60);
    expect(tips[0].bars![0].provider.windows[0].expectedRemainingPct).toBe(45);
    expect(tips[0].text).toBe('codex 5h 60% remain · 7d 40% remain');

    // OpenAI (error) included with structured bar and errorRow
    expect(tips[1].bars).toBeDefined();
    expect(tips[1].bars).toHaveLength(1);
    expect(tips[1].bars![0].status).toBe('error');
    expect(tips[1].errorRow).toBeDefined();
    expect(tips[1].errorRow!.label).toBe('openai');
    expect(tips[1].errorRow!.message).toBe('error — rate limited');
    expect(tips[1].text).toBe('openai error — rate limited');

    // Gemini (unavailable) included with structured bar and errorRow
    expect(tips[2].bars).toBeDefined();
    expect(tips[2].bars).toHaveLength(1);
    expect(tips[2].bars![0].status).toBe('unavailable');
    expect(tips[2].errorRow).toBeDefined();
    expect(tips[2].errorRow!.label).toBe('gemini');
    expect(tips[2].errorRow!.message).toBe('unavailable');
    expect(tips[2].text).toBe('gemini unavailable');
  });

  it('projects single-window, double-window, and Kimi three-window bar data', () => {
    const singleWindow: QuotaProviderState = {
      id: 'codex',
      label: 'Codex',
      displayLine: 'Codex 7d 25%',
      error: null,
      status: 'ok',
      stale: false,
      bars: {
        remainingPct: 25,
        expectedRemainingPct: null,
        windows: [
          { name: '7d', usedPct: 75, remainingPct: 25, expectedRemainingPct: null },
        ],
      },
    };

    const doubleWindow: QuotaProviderState = {
      id: 'openai',
      label: 'OpenAI',
      displayLine: 'OpenAI 5h 60% · 7d 40%',
      error: null,
      status: 'ok',
      stale: false,
      bars: {
        remainingPct: 55,
        expectedRemainingPct: 30,
        windows: [
          { name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 },
          { name: '7d', usedPct: 60, remainingPct: 40, expectedRemainingPct: 25 },
        ],
      },
    };

    const threeWindow: QuotaProviderState = {
      id: 'kimi-coding',
      label: 'kimi',
      displayLine: 'kimi 5h 20% · 7d 40% · 1mo 73%',
      error: null,
      status: 'ok',
      stale: false,
      bars: {
        remainingPct: 27.5,
        expectedRemainingPct: null,
        windows: [
          { name: '5h', usedPct: 20, remainingPct: 80, expectedRemainingPct: 90 },
          { name: '7d', usedPct: 40, remainingPct: 60, expectedRemainingPct: 50 },
          { name: '1mo', usedPct: 72.5, remainingPct: 27.5, expectedRemainingPct: null },
        ],
      },
    };

    const tips = buildQuotaTips([singleWindow, doubleWindow, threeWindow], ['codex', 'openai', 'kimi-coding']);
    expect(tips).toHaveLength(3);

    // Single window
    expect(tips[0].bars![0].provider.windows).toHaveLength(1);
    expect(tips[0].bars![0].provider.windows[0].remainingPct).toBe(25);
    expect(tips[0].text).toBe('codex 7d 25% remain');

    // Double window
    expect(tips[1].bars![0].provider.windows).toHaveLength(2);
    expect(tips[1].bars![0].provider.windows[1].name).toBe('7d');
    expect(tips[1].bars![0].provider.windows[1].remainingPct).toBe(40);
    expect(tips[1].text).toBe('openai 5h 60% remain · 7d 40% remain');

    // Kimi three-pool quota remains one grouped provider in the tips card.
    expect(tips[2].bars).toHaveLength(1);
    expect(tips[2].bars![0].label).toBe('kimi-coding');
    expect(tips[2].bars![0].provider.windows.map((window) => window.name)).toEqual(['5h', '7d', '1mo']);
    expect(tips[2].text).toBe('kimi-coding 5h 80% remain · 7d 60% remain · 1mo 28% remain');
  });

  it('propagates provider-agnostic Forge pending message for status rows', () => {
    const pendingProvider: QuotaProviderState = {
      id: 'codex',
      label: 'Codex',
      displayLine: null,
      error: 'Sign-in is in progress. Approve the request if prompted; Forge will refresh quota automatically.',
      status: 'pending' as QuotaProviderState['status'],
      stale: false,
      bars: {
        remainingPct: null,
        expectedRemainingPct: null,
        windows: [],
      },
    };

    const tips = buildQuotaTips([pendingProvider], ['codex']);
    expect(tips).toHaveLength(1);
    // The Forge-provided pending message is rendered verbatim (not Pet-owned copy)
    expect(tips[0].text).toBe('codex Sign-in is in progress. Approve the request if prompted; Forge will refresh quota automatically.');
    // Structured errorRow carries the same message
    expect(tips[0].errorRow).toBeDefined();
    expect(tips[0].errorRow!.label).toBe('codex');
    expect(tips[0].errorRow!.message).toBe('Sign-in is in progress. Approve the request if prompted; Forge will refresh quota automatically.');
    // One non-ok bar row with null percentages and pending status
    expect(tips[0].bars).toBeDefined();
    expect(tips[0].bars!).toHaveLength(1);
    expect(tips[0].bars![0].status).toBe('pending');
    expect(tips[0].bars![0].provider.remainingPct).toBeNull();
  });

  it('provides structured generic error row with label and message without colon', () => {
    const genError: QuotaProviderState = {
      id: 'openai',
      label: 'OpenAI',
      displayLine: null,
      error: 'rate limited',
      status: 'error',
      stale: false,
      bars: {
        remainingPct: null,
        expectedRemainingPct: null,
        windows: [],
      },
    };

    const tips = buildQuotaTips([genError], ['openai']);
    expect(tips).toHaveLength(1);
    // Display text must not contain a colon
    expect(tips[0].text).not.toContain(':');
    expect(tips[0].text).toBe('openai error — rate limited');
    // Must have structured errorRow
    expect(tips[0].errorRow).toBeDefined();
    expect(tips[0].errorRow!.label).toBe('openai');
    expect(tips[0].errorRow!.message).toBe('error — rate limited');
    // Must have structured bar row
    expect(tips[0].bars).toBeDefined();
    expect(tips[0].bars!).toHaveLength(1);
    expect(tips[0].bars![0].label).toBe('openai');
    expect(tips[0].bars![0].error).toBe('rate limited');
    // Must not fabricate quota percentages
    expect(tips[0].bars![0].provider.remainingPct).toBeNull();
  });

  it('uses provider id (not label) for bar label and errorRow label to avoid collapsing codex-spark→spark', () => {
    // Forge quota JSON maps pool→id (true provider name) and label→model-family label.
    // buildQuotaTips must use p.id so "codex-spark" does not collapse to "spark".
    const provider: QuotaProviderState = {
      id: 'codex-spark',
      label: 'spark',
      displayLine: 'spark 7d 25%',
      error: null,
      status: 'ok',
      stale: false,
      bars: {
        remainingPct: 25,
        expectedRemainingPct: null,
        windows: [{ name: '7d', usedPct: 75, remainingPct: 25, expectedRemainingPct: null }],
      },
    };

    const tips = buildQuotaTips([provider], ['codex-spark']);
    expect(tips).toHaveLength(1);
    expect(tips[0].bars).toBeDefined();
    expect(tips[0].bars![0].label).toBe('codex-spark');
    // Healthy tip text normalises family-label prefix to provider id
    expect(tips[0].text).toBe('codex-spark 7d 25% remain');
  });

  it('uses provider id (not label) for errorRow label to avoid collapsing kimi-coding→kimi', () => {
    const provider: QuotaProviderState = {
      id: 'kimi-coding',
      label: 'kimi',
      displayLine: null,
      error: 'rate limited',
      status: 'error',
      stale: false,
      bars: {
        remainingPct: null,
        expectedRemainingPct: null,
        windows: [],
      },
    };

    const tips = buildQuotaTips([provider], ['kimi-coding']);
    expect(tips).toHaveLength(1);
    expect(tips[0].errorRow).toBeDefined();
    expect(tips[0].errorRow!.label).toBe('kimi-coding');
  });

  it('projects provider-level bars with empty windows into one synthetic quota lane', () => {
    const provider: QuotaProviderState = {
      id: 'codex',
      label: 'Codex',
      displayLine: 'Codex month 55%',
      error: null,
      status: 'ok',
      stale: false,
      bars: {
        remainingPct: 55,
        expectedRemainingPct: 30,
        windows: [],
      },
    };

    const tips = buildQuotaTips([provider], ['codex']);
    expect(tips).toHaveLength(1);
    expect(tips[0].bars).toBeDefined();
    expect(tips[0].bars!).toHaveLength(1);

    const bar = tips[0].bars![0];
    expect(bar.label).toBe('codex');
    // Provider-level remaining/expected copied
    expect(bar.provider.remainingPct).toBe(55);
    expect(bar.provider.expectedRemainingPct).toBe(30);
    // Should have exactly one synthetic window named 'quota'
    expect(bar.provider.windows).toHaveLength(1);
    expect(bar.provider.windows[0].name).toBe('quota');
    expect(bar.provider.windows[0].remainingPct).toBe(55);
    expect(bar.provider.windows[0].expectedRemainingPct).toBe(30);
    expect(tips[0].text).toBe('codex quota 55% remain');
  });

  it('copies Forge pace and reset onto remaining window percents', () => {
    const provider: QuotaProviderState = {
      id: 'kimi-coding',
      label: 'kimi',
      displayLine: 'kimi 5h 20% · 7d 40% (+8%) · 4h 21m reset',
      error: null,
      status: 'ok',
      stale: false,
      bars: {
        remainingPct: 60,
        expectedRemainingPct: 52,
        windows: [
          { name: '5h', usedPct: 20, remainingPct: 80, expectedRemainingPct: 90 },
          { name: '7d', usedPct: 40, remainingPct: 60, expectedRemainingPct: 52 },
        ],
      },
    };

    const tips = buildQuotaTips([provider], ['kimi-coding']);
    expect(tips[0].text).toBe('kimi-coding 5h 80% remain · 7d 60% remain (+8%) · 4h 21m reset');
  });

  it('formats remaining bar rows for the tray submenu', () => {
    const tips = buildQuotaTips([
      {
        id: 'kimi-coding',
        label: 'kimi',
        displayLine: 'kimi 5h 20% · 7d 40%',
        error: null,
        status: 'ok',
        stale: false,
        bars: {
          remainingPct: 60,
          expectedRemainingPct: 52,
          windows: [
            { name: '5h', usedPct: 0, remainingPct: 100, expectedRemainingPct: null },
            { name: '7d', usedPct: 3, remainingPct: 97, expectedRemainingPct: 52 },
          ],
        },
      },
      {
        id: 'codex',
        label: 'Codex',
        displayLine: null,
        error: 'initialize failed',
        status: 'error',
        stale: false,
      },
    ], ['kimi-coding', 'codex']);

    const rows = formatQuotaBarMenuRows(tips);
    expect(rows).toEqual([
      {
        provider: 'kimi-coding',
        window: '5h',
        remainingPct: 100,
        expectedRemainingPct: null,
        label: 'kimi-coding 5h 100% remain',
      },
      {
        provider: '',
        window: '7d',
        remainingPct: 97,
        expectedRemainingPct: 52,
        label: 'kimi-coding 7d 97% remain',
      },
      {
        provider: 'codex',
        window: '',
        remainingPct: null,
        expectedRemainingPct: null,
        error: 'error — initialize failed',
        label: 'codex  error — initialize failed',
      },
    ]);
  });
});
