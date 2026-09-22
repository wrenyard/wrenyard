/**
 * Worker appearance palette + normalization.
 *
 * Contains production skin palette and color normalization helpers used by the
 * worker entity renderer. Preview-only and retired palette paths are
 * intentionally absent.
 *
 * FU-002 / IU-001
 */

import type { Appearance, WorkerSkin, WorkerSkinKind } from '../../../shared/snapshot';

function toHex(component: number): string {
  const clamped = Math.max(0, Math.min(255, Math.floor(component)));
  return clamped.toString(16).padStart(2, '0');
}

export function darkenColor(hex: string, factor: number): string {
  const r = Math.floor(parseInt(hex.slice(1, 3), 16) * factor);
  const g = Math.floor(parseInt(hex.slice(3, 5), 16) * factor);
  const b = Math.floor(parseInt(hex.slice(5, 7), 16) * factor);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function lightenColor(hex: string, factor: number): string {
  const r = Math.min(255, Math.floor(parseInt(hex.slice(1, 3), 16) * factor));
  const g = Math.min(255, Math.floor(parseInt(hex.slice(3, 5), 16) * factor));
  const b = Math.min(255, Math.floor(parseInt(hex.slice(5, 7), 16) * factor));
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export const VALID_SKIN_IDS: ReadonlySet<WorkerSkin['id']> = new Set<WorkerSkin['id']>([
  'classic-codebuddy',
  'classic-codex',
  'classic-claude',
  'classic-voxel-miner',
  'red-jumper',
  'green-quest',
  'blue-dash',
  'block-miner',
  'space-bounty',
  'arcade-ghost',
  'rune-mage',
  'shadow-ninja',
  'slime-king',
]);

export function isWorkerSkinId(value: unknown): value is WorkerSkin['id'] {
  return typeof value === 'string' && VALID_SKIN_IDS.has(value as WorkerSkin['id']);
}

const FALLBACK_SKIN: WorkerSkin = {
  kind: 'original',
  id: 'blue-dash',
  name: 'Blue Dash',
  colors: { primary: '#2F7DE1', accent: '#8FE3FF', tool: '#1F3D6D' },
};

function skinKindForId(id: WorkerSkin['id']): WorkerSkinKind {
  if (id === 'classic-codebuddy' || id === 'classic-codex' || id === 'classic-claude') return 'official';
  if (id === 'classic-voxel-miner') return 'classic';
  return 'original';
}

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : fallback;
}

function normalizeSkin(skin: unknown): WorkerSkin {
  if (typeof skin !== 'object' || skin === null) return FALLBACK_SKIN;

  const candidate = skin as Partial<WorkerSkin>;
  if (!isWorkerSkinId(candidate.id)) return FALLBACK_SKIN;

  const colors = candidate.colors ?? FALLBACK_SKIN.colors;
  return {
    kind: skinKindForId(candidate.id),
    id: candidate.id,
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : candidate.id,
    colors: {
      primary: normalizeColor(colors.primary, FALLBACK_SKIN.colors.primary),
      accent: normalizeColor(colors.accent, FALLBACK_SKIN.colors.accent),
      tool: normalizeColor(colors.tool, FALLBACK_SKIN.colors.tool),
    },
  };
}

export function normalizeAppearance(appearance: Partial<Appearance> | null | undefined): Appearance {
  const profile = typeof appearance?.profile === 'string' ? appearance.profile : null;
  const rawLabel = typeof appearance?.profileLabel === 'string' ? appearance.profileLabel : profile;

  return {
    profile,
    profileLabel: rawLabel?.trim() || 'unknown',
    skin: normalizeSkin(appearance?.skin),
  };
}

export interface SkinPalette {
  primary: string;
  primaryDark: string;
  primaryLight: string;
  accent: string;
  accentDark: string;
  tool: string;
  toolDark: string;
  outline: string;
  panel: string;
  panelLight: string;
  white: string;
  cream: string;
  shadow: string;
}

export function skinPalette(appearance: Appearance): SkinPalette {
  const colors = appearance.skin.colors;
  return {
    primary: colors.primary,
    primaryDark: darkenColor(colors.primary, 0.58),
    primaryLight: lightenColor(colors.primary, 1.28),
    accent: colors.accent,
    accentDark: darkenColor(colors.accent, 0.64),
    tool: colors.tool,
    toolDark: darkenColor(colors.tool, 0.6),
    outline: '#2E2018',
    panel: '#2E2018',
    panelLight: '#3A2A1E',
    white: '#F7EFD8',
    cream: '#F7EFD8',
    shadow: 'rgba(46,32,24,0.30)',
  };
}

export function voxelMinerPalette() {
  return {
    outline: '#2E2018',
    skin: '#C48A5C',
    skinDark: '#A06A40',
    hairLight: '#5A6B7A',
    hair: '#4A5B6A',
    hairDark: '#2E2018',
    eye: '#171717',
    mouth: '#4A261B',
    shirt: '#4A6FA5',
    shirtLight: '#6B8FC5',
    shirtDark: '#2E4F6F',
    pants: '#5A6B7A',
    pantsDark: '#3A4B5A',
    shoe: '#2E2018',
    diamond: '#FFC94D',
    diamondLight: '#FFE88A',
    diamondDark: '#B58A00',
    handle: '#8A5A2E',
    handleDark: '#5B3218',
  };
}

/**
 * Parse any CSS color string (#rrggbb, rgb(), rgba()) into a hex color
 * string and a separate alpha value.
 */
export function parseColorAlpha(input: string): { color: string; alpha: number } {
  if (input.startsWith('#')) {
    return { color: input, alpha: 1 };
  }
  const rgba = input.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const parts = rgba[1].split(',').map((s) => s.trim());
    const r = parseInt(parts[0], 10);
    const g = parseInt(parts[1], 10);
    const b = parseInt(parts[2], 10);
    const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
    return { color: `#${toHex(r)}${toHex(g)}${toHex(b)}`, alpha: a };
  }
  return { color: '#000000', alpha: 0 };
}

/**
 * Convert a CSS color string into a hex color string for RenderColor use.
 * Discards alpha information — use parseColorAlpha if alpha is needed.
 */
export function toHexColor(input: string): string {
  return parseColorAlpha(input).color;
}
