import { describe, it, expect } from 'vitest';
import {
  getAppearance,
  roleCandidates,
  OFFICIAL_SKIN_IDS,
  CLASSIC_SKIN_IDS,
  ORIGINAL_SKIN_IDS,
} from '../src/features/worker/appearance';
import type { WorkerClient } from '../src/shared/snapshot';

const ALL_CLIENTS: WorkerClient[] = ['codebuddy', 'codex', 'claude', 'unknown'];

describe('roleCandidates — client_family authority', () => {
  it('selects classic-codebuddy as the sole official role for the codebuddy client', () => {
    const c = roleCandidates('codebuddy', 'irrelevant-profile');
    expect(c).toContain('classic-codebuddy');
    expect(c).not.toContain('classic-codex');
    expect(c).not.toContain('classic-claude');
  });

  it('selects classic-codex as the sole official role for the codex client', () => {
    const c = roleCandidates('codex', 'irrelevant-profile');
    expect(c).toContain('classic-codex');
    expect(c).not.toContain('classic-codebuddy');
    expect(c).not.toContain('classic-claude');
  });

  it('selects classic-claude as the sole official role for the claude client', () => {
    const c = roleCandidates('claude', 'irrelevant-profile');
    expect(c).toContain('classic-claude');
    expect(c).not.toContain('classic-codebuddy');
    expect(c).not.toContain('classic-codex');
  });
});

describe('roleCandidates — legacy profile fallback (client_family unknown)', () => {
  it('falls back to profile regex for codex profiles', () => {
    expect(roleCandidates('unknown', 'codex-spark')).toContain('classic-codex');
    expect(roleCandidates('unknown', 'codex-mini')).toContain('classic-codex');
    expect(roleCandidates('unknown', 'codex')).toContain('classic-codex');
  });

  it('falls back to profile regex for claude/anthropic profiles', () => {
    expect(roleCandidates('unknown', 'claude-sonnet')).toContain('classic-claude');
    expect(roleCandidates('unknown', 'anthropic-opus')).toContain('classic-claude');
  });

  it('falls back to profile regex for codebuddy profiles', () => {
    expect(roleCandidates('unknown', 'cb-ds')).toContain('classic-codebuddy');
    expect(roleCandidates('unknown', 'ccb-dsf')).toContain('classic-codebuddy');
    expect(roleCandidates('unknown', 'codebuddy')).toContain('classic-codebuddy');
  });

  it('omits every official role when both client_family and profile are unknown', () => {
    const c = roleCandidates('unknown', 'mystery-profile');
    for (const id of OFFICIAL_SKIN_IDS) {
      expect(c).not.toContain(id);
    }
  });

  it('client_family wins over profile regex (codex client + codebuddy profile)', () => {
    // codex client family is authoritative even when the profile looks like codebuddy
    const c = roleCandidates('codex', 'cb-ds');
    expect(c).toContain('classic-codex');
    expect(c).not.toContain('classic-codebuddy');
  });
});

describe('roleCandidates — membership exactly once', () => {
  it.each(ALL_CLIENTS)('contains all classic and original roles exactly once (client=%s)', (client) => {
    const c = roleCandidates(client, 'some-profile');
    for (const id of CLASSIC_SKIN_IDS) {
      expect(c.filter((x) => x === id)).toHaveLength(1);
    }
    for (const id of ORIGINAL_SKIN_IDS) {
      expect(c.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it('never duplicates any role id across all clients', () => {
    for (const client of ALL_CLIENTS) {
      const c = roleCandidates(client, 'p');
      expect(new Set(c).size).toBe(c.length);
    }
  });

  it('has 1 official + 1 classic + 9 original = 11 candidates when family is known', () => {
    expect(roleCandidates('codebuddy', 'p')).toHaveLength(11);
    expect(roleCandidates('codex', 'p')).toHaveLength(11);
    expect(roleCandidates('claude', 'p')).toHaveLength(11);
  });

  it('has 0 official + 1 classic + 9 original = 10 candidates when family and profile are unknown', () => {
    expect(roleCandidates('unknown', 'mystery')).toHaveLength(10);
  });
});

describe('getAppearance — stable equal-index selection', () => {
  it('is deterministic for the same inputs', () => {
    const a = getAppearance('p', 'key-1', 'unknown');
    const b = getAppearance('p', 'key-1', 'unknown');
    expect(a.skin).toEqual(b.skin);
  });

  it('selects only from the candidate list', () => {
    const candidates = roleCandidates('codex', 'p');
    for (let i = 0; i < 200; i++) {
      const a = getAppearance('p', `seed-${i}`, 'codex');
      expect(candidates).toContain(a.skin.id);
    }
  });

  it('distributes across multiple candidates over many seeds', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(getAppearance('p', `seed-${i}`, 'claude').skin.id);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('getAppearance — per-run original themes', () => {
  it('original skins carry kind "original" with primary/accent/tool color slots', () => {
    let foundOriginal = false;
    for (let i = 0; i < 200; i++) {
      const a = getAppearance('mystery', `seed-${i}`, 'unknown');
      if (a.skin.kind === 'original') {
        foundOriginal = true;
        expect(a.skin.colors.primary).toMatch(/^#[0-9A-F]{6}$/);
        expect(a.skin.colors.accent).toMatch(/^#[0-9A-F]{6}$/);
        expect(a.skin.colors.tool).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
    expect(foundOriginal).toBe(true);
  });

  it('original colors are fixed per id regardless of seed', () => {
    // Same id, different seeds → same colors
    for (let i = 0; i < 50; i++) {
      const a = getAppearance('p', `seed-${i}`, 'unknown', `run-${i}`);
      if (a.skin.id === 'blue-dash') {
        expect(a.skin.colors).toEqual({ primary: '#7BA05B', accent: '#FFC94D', tool: '#2E2018' });
      }
    }
  });

  it('different original ids have different primary colors', () => {
    const primaries = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const a = getAppearance('mystery', `seed-${i}`, 'unknown');
      if (a.skin.kind === 'original') {
        primaries.add(a.skin.colors.primary);
      }
    }
    expect(primaries.size).toBeGreaterThan(1);
  });

  it('original skin is stable per run identity and does not vary by seedKey for the same id', () => {
    // Same id → same colors regardless of foremanTaskRunID
    const a = getAppearance('p', 'worker-A', 'unknown', 'run-42');
    const b = getAppearance('p', 'worker-A', 'unknown', 'run-43');
    if (a.skin.id === b.skin.id) {
      expect(a.skin.colors).toEqual(b.skin.colors);
    }
  });

  it('uses the tool color slot and never the legacy gear slot', () => {
    const a = getAppearance('p', 'k', 'unknown');
    expect(Object.prototype.hasOwnProperty.call(a.skin.colors, 'tool')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(a.skin.colors, 'gear')).toBe(false);
  });
});

describe('getAppearance — official/classic/original kinds and fixed colors', () => {
  it('official codebuddy skin carries kind "official" with fixed colors', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const a = getAppearance('p', `seed-${i}`, 'codebuddy');
      seen.add(a.skin.id);
      if (a.skin.id === 'classic-codebuddy') {
        expect(a.skin.kind).toBe('official');
        expect(a.skin.colors).toEqual({ primary: '#9AA3AA', accent: '#44D7B6', tool: '#334155' });
      }
    }
    expect(seen.has('classic-codebuddy')).toBe(true);
  });

  it('classic-voxel-miner carries kind "classic" with fixed colors', () => {
    for (let i = 0; i < 400; i++) {
      const a = getAppearance('p', `seed-${i}`, 'unknown');
      if (a.skin.id === 'classic-voxel-miner') {
        expect(a.skin.kind).toBe('classic');
        expect(a.skin.colors).toEqual({ primary: '#2A93B5', accent: '#41DDE8', tool: '#118A9A' });
        return;
      }
    }
    // Should have been reached within 400 seeds.
    expect.unreachable('classic-voxel-miner never selected');
  });

  it('ORIGINAL_SKIN_IDS has exactly the nine workshop role names', () => {
    expect(ORIGINAL_SKIN_IDS).toHaveLength(9);
    expect(ORIGINAL_SKIN_IDS).toEqual([
      'red-jumper', 'green-quest', 'blue-dash', 'block-miner', 'space-bounty',
      'arcade-ghost', 'rune-mage', 'shadow-ninja', 'slime-king',
    ]);
  });
});

describe('getAppearance — profile label', () => {
  it('preserves a compact visible profile label', () => {
    expect(getAppearance('codex-high', 'k', 'codex').profileLabel).toBe('codex-high');
  });

  it('falls back to "unknown" for an empty profile', () => {
    expect(getAppearance('   ', 'k', 'unknown').profileLabel).toBe('unknown');
  });

  it('no longer exposes legacy hat/palette/brandColor fields', () => {
    const a = getAppearance('p', 'k', 'unknown') as unknown as Record<string, unknown>;
    expect(a.hat).toBeUndefined();
    expect(a.palette).toBeUndefined();
    expect(a.brandColor).toBeUndefined();
  });
});
