import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { FORGE_QUOTA_TIMEOUT_MS, parseQuotaJson, QuotaService, sanitizeQuotaChildEnv } from '../src/main/quota-service';

vi.mock('node:child_process', () => {
  const { EventEmitter } = require('node:events');
  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter() as any;
      proc.stderr = new EventEmitter() as any;
      proc.stdout.readable = true;
      proc.stderr.readable = true;
      proc.pid = 42;
      proc.connected = true;
      return proc;
    }),
  };
});

describe('parseQuotaJson', () => {
  it('parses provider-level remaining_pct and expected_remaining_pct with no windows', () => {
    const raw = JSON.stringify([
      {
        pool: 'codex',
        label: 'Codex',
        status: 'ok',
        display_line: 'Codex month 55%',
        stale: false,
        remaining_pct: 55,
        expected_remaining_pct: 30,
        windows: [],
      },
    ]);

    const providers = parseQuotaJson(raw);
    expect(providers).toHaveLength(1);

    const codex = providers[0];
    expect(codex.id).toBe('codex');
    expect(codex.bars).toBeDefined();
    expect(codex.bars!.remainingPct).toBe(55);
    expect(codex.bars!.expectedRemainingPct).toBe(30);
    // Zero real windows preserved
    expect(codex.bars!.windows).toHaveLength(0);
  });

  it('retains normal window rows with expected_remaining_pct:null', () => {
    const raw = JSON.stringify([
      {
        pool: 'codex',
        label: 'Codex',
        status: 'ok',
        display_line: 'Codex 7d 25%',
        stale: false,
        remaining_pct: 25,
        expected_remaining_pct: null,
        windows: [
          { name: '7d', pct: 75, remaining_pct: 25, expected_remaining_pct: null },
        ],
      },
    ]);

    const providers = parseQuotaJson(raw);
    expect(providers).toHaveLength(1);

    const codex = providers[0];
    expect(codex.bars).toBeDefined();
    expect(codex.bars!.windows).toHaveLength(1);
    expect(codex.bars!.windows[0].name).toBe('7d');
    expect(codex.bars!.windows[0].remainingPct).toBe(25);
    // Null marker preserved
    expect(codex.bars!.windows[0].expectedRemainingPct).toBeNull();
    // Provider-level null propagated
    expect(codex.bars!.expectedRemainingPct).toBeNull();
  });

  it('retains all three Kimi Coding quota pools in Forge order', () => {
    const raw = JSON.stringify([{
      pool: 'kimi-coding',
      label: 'kimi',
      status: 'ok',
      display_line: 'kimi 5h 20% · 7d 40% · 1mo 73%',
      windows: [
        { name: '5h', pct: 20, remaining_pct: 80 },
        { name: '7d', pct: 40, remaining_pct: 60 },
        { name: '1mo', pct: 72.5, remaining_pct: 27.5 },
      ],
    }]);

    const [kimi] = parseQuotaJson(raw);
    expect(kimi.bars?.windows.map((window) => window.name)).toEqual(['5h', '7d', '1mo']);
    expect(kimi.bars?.windows.map((window) => window.remainingPct)).toEqual([80, 60, 27.5]);
  });

  it('parses a window that has used_pct but no pct or remaining_pct', () => {
    const raw = JSON.stringify([
      {
        pool: 'used-only',
        label: 'Used Only',
        status: 'ok',
        display_line: 'Used Only 30%',
        stale: false,
        remaining_pct: 30,
        expected_remaining_pct: null,
        windows: [
          { name: '7d', used_pct: 70 },
        ],
      },
    ]);

    const providers = parseQuotaJson(raw);
    expect(providers).toHaveLength(1);

    const used = providers[0];
    expect(used.bars).toBeDefined();
    expect(used.bars!.windows).toHaveLength(1);
    expect(used.bars!.windows[0].name).toBe('7d');
    expect(used.bars!.windows[0].usedPct).toBe(70);
    // remaining_pct absent, pct absent => derive from used_pct: 100 - 70 = 30
    expect(used.bars!.windows[0].remainingPct).toBe(30);
    expect(used.bars!.windows[0].expectedRemainingPct).toBeNull();
  });

  it('rejects malformed/non-finite/out-of-range graphical fields', () => {
    const raw = JSON.stringify([
      {
        pool: 'bad-pool',
        label: 'Bad Pool',
        status: 'ok',
        display_line: 'Bad Pool 0%',
        stale: false,
        remaining_pct: 150,
        expected_remaining_pct: -5,
        windows: [
          { name: 'bad-win', pct: NaN, remaining_pct: Infinity, expected_remaining_pct: 200 },
        ],
      },
    ]);

    const providers = parseQuotaJson(raw);
    expect(providers).toHaveLength(1);

    const bad = providers[0];
    // Provider-level invalid values become null
    expect(bad.bars!.remainingPct).toBeNull();
    expect(bad.bars!.expectedRemainingPct).toBeNull();
    // Window with invalid values is still included but with sanitized values
    expect(bad.bars!.windows).toHaveLength(1);
    expect(bad.bars!.windows[0].usedPct).toBe(0);
    expect(bad.bars!.windows[0].remainingPct).toBe(0);
    expect(bad.bars!.windows[0].expectedRemainingPct).toBeNull();
  });

  it('returns empty array well formed with no status data', () => {
    const providers = parseQuotaJson('[]');
    expect(providers).toEqual([]);
  });

  it('preserves provider-agnostic pending status with Forge code/message', () => {
    const message = 'Sign-in is in progress. Approve the request if prompted; Forge will refresh quota automatically.';
    const raw = JSON.stringify([
      {
        pool: 'codex',
        label: 'Codex',
        status: 'pending',
        code: 'authentication_pending',
        message,
        stale: false,
      },
    ]);

    const providers = parseQuotaJson(raw);
    expect(providers).toHaveLength(1);
    // Pending status is preserved provider-agnostically (not tied to any single provider)
    expect(providers[0].status).toBe('pending');
    expect(providers[0].displayLine).toBeNull();
    // The Forge contract code is preserved as passive metadata
    expect(providers[0].code).toBe('authentication_pending');
    // The Forge message is preserved for status-row rendering
    expect(providers[0].error).toBe(message);
    expect(providers[0].stale).toBe(false);
  });

  it('keeps Forge code separate from message/error for error status', () => {
    const raw = JSON.stringify([
      {
        pool: 'codex',
        label: 'Codex',
        status: 'error',
        code: 'authentication_expired',
        error: 'legacy raw error',
        message: 'Forge-provided message',
        stale: true,
      },
    ]);

    const providers = parseQuotaJson(raw);
    expect(providers).toHaveLength(1);
    const codex = providers[0];
    // Code is passive metadata preserved independently of message/error
    expect(codex.status).toBe('error');
    expect(codex.code).toBe('authentication_expired');
    // Forge message takes precedence over the raw error field for display
    expect(codex.error).toBe('Forge-provided message');
    expect(codex.displayLine).toBeNull();
    expect(codex.stale).toBe(true);
  });

  it('throws on non-array input', () => {
    expect(() => parseQuotaJson('{"not":"an array"}')).toThrow(TypeError);
  });
});

describe('QuotaService runForgeQuotaJson timeout', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockImplementation(() => {
      const { EventEmitter } = require('node:events');
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter() as any;
      proc.stderr = new EventEmitter() as any;
      proc.stdout.readable = true;
      proc.stderr.readable = true;
      proc.pid = 42;
      proc.connected = true;
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('[]'));
        proc.emit('close', 0);
      });
      return proc;
    });
  });

  it('sets spawn timeout to the configured 30-second budget and runs forge quota --json only', async () => {
    const service = new QuotaService();
    const promise = service.listProviders(true);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe('forge');
    expect(args).toEqual(['quota', '--json']);
    expect(opts.timeout).toBe(FORGE_QUOTA_TIMEOUT_MS);
    expect(opts.windowsHide).toBe(true);
    expect(opts.shell).toBe(false);
    expect(opts.env?.PATH).toEqual(expect.any(String));
    expect(
      String(opts.env.PATH)
        .split(path.delimiter)
        .every((entry: string) => !entry.replaceAll('\\', '/').endsWith('/node_modules/.bin')),
    ).toBe(true);

    // Cleanup: let the mock promise resolve
    await promise;
  });

  it('spawns the managed WRENYARD_RUNTIME_BIN absolute path instead of the PATH forge', async () => {
    const runtimeBin = '/opt/wrenyard/wrenyard-sea';
    const prev = process.env.WRENYARD_RUNTIME_BIN;
    process.env.WRENYARD_RUNTIME_BIN = runtimeBin;
    try {
      const service = new QuotaService();
      const promise = service.listProviders(true);

      expect(spawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(cmd).toBe(runtimeBin);
      expect(args).toEqual(['quota', '--json']);
      expect(opts.timeout).toBe(FORGE_QUOTA_TIMEOUT_MS);
      expect(opts.windowsHide).toBe(true);
      expect(opts.shell).toBe(false);

      await promise;
    } finally {
      if (prev === undefined) delete process.env.WRENYARD_RUNTIME_BIN;
      else process.env.WRENYARD_RUNTIME_BIN = prev;
    }
  });
});

describe('sanitizeQuotaChildEnv', () => {
  it('drops npm node_modules/.bin entries and prefers user/homebrew bins', () => {
    const home = '/Users/tester';
    const env = sanitizeQuotaChildEnv({
      HOME: home,
      PATH: [
        `${home}/Documents/Github/wrenyard/apps/pet/node_modules/.bin`,
        `${home}/node_modules/.bin`,
        '/node_modules/.bin',
        '/opt/homebrew/bin',
        '/usr/bin',
      ].join(path.delimiter),
    });
    expect(env.PATH?.split(path.delimiter)).toEqual([
      path.join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
    ]);
  });
});
