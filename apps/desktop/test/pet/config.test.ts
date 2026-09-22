import { describe, it, expect } from 'vitest';
import * as config from '../../src/pet/main/config';
import {
  applyPetSettingsPatch,
  normalizeConfig,
  serializePetSettings,
  validateOptionalFiniteNumber,
  validateOptionalInteger,
  validateRangeNumber,
} from '../../src/pet/main/config';

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

describe('Config — current-format normalization', () => {
  it('keeps the persisted house geometry independently from the runtime carrier', () => {
    const c = normalizeConfig({
      house: { displayId: 2, x: -20, y: 30, entityX: 0, entityY: 900 },
    });

    expect(c.house).toEqual({ displayId: 2, x: -20, y: 30, entityX: 0, entityY: 900 });
  });

  it('drops malformed house fields instead of inferring a legacy top-level displayId', () => {
    const c = normalizeConfig({ displayId: 42, house: { displayId: 'nope' } });

    expect(c.house).toEqual({
      displayId: undefined,
      x: undefined,
      y: undefined,
      entityX: undefined,
      entityY: undefined,
    });
  });

  it('preserves an explicit taskgraph entity visibility choice', () => {
    const c = normalizeConfig({
      entities: { house: true, workers: true, taskgraphs: false },
    });

    expect(c.entities).toEqual({ house: true, workers: true, taskgraphs: false });
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
});

describe('Config — provider preferences are never reinterpreted at runtime', () => {
  it('defaults contain the official popular order', () => {
    const c = normalizeConfig({});
    expect(c.quota.providers.map((p) => p.id)).toEqual([
      'chatgpt',
      'cursor',
      'deepseek',
      'zhipu-coding',
      'kimi-coding',
      'super-grok',
    ]);
  });

  it('keeps provider ids, order and enabled flags exactly as persisted', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: 'kimi-coding', enabled: false },
          { id: 'anthropic', enabled: true },
          { id: 'codex', enabled: false },
          { id: 'legacy-unknown', enabled: true },
        ],
      },
    });

    expect(c.quota.providers).toEqual([
      { id: 'kimi-coding', enabled: false },
      { id: 'anthropic', enabled: true },
      { id: 'codex', enabled: false },
      { id: 'legacy-unknown', enabled: true },
    ]);
  });

  it('trims and deduplicates provider rows without inventing new providers', () => {
    const c = normalizeConfig({
      quota: {
        providers: [
          { id: ' chatgpt ', enabled: true },
          { id: 'chatgpt', enabled: false },
          { id: '' },
          { id: 'cursor' },
        ],
      },
    });

    expect(c.quota.providers).toEqual([
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
    ]);
  });

  it('preserves an explicitly empty provider preference', () => {
    const c = normalizeConfig({ quota: { providers: [] } });
    expect(c.quota.providers).toEqual([]);
  });

  it('performs no file IO or legacy import at runtime', () => {
    // Migration is offline only: the runtime module exposes no loader, saver or
    // legacy path helper, so no document is read or rewritten while running.
    expect('loadConfig' in config).toBe(false);
    expect('saveConfig' in config).toBe(false);
    expect('legacySettingsConfigPath' in config).toBe(false);
  });
});

describe('Desktop-owned Pet settings contract', () => {
  it('serializes only user-editable companion settings', () => {
    const normalized = normalizeConfig({
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

    expect(normalized.windows).toEqual({ graphSlip: { x: 1, y: 2 } });

    expect(serializePetSettings(normalized)).toEqual({
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

  it('applies bounded settings without touching placement or window geometry', () => {
    const normalized = normalizeConfig({
      house: { displayId: 7, entityX: 100, entityY: 200 },
      windows: { graphSlip: { x: 1, y: 2, width: 440, height: 640 } },
    });
    const result = applyPetSettingsPatch(normalized, {
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
    expect(result.config.house).toEqual(normalized.house);
    expect(result.config.windows).toEqual(normalized.windows);
  });
});
