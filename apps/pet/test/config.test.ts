import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeConfig,
  validateOptionalFiniteNumber,
  validateOptionalInteger,
  validateRangeNumber,
} from '../src/main/config';
import type { loadConfig as LoadConfigFn, saveConfig as SaveConfigFn } from '../src/main/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Config — validateRangeNumber (Minor 16)', () => {
  it('returns fallback when value is below min', () => {
    expect(validateRangeNumber(0, 3, 1, 6)).toBe(3);
  });

  it('returns fallback when value is above max', () => {
    expect(validateRangeNumber(10, 3, 1, 6)).toBe(3);
  });

  it('returns value when in valid range', () => {
    expect(validateRangeNumber(4, 3, 1, 6)).toBe(4);
  });

  it('returns fallback for NaN', () => {
    expect(validateRangeNumber(NaN, 3, 1, 6)).toBe(3);
  });

  it('returns fallback for Infinity', () => {
    expect(validateRangeNumber(Infinity, 3, 1, 6)).toBe(3);
  });

  it('returns fallback for non-number', () => {
    expect(validateRangeNumber('4', 3, 1, 6)).toBe(3);
    expect(validateRangeNumber(null, 3, 1, 6)).toBe(3);
    expect(validateRangeNumber(undefined, 3, 1, 6)).toBe(3);
  });

  it('scale range 1-6', () => {
    expect(validateRangeNumber(0, 3, 1, 6)).toBe(3);
    expect(validateRangeNumber(10, 3, 1, 6)).toBe(3);
    expect(validateRangeNumber(1, 3, 1, 6)).toBe(1);
    expect(validateRangeNumber(6, 3, 1, 6)).toBe(6);
    expect(validateRangeNumber(4, 3, 1, 6)).toBe(4);
  });

  it('bubbleSeconds range 1-60', () => {
    expect(validateRangeNumber(0, 6, 1, 60)).toBe(6);
    expect(validateRangeNumber(120, 6, 1, 60)).toBe(6);
    expect(validateRangeNumber(1, 6, 1, 60)).toBe(1);
    expect(validateRangeNumber(60, 6, 1, 60)).toBe(60);
    expect(validateRangeNumber(15, 6, 1, 60)).toBe(15);
  });

  it('bottomOffset range 0-512', () => {
    expect(validateRangeNumber(-1, 0, 0, 512)).toBe(0);
    expect(validateRangeNumber(1024, 0, 0, 512)).toBe(0);
    expect(validateRangeNumber(0, 10, 0, 512)).toBe(0);
    expect(validateRangeNumber(48, 0, 0, 512)).toBe(48);
    expect(validateRangeNumber(512, 0, 0, 512)).toBe(512);
  });

  it('displayId is optional but must be an integer', () => {
    expect(validateOptionalInteger(undefined)).toBeUndefined();
    expect(validateOptionalInteger(null)).toBeUndefined();
    expect(validateOptionalInteger('1')).toBeUndefined();
    expect(validateOptionalInteger(1.5)).toBeUndefined();
    expect(validateOptionalInteger(2)).toBe(2);
  });

  it('house coordinates are optional but must be finite numbers', () => {
    expect(validateOptionalFiniteNumber(undefined)).toBeUndefined();
    expect(validateOptionalFiniteNumber(null)).toBeUndefined();
    expect(validateOptionalFiniteNumber('1')).toBeUndefined();
    expect(validateOptionalFiniteNumber(NaN)).toBeUndefined();
    expect(validateOptionalFiniteNumber(Infinity)).toBeUndefined();
    expect(validateOptionalFiniteNumber(-120.5)).toBe(-120.5);
  });
});

describe('Config — V1 to V2 migration', () => {
  it('migrates top-level V1 displayId into house.displayId', () => {
    const c = normalizeConfig({
      scale: 4,
      bubbleSeconds: 8,
      bottomOffset: 20,
      displayId: 42,
    });

    expect(c.house).toEqual({
      displayId: 42,
      x: undefined,
      y: undefined,
      entityX: undefined,
      entityY: undefined,
    });
    expect(c.entities).toEqual({ house: true, workers: true, taskgraphs: true });
  });

  it('prefers V2 house position over legacy displayId', () => {
    const c = normalizeConfig({
      displayId: 1,
      house: { displayId: 2, x: -500, y: 120.5 },
      entities: { house: false, workers: true },
    });

    expect(c.house).toEqual({
      displayId: 2,
      x: -500,
      y: 120.5,
      entityX: undefined,
      entityY: undefined,
    });
    expect(c.entities).toEqual({ house: false, workers: true, taskgraphs: true });
  });

  it('preserves an explicit taskgraph entity visibility choice', () => {
    const c = normalizeConfig({
      entities: { house: true, workers: true, taskgraphs: false },
    });

    expect(c.entities).toEqual({ house: true, workers: true, taskgraphs: false });
  });

  it('roundtrips the V3 visible-house anchor independently from legacy carrier coordinates', () => {
    const c = normalizeConfig({
      house: { displayId: 2, x: -20, y: 30, entityX: 0, entityY: 900 },
    });

    expect(c.house).toEqual({ displayId: 2, x: -20, y: 30, entityX: 0, entityY: 900 });
  });

  it('roundtrips remembered Graph Slip geometry and drops malformed fields', () => {
    const c = normalizeConfig({
      windows: {
        graphSlip: { width: 640, height: 720, x: -320, y: 96, ignored: true },
      },
    });
    expect(c.windows.graphSlip).toEqual({ x: -320, y: 96, width: 640, height: 720 });
  });

  it('defaults appearance.houseSkin to classic when missing', () => {
    const c = normalizeConfig({
      scale: 3,
      entities: { house: true, workers: true, taskgraphs: true },
    });
    expect(c.appearance).toEqual({ houseSkin: 'classic' });
  });

  it('normalizes classic skin roundtrip', () => {
    const c = normalizeConfig({
      appearance: { houseSkin: 'classic' },
    });
    expect(c.appearance.houseSkin).toBe('classic');
  });

  it('normalizes mushroom skin roundtrip', () => {
    const c = normalizeConfig({
      appearance: { houseSkin: 'mushroom' },
    });
    expect(c.appearance.houseSkin).toBe('mushroom');
  });

  it('falls back to classic for invalid skin values', () => {
    const c = normalizeConfig({
      appearance: { houseSkin: 'invalid-skin' },
    });
    expect(c.appearance.houseSkin).toBe('classic');
  });

  it('falls back to classic for non-string skin value', () => {
    const c = normalizeConfig({
      appearance: { houseSkin: 42 },
    });
    expect(c.appearance.houseSkin).toBe('classic');
  });

  it('persists houseSkin through save and load', async () => {
    const cfgHome = makeTempDir();
    const mod = await importFreshConfig();
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      house: {},
      entities: { house: true, workers: true, taskgraphs: true },
      appearance: { houseSkin: 'mushroom' as const },
      quota: { providers: [] },
      windows: {},
    };
    mod.saveConfig(config, { configHome: cfgHome });

    const loaded = await loadFreshConfig({ configHome: cfgHome, legacyConfigPath: path.join(cfgHome, 'nonexistent-legacy', 'settings.json') });
    expect(loaded.appearance.houseSkin).toBe('mushroom');
  });
});

describe('Config — grok to super-grok quota migration', () => {
  it('defaults contain official popular order: chatgpt, cursor, deepseek, zhipu-coding, kimi-coding, then super-grok', () => {
    const c = normalizeConfig({});
    const ids = c.quota.providers.map((p) => p.id);
    expect(ids).toEqual(['chatgpt', 'cursor', 'deepseek', 'zhipu-coding', 'kimi-coding', 'super-grok']);
    expect(ids).not.toContain('grok');
    expect(ids).not.toContain('codex');
  });

  it('inserts deepseek exactly once at the popularity position for legacy providers, preserving order/enabled', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'chatgpt', enabled: true },
          { id: 'grok', enabled: false },
          { id: 'kimi-coding', enabled: true },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
      { id: 'super-grok', enabled: false },
      { id: 'kimi-coding', enabled: true },
    ]);
  });

  it('inserts deepseek at popularity position for legacy pools without duplicating', () => {
    const c = normalizeConfig({
      quota: {
        pools: ['chatgpt', 'grok', 'kimi-coding'],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
      { id: 'super-grok', enabled: true },
      { id: 'kimi-coding', enabled: true },
    ]);
    expect(c.quota.providers.filter((p) => p.id === 'deepseek')).toHaveLength(1);
  });

  it('defaults contain chatgpt first, cursor second, super-grok, and not grok', () => {
    const c = normalizeConfig({});
    const ids = c.quota.providers.map((p) => p.id);
    expect(ids.slice(0, 2)).toEqual(['chatgpt', 'cursor']);
    expect(ids).toContain('cursor');
    expect(ids).toContain('super-grok');
    expect(ids).not.toContain('grok');
  });

  it('migrates legacy quota.providers grok with order and enabled preserved, appending cursor once', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'chatgpt', enabled: true },
          { id: 'grok', enabled: false },
          { id: 'kimi-coding', enabled: true },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
      { id: 'super-grok', enabled: false },
      { id: 'kimi-coding', enabled: true },
    ]);
  });

  it('migrates legacy quota.pools grok, appending cursor once', () => {
    const c = normalizeConfig({
      quota: {
        pools: ['chatgpt', 'grok', 'kimi-coding'],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
      { id: 'super-grok', enabled: true },
      { id: 'kimi-coding', enabled: true },
    ]);
  });

  it('deduplicates coexistence and lets explicit canonical super-grok enabled win', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'grok', enabled: false },
          { id: 'super-grok', enabled: true },
          { id: 'chatgpt', enabled: true },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'super-grok', enabled: true },
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
    ]);
  });

  it('appends cursor enabled:true exactly once when absent from existing providers', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'chatgpt', enabled: true },
          { id: 'zhipu-coding', enabled: false },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
      { id: 'zhipu-coding', enabled: false },
    ]);
  });

  it('preserves explicit cursor disabled without appending a duplicate', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'chatgpt', enabled: true },
          { id: 'cursor', enabled: false },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: false },
      { id: 'deepseek', enabled: true },
    ]);
    expect(c.quota.providers.filter((p) => p.id === 'cursor')).toHaveLength(1);
  });

  it('preserves explicit deepseek enabled/manual order without duplicating', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'zhipu-coding', enabled: true },
          { id: 'deepseek', enabled: false },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'zhipu-coding', enabled: true },
      { id: 'deepseek', enabled: false },
      { id: 'cursor', enabled: true },
    ]);
    expect(c.quota.providers.filter((p) => p.id === 'deepseek')).toHaveLength(1);
  });

  it('normalizes persisted legacy codex entries into a single chatgpt provider', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'codex', enabled: true },
          { id: 'kimi-coding', enabled: true },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
      { id: 'kimi-coding', enabled: true },
    ]);
    expect(c.quota.providers.filter((p) => p.id === 'chatgpt')).toHaveLength(1);
    expect(c.quota.providers.map((p) => p.id)).not.toContain('codex');
  });

  it('lets an explicit chatgpt entry win over a mapped legacy codex entry while preserving unrelated preferences', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'codex', enabled: false },
          { id: 'chatgpt', enabled: true },
          { id: 'zhipu-coding', enabled: false },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
      { id: 'zhipu-coding', enabled: false },
    ]);
  });

  it('renames legacy anthropic-api and opencode-native providers without collapsing the subscription claude-coding provider', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'anthropic-api', enabled: true },
          { id: 'claude-coding', enabled: false },
          { id: 'opencode-native', enabled: true },
        ],
      },
    });
    expect(c.quota.providers).toEqual([
      { id: 'anthropic', enabled: true },
      { id: 'claude-coding', enabled: false },
      { id: 'opencode-zen', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
    ]);
    expect(c.quota.providers.map((p) => p.id)).not.toContain('anthropic-api');
    expect(c.quota.providers.map((p) => p.id)).not.toContain('opencode-native');
  });

  it('renames the legacy subscription anthropic id to claude-coding without chaining the API id', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'anthropic', enabled: false },
          { id: 'anthropic-api', enabled: true },
        ],
      },
    });
    // The legacy subscription id becomes claude-coding; the legacy API id
    // becomes the modern anthropic in the same simultaneous pass.
    expect(c.quota.providers).toEqual([
      { id: 'claude-coding', enabled: false },
      { id: 'anthropic', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
    ]);
    expect(c.quota.providers.filter((p) => p.id === 'anthropic')).toHaveLength(1);
    expect(c.quota.providers.filter((p) => p.id === 'claude-coding')).toHaveLength(1);
  });

  it('leaves a marked document untouched so a modern anthropic API preference stays anthropic', () => {
    const c = normalizeConfig({
      providerMigration: 'provider-identity-v1',
      quota: { providers: [{ id: 'anthropic', enabled: true }] },
    });
    expect(c.quota.providers[0]).toEqual({ id: 'anthropic', enabled: true });
    expect(c.quota.providers.map((p) => p.id)).not.toContain('claude-coding');
  });

  it('merges a renamed provider id into an existing canonical entry exactly once', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'anthropic-api', enabled: false },
          { id: 'anthropic', enabled: true },
          { id: 'opencode-zen', enabled: false },
          { id: 'opencode-native', enabled: true },
        ],
      },
    });
    // Position-preserving renames: `anthropic-api` (first) becomes the modern
    // `anthropic` carrying its own enabled value, and the legacy subscription
    // `anthropic` (second) is re-anchored to `claude-coding` at its own slot.
    expect(c.quota.providers).toEqual([
      { id: 'anthropic', enabled: false },
      { id: 'claude-coding', enabled: true },
      { id: 'opencode-zen', enabled: false },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
    ]);
    expect(c.quota.providers.filter((p) => p.id === 'anthropic')).toHaveLength(1);
    expect(c.quota.providers.filter((p) => p.id === 'opencode-zen')).toHaveLength(1);
  });

  it('renames legacy pools anthropic-api and opencode-native ids', () => {
    const c = normalizeConfig({ quota: { pools: ['anthropic-api', 'opencode-native', 'kimi-coding'] } });
    expect(c.quota.providers).toEqual([
      { id: 'anthropic', enabled: true },
      { id: 'opencode-zen', enabled: true },
      { id: 'kimi-coding', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
    ]);
  });
});

// ── Temp-dir helpers for hermetic file I/O tests ──

const tempDirs: string[] = [];

function makeTempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fpet-cfg-'));
  tempDirs.push(d);
  return d;
}

function teardownTempDirs() {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

function writeFile(filePath: string, content: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ── Dynamic import helper ──

async function importFreshConfig() {
  vi.resetModules();
  return await import('../src/main/config');
}

async function loadFreshConfig(opts?: { configHome?: string; legacyConfigPath?: string }) {
  const mod = await importFreshConfig();
  return mod.loadConfig(opts);
}

// ── Config path helpers ──

function settingsConfigPath(configHome: string) {
  return path.join(configHome, 'wrenyard', 'pet', 'settings.json');
}

// ── Settings file path tests ──

describe('Config — settings.json path (hermetic)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    teardownTempDirs();
  });

  it('reads config from settings.json when present', async () => {
    const cfgHome = makeTempDir();
    const cfgPath = settingsConfigPath(cfgHome);
    writeFile(cfgPath, JSON.stringify({
      house: { displayId: 99 },
    }));

    const cfg = await loadFreshConfig({ configHome: cfgHome, legacyConfigPath: path.join(cfgHome, 'nonexistent-legacy', 'settings.json') });
    expect(cfg.house.displayId).toBe(99);
  });

  it('returns defaults when no config exists', async () => {
    const cfgHome = makeTempDir();
    const cfg = await loadFreshConfig({ configHome: cfgHome, legacyConfigPath: path.join(cfgHome, 'nonexistent-legacy', 'settings.json') });
    expect(cfg.scale).toBe(3);
    expect(cfg.house).toEqual({});
    expect(cfg.entities.house).toBe(true);

    // Should have created default config at the settings path
    const cfgPath = settingsConfigPath(cfgHome);
    expect(fs.existsSync(cfgPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(saved.scale).toBe(3);
  });

  it('repairs invalid JSON with defaults written to settings path', async () => {
    const cfgHome = makeTempDir();
    const cfgPath = settingsConfigPath(cfgHome);
    writeFile(cfgPath, 'not json');

    const cfg = await loadFreshConfig({ configHome: cfgHome, legacyConfigPath: path.join(cfgHome, 'nonexistent-legacy', 'settings.json') });
    expect(cfg.scale).toBe(3);

    const repaired = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(repaired.scale).toBe(3);
    expect(repaired.entities?.house).toBe(true);
  });

  it('saveConfig writes and roundtrips', async () => {
    const cfgHome = makeTempDir();
    const cfgPath = settingsConfigPath(cfgHome);

    const mod = await importFreshConfig();
    const config = {
      scale: 5,
      bubbleSeconds: 6,
      bottomOffset: 0,
      house: { displayId: 42, x: 100, y: -200 },
      entities: { house: true, workers: true, taskgraphs: true },
    };
    mod.saveConfig(config, { configHome: cfgHome });

    expect(fs.existsSync(cfgPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(saved.house.displayId).toBe(42);
    expect(saved.house.x).toBe(100);
    expect(saved.house.y).toBe(-200);

    const loaded = await loadFreshConfig({ configHome: cfgHome });
    expect(loaded.scale).toBe(5);
    expect(loaded.house).toEqual({ displayId: 42, x: 100, y: -200 });
  });
});

describe('Config — legacy migration (hermetic)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    teardownTempDirs();
  });

  it('migrates from legacy ~/.foreman-pet/config.json when settings.json is absent', async () => {
    const tempLegacyDir = makeTempDir();
    const cfgHome = makeTempDir();
    const legacyPath = path.join(tempLegacyDir, '.foreman-pet', 'config.json');
    const cfgPath = settingsConfigPath(cfgHome);

    writeFile(legacyPath, JSON.stringify({
      scale: 2,
      house: { displayId: 7, x: 50, y: -30 },
      entities: { house: true, workers: true, taskgraphs: true },
    }));

    const mod = await importFreshConfig();
    const cfg = mod.loadConfig({ configHome: cfgHome, legacyConfigPath: legacyPath });

    expect(cfg.scale).toBe(2);
    expect(cfg.house).toEqual({ displayId: 7, x: 50, y: -30 });

    // Loading persists the provider migration marker exactly once.
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).providerMigration).toBe('provider-identity-v1');

    mod.saveConfig(cfg, { configHome: cfgHome });
    expect(fs.existsSync(cfgPath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(saved.scale).toBe(2);
    expect(saved.house.displayId).toBe(7);

    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('prefers settings.json over legacy when both exist', async () => {
    const tempLegacyDir = makeTempDir();
    const cfgHome = makeTempDir();
    const legacyPath = path.join(tempLegacyDir, '.foreman-pet', 'config.json');
    const cfgPath = settingsConfigPath(cfgHome);

    writeFile(legacyPath, JSON.stringify({ house: { displayId: 1 } }));
    writeFile(cfgPath, JSON.stringify({ house: { displayId: 2 } }));

    const mod = await importFreshConfig();
    const cfg = mod.loadConfig({ configHome: cfgHome, legacyConfigPath: legacyPath });

    expect(cfg.house.displayId).toBe(2);
  });

  it('handles corrupt legacy JSON gracefully (falls back to defaults)', async () => {
    const tempLegacyDir = makeTempDir();
    const cfgHome = makeTempDir();
    const legacyPath = path.join(tempLegacyDir, '.foreman-pet', 'config.json');

    writeFile(legacyPath, 'not valid json {{{');

    const mod = await importFreshConfig();
    const cfg = mod.loadConfig({ configHome: cfgHome, legacyConfigPath: legacyPath });

    expect(cfg.scale).toBe(3);

    mod.saveConfig(cfg, { configHome: cfgHome });
    const cfgPath = settingsConfigPath(cfgHome);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(saved.scale).toBe(3);
  });

  it('migrates from the old foreman-pet settings path when the wrenyard/pet path is absent', async () => {
    const cfgHome = makeTempDir();
    const oldSettingsPath = path.join(cfgHome, 'foreman-pet', 'settings.json');
    const newSettingsPath = settingsConfigPath(cfgHome);

    writeFile(oldSettingsPath, JSON.stringify({ scale: 4, house: { displayId: 7 } }));

    const mod = await importFreshConfig();
    const cfg = mod.loadConfig({ configHome: cfgHome, legacyConfigPath: path.join(cfgHome, 'nonexistent-legacy', 'settings.json') });

    expect(cfg.scale).toBe(4);
    expect(cfg.house).toEqual({ displayId: 7, x: undefined, y: undefined, entityX: undefined, entityY: undefined });

    // The migrated document is marked before later reads can reinterpret IDs.
    expect(JSON.parse(fs.readFileSync(newSettingsPath, 'utf-8')).providerMigration).toBe('provider-identity-v1');
    mod.saveConfig(cfg, { configHome: cfgHome });
    expect(fs.existsSync(newSettingsPath)).toBe(true);
  });
});

describe('Pet provider identity migration (hermetic)', () => {
  it('migrates the legacy subscription anthropic preference once and preserves it across reads', async () => {
    const cfgHome = makeTempDir();
    const cfgPath = settingsConfigPath(cfgHome);

    // An unmarked legacy document: the subscription `anthropic` preference
    // must become claude-coding rather than being silently reinterpreted as the
    // modern API anthropic provider.
    writeFile(cfgPath, JSON.stringify({
      quota: { providers: [{ id: 'anthropic', enabled: true }] },
    }));

    const mod = await importFreshConfig();
    const cfg = mod.loadConfig({ configHome: cfgHome });
    expect(cfg.quota.providers[0]).toEqual({ id: 'claude-coding', enabled: true });

    // The migrated document is persisted with the marker exactly once.
    const persisted = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(persisted);
    expect(parsed.providerMigration).toBe('provider-identity-v1');
    expect(parsed.quota.providers[0]).toEqual({ id: 'claude-coding', enabled: true });

    // A second read neither rewrites the file nor re-aliases the id.
    const again = mod.loadConfig({ configHome: cfgHome });
    expect(again.quota.providers[0]).toEqual({ id: 'claude-coding', enabled: true });
    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(persisted);
  });

  it('leaves a modern marked document untouched so an anthropic API preference stays anthropic', async () => {
    const cfgHome = makeTempDir();
    const cfgPath = settingsConfigPath(cfgHome);

    writeFile(cfgPath, JSON.stringify({
      providerMigration: 'provider-identity-v1',
      quota: { providers: [{ id: 'anthropic', enabled: true }, { id: 'claude-coding', enabled: false }] },
    }));
    const before = fs.readFileSync(cfgPath, 'utf-8');

    const mod = await importFreshConfig();
    const cfg = mod.loadConfig({ configHome: cfgHome });
    expect(cfg.quota.providers[0]).toEqual({ id: 'anthropic', enabled: true });
    expect(cfg.quota.providers[1]).toEqual({ id: 'claude-coding', enabled: false });
    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(before);
  });

  it('marks a freshly created default config so it never triggers a legacy rewrite', async () => {
    const cfgHome = makeTempDir();
    const cfgPath = settingsConfigPath(cfgHome);

    const mod = await importFreshConfig();
    mod.loadConfig({ configHome: cfgHome });

    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(parsed.providerMigration).toBe('provider-identity-v1');
    expect(parsed.quota.providers.map((p: { id: string }) => p.id)).not.toContain('claude-coding');
  });
});

describe('Desktop-owned Pet settings contract', () => {
  it('serializes only user-editable companion settings', async () => {
    const mod = await importFreshConfig();
    const config = mod.normalizeConfig({
      scale: 4,
      bubbleSeconds: 9,
      bottomOffset: 12,
      house: { displayId: 7, entityX: 100, entityY: 200 },
      entities: { house: true, workers: false, taskgraphs: true },
      appearance: { houseSkin: 'mushroom' },
      quota: {
        providers: [
          { id: 'chatgpt', enabled: true },
          { id: 'cursor', enabled: true },
          { id: 'deepseek', enabled: true },
        ],
      },
      windows: { stats: { x: 9, y: 9 }, graphSlip: { x: 1, y: 2 } },
    });

    expect(config.windows).toEqual({ graphSlip: { x: 1, y: 2 } });

    expect(mod.serializePetSettings(config)).toEqual({
      enabled: true,
      displayId: 7,
      scale: 4,
      bubbleSeconds: 9,
      bottomOffset: 12,
      entities: { house: true, workers: false, taskgraphs: true },
      appearance: { houseSkin: 'mushroom' },
      quota: {
        providers: [
          { id: 'chatgpt', enabled: true },
          { id: 'cursor', enabled: true },
          { id: 'deepseek', enabled: true },
        ],
      },
    });
  });

  it('applies bounded settings without touching placement or window geometry', async () => {
    const mod = await importFreshConfig();
    const config = mod.normalizeConfig({
      house: { displayId: 7, entityX: 100, entityY: 200 },
      windows: { graphSlip: { x: 1, y: 2, width: 440, height: 640 } },
    });
    const result = mod.applyPetSettingsPatch(config, {
      scale: 99,
      bubbleSeconds: 0,
      bottomOffset: 999,
      entities: { workers: false },
      appearance: { houseSkin: 'mushroom' },
      quota: {
        providers: [
          { id: 'kimi-coding', enabled: false },
          { id: 'kimi-coding', enabled: true },
          { id: 'codex', enabled: true },
        ],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.config.scale).toBe(6);
    expect(result.config.bubbleSeconds).toBe(1);
    expect(result.config.bottomOffset).toBe(512);
    expect(result.config.entities.workers).toBe(false);
    expect(result.config.appearance.houseSkin).toBe('mushroom');
    expect(result.config.quota.providers).toEqual([
      { id: 'kimi-coding', enabled: false },
      { id: 'codex', enabled: true },
    ]);
    expect(result.config.house).toEqual(config.house);
    expect(result.config.windows).toEqual(config.windows);
  });
});
