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
    expect(tips[0].text).toBe('codex 5h 60% · 7d 40%');

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
    expect(tips[0].text).toBe('codex 7d 25%');

    // Double window
    expect(tips[1].bars![0].provider.windows).toHaveLength(2);
    expect(tips[1].bars![0].provider.windows[1].name).toBe('7d');
    expect(tips[1].bars![0].provider.windows[1].remainingPct).toBe(40);
    expect(tips[1].text).toBe('openai 5h 60% · 7d 40%');

    // Kimi three-pool quota remains one grouped provider in the tips card.
    expect(tips[2].bars).toHaveLength(1);
    expect(tips[2].bars![0].label).toBe('kimi-coding');
    expect(tips[2].bars![0].provider.windows.map((window) => window.name)).toEqual(['5h', '7d', '1mo']);
    expect(tips[2].text).toBe('kimi-coding 5h 80% · 7d 60% · 1mo 27%');
  });

  it('floors fractional remaining percentages in tips and tray rows', () => {
    const provider: QuotaProviderState = {
      id: 'cursor',
      label: 'Cursor',
      displayLine: 'Cursor 99.4% · Other 99.8%',
      error: null,
      status: 'ok',
      stale: false,
      bars: {
        remainingPct: 99.8,
        expectedRemainingPct: null,
        windows: [
          { name: 'Cursor', usedPct: 0.6, remainingPct: 99.4, expectedRemainingPct: null },
          { name: 'Other', usedPct: 0.2, remainingPct: 99.8, expectedRemainingPct: null },
        ],
      },
    };

    const tips = buildQuotaTips([provider], ['cursor']);
    expect(tips[0].text).toBe('cursor Cursor 99% · Other 99%');

    const rows = formatQuotaBarMenuRows(tips);
    expect(rows.map((row) => row.remainingPct)).toEqual([99, 99]);
    expect(rows.map((row) => row.label)).toEqual([
      'cursor Cursor 99%',
      'cursor Other 99%',
    ]);
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
    expect(tips[0].text).toBe('codex-spark 7d 25%');
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
    expect(tips[0].text).toBe('codex quota 55%');
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
    expect(tips[0].text).toBe('kimi-coding 5h 80% · 7d 60% (+8%) · 4h 21m reset');
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
        label: 'kimi-coding 5h 100%',
      },
      {
        provider: '',
        window: '7d',
        remainingPct: 97,
        expectedRemainingPct: 52,
        label: 'kimi-coding 7d 97%',
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

  it('preserves Cursor Cursor/Other windows through tips and tray submenu rows', () => {
    const cursor: QuotaProviderState = {
      id: 'cursor',
      label: 'Cursor',
      displayLine: 'Cursor Cursor 62% · Other 40%',
      error: null,
      status: 'ok',
      stale: false,
      bars: {
        remainingPct: 62,
        expectedRemainingPct: null,
        windows: [
          { name: 'Cursor', usedPct: 38, remainingPct: 62, expectedRemainingPct: null },
          { name: 'Other', usedPct: 60, remainingPct: 40, expectedRemainingPct: null },
        ],
      },
    };

    const tips = buildQuotaTips([cursor], ['cursor']);
    expect(tips).toHaveLength(1);
    expect(tips[0].bars).toBeDefined();
    expect(tips[0].bars!).toHaveLength(1);
    expect(tips[0].bars![0].label).toBe('cursor');
    // Generic formatting preserves Cursor/Other order and remaining percentages
    expect(tips[0].bars![0].provider.windows.map((window) => window.name)).toEqual(['Cursor', 'Other']);
    expect(tips[0].bars![0].provider.windows.map((window) => window.remainingPct)).toEqual([62, 40]);
    expect(tips[0].text).toBe('cursor Cursor 62% · Other 40%');

    // Tray submenu rows preserve the same order and remaining percentages
    const rows = formatQuotaBarMenuRows(tips);
    expect(rows).toEqual([
      {
        provider: 'cursor',
        window: 'Cursor',
        remainingPct: 62,
        expectedRemainingPct: null,
        label: 'cursor Cursor 62%',
      },
      {
        provider: '',
        window: 'Other',
        remainingPct: 40,
        expectedRemainingPct: null,
        label: 'cursor Other 40%',
      },
    ]);
  });

  it('projects DeepSeek monetary balances into tips with no pace/percentage/bar semantics', () => {
    const deepseek: QuotaProviderState = {
      id: 'deepseek',
      label: 'DeepSeek',
      displayLine: 'DeepSeek ¥12.50 · $1.00',
      error: null,
      status: 'ok',
      stale: false,
      balances: [
        { currency: 'CNY', amount: '12.50', display: '¥12.50' },
        { currency: 'USD', amount: '1.00', display: '$1.00' },
      ],
    };

    const tips = buildQuotaTips([deepseek], ['deepseek']);
    expect(tips).toHaveLength(1);
    expect(tips[0].balances).toBeDefined();
    expect(tips[0].balances!).toHaveLength(2);
    // One row per balance currency, in order.
    expect(tips[0].balances!.map((b) => b.currency)).toEqual(['CNY', 'USD']);
    // Structured group identity carries the provider id.
    expect(tips[0].balanceLabel).toBe('deepseek');
    // No bars produced for balance-only providers.
    expect(tips[0].bars).toBeUndefined();
    expect(tips[0].errorRow).toBeUndefined();
    // Text is the normalized display line (no % or bar semantics).
    expect(tips[0].text).toBe('deepseek ¥12.50 · $1.00');
  });

  it('removes remain only as a percentage suffix in normalized fallback text', () => {
    const tips = buildQuotaTips([{
      id: 'custom',
      label: 'Custom',
      displayLine: 'Custom 50% remain · 3 requests remain',
      error: null,
      status: 'ok',
      stale: false,
    }], ['custom']);

    expect(tips[0].text).toBe('custom 50% · 3 requests remain');
  });

  it('mixes percentage and balance providers in settings order', () => {
    const providers: QuotaProviderState[] = [
      {
        id: 'codex',
        label: 'Codex',
        displayLine: 'Codex 7d 40%',
        error: null,
        status: 'ok',
        stale: false,
        bars: {
          remainingPct: 40,
          expectedRemainingPct: null,
          windows: [{ name: '7d', usedPct: 60, remainingPct: 40, expectedRemainingPct: null }],
        },
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        displayLine: 'DeepSeek ¥12.50',
        error: null,
        status: 'ok',
        stale: false,
        balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
      },
    ];

    const tips = buildQuotaTips(providers, ['codex', 'deepseek']);
    expect(tips).toHaveLength(2);
    expect(tips[0].bars).toBeDefined();
    expect(tips[0].balances).toBeUndefined();
    expect(tips[1].bars).toBeUndefined();
    expect(tips[1].balances).toBeDefined();
    expect(tips[1].balances!).toHaveLength(1);
    expect(tips[1].balances![0].currency).toBe('CNY');
    expect(tips[1].balanceLabel).toBe('deepseek');
  });

  it('uses the same user-defined provider order for Tips and the status-bar quota submenu', () => {
    const providers: QuotaProviderState[] = [
      {
        id: 'codex',
        label: 'Codex',
        displayLine: 'Codex 7d 40%',
        error: null,
        status: 'ok',
        stale: false,
        bars: {
          remainingPct: 40,
          expectedRemainingPct: null,
          windows: [{ name: '7d', usedPct: 60, remainingPct: 40, expectedRemainingPct: null }],
        },
      },
      {
        id: 'cursor',
        label: 'Cursor',
        displayLine: 'Cursor 7d 80%',
        error: null,
        status: 'ok',
        stale: false,
        bars: {
          remainingPct: 80,
          expectedRemainingPct: null,
          windows: [{ name: '7d', usedPct: 20, remainingPct: 80, expectedRemainingPct: null }],
        },
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        displayLine: 'DeepSeek ¥12.50',
        error: null,
        status: 'ok',
        stale: false,
        balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
      },
    ];
    const settingsOrder = ['deepseek', 'cursor', 'codex'];

    const tips = buildQuotaTips(providers, settingsOrder);
    expect(tips.map((tip) => tip.balanceLabel ?? tip.bars?.[0]?.label)).toEqual(settingsOrder);

    const menuRows = formatQuotaBarMenuRows(tips);
    expect(menuRows.map((row) => row.provider)).toEqual(settingsOrder);
  });

  it('formats balance tray submenu rows as provider,currency,amount only via the production projection', () => {
    const tips = buildQuotaTips([
      {
        id: 'deepseek',
        label: 'DeepSeek',
        displayLine: 'DeepSeek ¥12.50 · $1.00',
        error: null,
        status: 'ok',
        stale: false,
        balances: [
          { currency: 'CNY', amount: '12.50', display: '¥12.50' },
          { currency: 'USD', amount: '1.00', display: '$1.00' },
        ],
      },
    ], ['deepseek']);

    const rows = formatQuotaBarMenuRows(tips);
    expect(rows).toHaveLength(2);
    // Provider only on the first row; each row carries a single-row balances payload.
    expect(rows[0]).toEqual({
      provider: 'deepseek',
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      label: 'deepseek bal ¥12.50',
      balances: [{ provider: 'deepseek', currency: 'CNY', amount: '12.50', display: '¥12.50', label: 'deepseek bal ¥12.50' }],
    });
    expect(rows[1]).toEqual({
      provider: '',
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      label: 'deepseek bal $1.00',
      balances: [{ provider: 'deepseek', currency: 'USD', amount: '1.00', display: '$1.00', label: 'deepseek bal $1.00' }],
    });
  });

  it('renders two balance tray rows for the production status-menu projection', () => {
    const tips = buildQuotaTips([
      {
        id: 'deepseek',
        label: 'DeepSeek',
        displayLine: 'DeepSeek ¥12.50',
        error: null,
        status: 'ok',
        stale: false,
        balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
      },
    ], ['deepseek']);

    const rows = formatQuotaBarMenuRows(tips);
    // Balance rows are no longer skipped: one row per balance currency, deepseek on the first.
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('deepseek');
    expect(rows[0].balances).toEqual([
      { provider: 'deepseek', currency: 'CNY', amount: '12.50', display: '¥12.50', label: 'deepseek bal ¥12.50' },
    ]);
  });
});
