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
  taskgraphs: boolean;
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
  enabled: boolean;
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
    graphSlip?: WindowGeometry;
  };
}

/** Desktop-owned, user-editable projection of the headless Pet component. */
export interface PetSettingsPayload {
  enabled: boolean;
  displayId?: number;
  scale: number;
  bubbleSeconds: number;
  bottomOffset: number;
  entities: EntityVisibilityConfig;
  appearance: {
    houseSkin: HouseSkinId;
  };
  quota: {
    providers: QuotaProviderEntry[];
  };
}

export interface PetSettingsPatchResult {
  config: AppConfig;
  changed: boolean;
}

const GROK_PROVIDER_ID = 'super-grok';
const LEGACY_GROK_ID = 'grok';
const CURSOR_PROVIDER_ID = 'cursor';
const DEEPSEEK_PROVIDER_ID = 'deepseek';
/** Single unified ChatGPT provider; legacy codex/codex-spark ids normalize here. */
const CHATGPT_PROVIDER_ID = 'chatgpt';
const LEGACY_CHATGPT_PROVIDER_IDS = ['codex', 'codex-spark'];

const DEFAULT_PROVIDER_IDS = [
  CHATGPT_PROVIDER_ID,
  CURSOR_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  'zhipu-coding',
  'kimi-coding',
  GROK_PROVIDER_ID,
];

const DEFAULT_CONFIG: AppConfig = {
  enabled: true,
  scale: 3,
  bubbleSeconds: 6,
  bottomOffset: 0,
  house: {},
  entities: {
    house: true,
    workers: true,
    taskgraphs: true,
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
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_CONFIG.enabled,
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
      providers: migrateDefaultGapProviders(migrateQuotaPoolIds(ids).map((id) => ({ id, enabled: true }))),
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
      return { providers: migrateDefaultGapProviders(migrateQuotaProviderIds(providers)) };
    }
  }

  // Default official providers
  return {
    providers: DEFAULT_PROVIDER_IDS.map((id) => ({ id, enabled: true })),
  };
}

/**
 * Insert the cursor provider enabled:true exactly once when absent, preserving
 * explicit cursor disabled state and the relative order of existing entries.
 * Also inserts deepseek exactly once immediately after cursor when cursor
 * exists, otherwise after chatgpt, when absent — preserving enabled values and
 * unknown providers and never duplicating entries.
 */
function migrateDefaultGapProviders(providers: QuotaProviderEntry[]): QuotaProviderEntry[] {
  const result = appendCursorWhenAbsent(providers);
  const hasDeepseek = result.some((p) => p.id === DEEPSEEK_PROVIDER_ID);
  if (hasDeepseek) return result;
  // Insert deepseek immediately after cursor when present to reflect its
  // popularity slot; otherwise immediately after chatgpt, else at the end.
  const cursorIdx = result.findIndex((p) => p.id === CURSOR_PROVIDER_ID);
  let insertAt: number;
  if (cursorIdx !== -1) {
    insertAt = cursorIdx + 1;
  } else {
    const chatgptIdx = result.findIndex((p) => p.id === CHATGPT_PROVIDER_ID);
    insertAt = chatgptIdx !== -1 ? chatgptIdx + 1 : result.length;
  }
  return [...result.slice(0, insertAt), { id: DEEPSEEK_PROVIDER_ID, enabled: true }, ...result.slice(insertAt)];
}

/**
 * Insert cursor immediately after ChatGPT when absent (or at the end when
 * ChatGPT is absent), preserving explicit cursor state and existing relative
 * order.
 */
function appendCursorWhenAbsent(providers: QuotaProviderEntry[]): QuotaProviderEntry[] {
  const hasCursor = providers.some((p) => p.id === CURSOR_PROVIDER_ID);
  if (hasCursor) return providers;
  const chatgptIdx = providers.findIndex((p) => p.id === CHATGPT_PROVIDER_ID);
  const insertAt = chatgptIdx === -1 ? providers.length : chatgptIdx + 1;
  return [
    ...providers.slice(0, insertAt),
    { id: CURSOR_PROVIDER_ID, enabled: true },
    ...providers.slice(insertAt),
  ];
}

/**
 * Migrate legacy `quota.pools` string ids to canonical provider ids.
 * Maps the exact legacy `grok` id to `super-grok` and the legacy ChatGPT ids
 * (`codex`, `codex-spark`) to the single `chatgpt` id, preserves ordering, and
 * deduplicates when both the legacy and canonical ids coexist.
 */
function migrateQuotaPoolIds(ids: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const mapped = id === LEGACY_GROK_ID
      ? GROK_PROVIDER_ID
      : LEGACY_CHATGPT_PROVIDER_IDS.includes(id)
        ? CHATGPT_PROVIDER_ID
        : id;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    result.push(mapped);
  }
  return result;
}

/**
 * Migrate legacy `quota.providers` entries to canonical ids.
 * Maps the exact legacy `grok` id to `super-grok` and the legacy ChatGPT
 * provider ids (`codex`, `codex-spark`) to the single `chatgpt` id, preserves
 * entry ordering and enabled state, and deduplicates when both ids coexist:
 * the explicit canonical entry's enabled value wins, while the merged entry
 * retains the stable position of its first occurrence.
 */
function migrateQuotaProviderIds(entries: QuotaProviderEntry[]): QuotaProviderEntry[] {
  const result: QuotaProviderEntry[] = [];
  const mergedIndexById = new Map<string, number>();
  for (const entry of entries) {
    const mappedId = entry.id === LEGACY_GROK_ID
      ? GROK_PROVIDER_ID
      : LEGACY_CHATGPT_PROVIDER_IDS.includes(entry.id)
        ? CHATGPT_PROVIDER_ID
        : entry.id;
    if (mappedId !== GROK_PROVIDER_ID && mappedId !== CHATGPT_PROVIDER_ID) {
      result.push(entry);
      continue;
    }
    const mergedIndex = mergedIndexById.get(mappedId);
    if (mergedIndex === undefined) {
      mergedIndexById.set(mappedId, result.length);
      result.push({ id: mappedId, enabled: entry.enabled });
    } else if (entry.id === mappedId) {
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

export function serializePetSettings(config: AppConfig): PetSettingsPayload {
  return {
    enabled: config.enabled,
    ...(config.house.displayId !== undefined ? { displayId: config.house.displayId } : {}),
    scale: config.scale,
    bubbleSeconds: config.bubbleSeconds,
    bottomOffset: config.bottomOffset,
    entities: { ...config.entities },
    appearance: { ...config.appearance },
    quota: {
      providers: config.quota.providers.map((provider) => ({ ...provider })),
    },
  };
}

/**
 * Apply the Desktop settings payload without exposing Pet window geometry or
 * runtime-owned placement fields. The returned config is a detached copy.
 */
export function applyPetSettingsPatch(config: AppConfig, partial: unknown): PetSettingsPatchResult {
  const obj = partial && typeof partial === 'object' ? partial as Record<string, unknown> : {};
  const next: AppConfig = {
    ...config,
    house: { ...config.house },
    entities: { ...config.entities },
    appearance: { ...config.appearance },
    quota: { providers: config.quota.providers.map((provider) => ({ ...provider })) },
    windows: { ...config.windows },
  };

  if (typeof obj.enabled === 'boolean') next.enabled = obj.enabled;
  if (Object.prototype.hasOwnProperty.call(obj, 'displayId')) {
    const displayId = validateOptionalInteger(obj.displayId);
    if (displayId !== next.house.displayId) {
      if (displayId === undefined) delete next.house.displayId;
      else next.house.displayId = displayId;
      delete next.house.x;
      delete next.house.y;
      delete next.house.entityX;
      delete next.house.entityY;
    }
  }

  if (typeof obj.scale === 'number' && Number.isFinite(obj.scale)) {
    next.scale = Math.max(1, Math.min(6, Math.round(obj.scale)));
  }
  if (typeof obj.bubbleSeconds === 'number' && Number.isFinite(obj.bubbleSeconds)) {
    next.bubbleSeconds = Math.max(1, Math.min(60, Math.round(obj.bubbleSeconds)));
  }
  if (typeof obj.bottomOffset === 'number' && Number.isFinite(obj.bottomOffset)) {
    next.bottomOffset = Math.max(0, Math.min(512, Math.round(obj.bottomOffset)));
  }
  if (obj.entities && typeof obj.entities === 'object') {
    const entities = obj.entities as Record<string, unknown>;
    if (typeof entities.house === 'boolean') next.entities.house = entities.house;
    if (typeof entities.workers === 'boolean') next.entities.workers = entities.workers;
    if (typeof entities.taskgraphs === 'boolean') next.entities.taskgraphs = entities.taskgraphs;
  }
  if (obj.appearance && typeof obj.appearance === 'object') {
    const appearance = obj.appearance as Record<string, unknown>;
    if (appearance.houseSkin === 'classic' || appearance.houseSkin === 'mushroom') {
      next.appearance.houseSkin = appearance.houseSkin;
    }
  }
  if (obj.quota && typeof obj.quota === 'object') {
    const quota = obj.quota as Record<string, unknown>;
    if (Array.isArray(quota.providers)) {
      const providers: QuotaProviderEntry[] = [];
      const seen = new Set<string>();
      for (const value of quota.providers) {
        if (!value || typeof value !== 'object') continue;
        const provider = value as Record<string, unknown>;
        const id = typeof provider.id === 'string' ? provider.id.trim() : '';
        if (id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        providers.push({
          id,
          enabled: typeof provider.enabled === 'boolean' ? provider.enabled : true,
        });
      }
      if (providers.length > 0) next.quota.providers = providers;
    }
  }

  return {
    config: next,
    changed: JSON.stringify(serializePetSettings(next)) !== JSON.stringify(serializePetSettings(config)),
  };
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
    taskgraphs: typeof obj.taskgraphs === 'boolean' ? obj.taskgraphs : DEFAULT_CONFIG.entities.taskgraphs,
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
