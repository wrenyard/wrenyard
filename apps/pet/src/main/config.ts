import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { HouseSkinId } from '../shared/entities';

export interface HouseConfig {
  displayId?: number;
  /** Legacy transparent carrier origin, retained for migration. */
  x?: number;
  y?: number;
  /** Absolute visible-house origin used by V3 edge-aware placement. */
  entityX?: number;
  entityY?: number;
}

export interface EntityVisibilityConfig {
  house: boolean;
  workers: boolean;
}

export interface QuotaProviderEntry {
  id: string;
  enabled: boolean;
}

export interface WindowGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface AppConfig {
  scale: number;
  bubbleSeconds: number;
  bottomOffset: number;
  house: HouseConfig;
  entities: EntityVisibilityConfig;
  appearance: {
    houseSkin: HouseSkinId;
  };
  quota: {
    providers: QuotaProviderEntry[];
  };
  windows: {
    stats?: WindowGeometry;
    settings?: WindowGeometry;
    graphSlip?: WindowGeometry;
  };
}

const GROK_PROVIDER_ID = 'super-grok';
const LEGACY_GROK_ID = 'grok';

const DEFAULT_PROVIDER_IDS = ['codex', 'codex-spark', 'kimi-coding', 'zhipu-coding', GROK_PROVIDER_ID];

const DEFAULT_CONFIG: AppConfig = {
  scale: 3,
  bubbleSeconds: 6,
  bottomOffset: 0,
  house: {},
  entities: {
    house: true,
    workers: true,
  },
  appearance: {
    houseSkin: 'classic',
  },
  quota: {
    providers: DEFAULT_PROVIDER_IDS.map((id) => ({ id, enabled: true })),
  },
  windows: {},
};

const NAMESPACE = 'wrenyard';
const APP_NAME = 'pet';
const SETTINGS_FILENAME = 'settings.json';
const CONFIG_BASE = path.join(os.homedir(), '.config');
const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.foreman-pet', 'config.json');

function getConfigDir(base: string): string {
  return path.join(base, NAMESPACE, APP_NAME);
}

function getConfigPath(base: string): string {
  return path.join(getConfigDir(base), SETTINGS_FILENAME);
}

/** Pre-Wrenyard settings location; read only when the new path is absent. */
export function legacySettingsConfigPath(base: string): string {
  return path.join(base, 'foreman-pet', SETTINGS_FILENAME);
}

export interface LoadConfigOptions {
  /** Override config base dir for testing */
  configHome?: string;
  /** Override legacy config path for testing */
  legacyConfigPath?: string;
}

export interface SaveConfigOptions {
  /** Override config base dir for testing */
  configHome?: string;
}

export function loadConfig(opts?: LoadConfigOptions): AppConfig {
  const base = opts?.configHome ?? CONFIG_BASE;
  const cfgPath = getConfigPath(base);
  const legacySettingsPath = legacySettingsConfigPath(base);
  const legacyPath = opts?.legacyConfigPath ?? LEGACY_CONFIG_PATH;

  // Safe legacy reads: if the new wrenyard/pet path doesn't exist, read the
  // old settings location, then the ancient ~/.foreman-pet/config.json.
  if (!fs.existsSync(cfgPath)) {
    const legacySource = [legacySettingsPath, legacyPath].find((p) => fs.existsSync(p));
    if (legacySource !== undefined) {
      try {
        const raw = fs.readFileSync(legacySource, 'utf-8');
        const parsed = JSON.parse(raw);
        return normalizeConfig(parsed);
      } catch {
        return createDefaultConfig(cfgPath);
      }
    }
  }

  // Normal flow
  try {
    if (!fs.existsSync(cfgPath)) {
      return createDefaultConfig(cfgPath);
    }
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch {
    return createDefaultConfig(cfgPath);
  }
}

export function normalizeConfig(parsed: unknown): AppConfig {
  const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};

  return {
    scale: validateRangeNumber(obj.scale, DEFAULT_CONFIG.scale, 1, 6),
    bubbleSeconds: validateRangeNumber(obj.bubbleSeconds, DEFAULT_CONFIG.bubbleSeconds, 1, 60),
    bottomOffset: validateRangeNumber(obj.bottomOffset, DEFAULT_CONFIG.bottomOffset, 0, 512),
    house: normalizeHouseConfig(obj),
    entities: normalizeEntityVisibility(obj.entities),
    appearance: normalizeAppearanceConfig(obj),
    quota: normalizeQuotaConfig(obj),
    windows: normalizeWindowConfig(obj.windows),
  };
}

export function normalizeQuotaConfig(obj: Record<string, unknown>): AppConfig['quota'] {
  const quotaObj = obj.quota && typeof obj.quota === 'object' ? obj.quota as Record<string, unknown> : {};

  // Legacy migration: if quota.pools (string[]) exists, convert to providers
  if (Array.isArray(quotaObj.pools)) {
    const ids = quotaObj.pools as string[];
    return {
      providers: migrateQuotaPoolIds(ids).map((id) => ({ id, enabled: true })),
    };
  }

  const rawProviders = quotaObj.providers;
  if (Array.isArray(rawProviders)) {
    const providers: QuotaProviderEntry[] = [];
    for (const entry of rawProviders) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        if (typeof e.id === 'string') {
          providers.push({
            id: e.id,
            enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
          });
        }
      }
    }
    if (providers.length > 0) {
      return { providers: migrateQuotaProviderIds(providers) };
    }
  }

  // Default official providers
  return {
    providers: DEFAULT_PROVIDER_IDS.map((id) => ({ id, enabled: true })),
  };
}

/**
 * Migrate legacy `quota.pools` string ids to canonical provider ids.
 * Maps the exact legacy `grok` id to `super-grok`, preserves ordering,
 * and deduplicates when both the legacy and canonical ids coexist.
 */
function migrateQuotaPoolIds(ids: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const mapped = id === LEGACY_GROK_ID ? GROK_PROVIDER_ID : id;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    result.push(mapped);
  }
  return result;
}

/**
 * Migrate legacy `quota.providers` entries to canonical ids.
 * Maps the exact legacy `grok` id to `super-grok`, preserves entry ordering
 * and enabled state, and deduplicates when both ids coexist: the explicit
 * canonical `super-grok` entry's enabled value wins, while the merged entry
 * retains the stable position of its first occurrence.
 */
function migrateQuotaProviderIds(entries: QuotaProviderEntry[]): QuotaProviderEntry[] {
  const result: QuotaProviderEntry[] = [];
  let mergedIndex = -1;
  for (const entry of entries) {
    const mappedId = entry.id === LEGACY_GROK_ID ? GROK_PROVIDER_ID : entry.id;
    if (mappedId !== GROK_PROVIDER_ID) {
      result.push(entry);
      continue;
    }
    if (mergedIndex === -1) {
      mergedIndex = result.length;
      result.push({ id: GROK_PROVIDER_ID, enabled: entry.enabled });
    } else if (entry.id === GROK_PROVIDER_ID) {
      // Explicit canonical entry's enabled value wins over a mapped legacy entry.
      result[mergedIndex].enabled = entry.enabled;
    }
    // Legacy duplicate after the merged entry is dropped entirely.
  }
  return result;
}

export function normalizeWindowConfig(value: unknown): AppConfig['windows'] {
  const obj = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    stats: normalizeSingleWindow(obj.stats),
    settings: normalizeSingleWindow(obj.settings),
    graphSlip: normalizeSingleWindow(obj.graphSlip),
  };
}

function normalizeSingleWindow(value: unknown): WindowGeometry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const result: WindowGeometry = {};
  if (typeof obj.x === 'number' && Number.isFinite(obj.x)) result.x = obj.x;
  if (typeof obj.y === 'number' && Number.isFinite(obj.y)) result.y = obj.y;
  if (typeof obj.width === 'number' && Number.isFinite(obj.width)) result.width = obj.width;
  if (typeof obj.height === 'number' && Number.isFinite(obj.height)) result.height = obj.height;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function validateRangeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

export function validateOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }
  return value;
}

export function validateOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export function saveConfig(config: AppConfig, opts?: SaveConfigOptions): void {
  const base = opts?.configHome ?? CONFIG_BASE;
  const cfgPath = getConfigPath(base);
  try {
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // silently ignore write errors
  }
}

function createDefaultConfig(configPath: string): AppConfig {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  } catch {
    // silently ignore write errors
  }
  return cloneDefaultConfig();
}

function normalizeHouseConfig(obj: Record<string, unknown>): HouseConfig {
  const houseObj = obj.house && typeof obj.house === 'object'
    ? obj.house as Record<string, unknown>
    : undefined;

  return {
    displayId: validateOptionalInteger(houseObj?.displayId ?? obj.displayId),
    x: validateOptionalFiniteNumber(houseObj?.x),
    y: validateOptionalFiniteNumber(houseObj?.y),
    entityX: validateOptionalFiniteNumber(houseObj?.entityX),
    entityY: validateOptionalFiniteNumber(houseObj?.entityY),
  };
}

function normalizeEntityVisibility(value: unknown): EntityVisibilityConfig {
  const obj = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    house: typeof obj.house === 'boolean' ? obj.house : DEFAULT_CONFIG.entities.house,
    workers: typeof obj.workers === 'boolean' ? obj.workers : DEFAULT_CONFIG.entities.workers,
  };
}

function normalizeAppearanceConfig(obj: Record<string, unknown>): AppConfig['appearance'] {
  const appearanceObj = obj.appearance && typeof obj.appearance === 'object'
    ? obj.appearance as Record<string, unknown>
    : {};
  const skin = appearanceObj.houseSkin;
  return {
    houseSkin: skin === 'classic' || skin === 'mushroom' ? skin : DEFAULT_CONFIG.appearance.houseSkin,
  };
}

function cloneDefaultConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    house: { ...DEFAULT_CONFIG.house },
    entities: { ...DEFAULT_CONFIG.entities },
    appearance: { ...DEFAULT_CONFIG.appearance },
    quota: {
      providers: DEFAULT_CONFIG.quota.providers.map((p) => ({ ...p })),
    },
    windows: { ...DEFAULT_CONFIG.windows },
  };
}
