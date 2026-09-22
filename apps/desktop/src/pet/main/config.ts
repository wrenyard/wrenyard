import type { HouseSkinId } from '../shared/entities';

export interface HouseConfig {
  displayId?: number;
  /** Runtime transparent-carrier origin; never persisted by the Desktop store. */
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

/**
 * Runtime view of the Pet module. The persisted source of truth is the Desktop
 * `pet` settings partition; this shape keeps the module's public fields stable
 * for the entity windows, model and renderers.
 *
 * Provider identities and legacy layouts are never reinterpreted here. Older
 * documents are normalized once, offline, by `tools/convert-settings.mjs`, so a
 * canonical id such as `anthropic` is never silently rewritten at runtime.
 */
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

/** Desktop-owned, user-editable projection of the Pet module. */
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

const DEFAULT_PROVIDER_IDS = [
  'chatgpt',
  'cursor',
  'deepseek',
  'zhipu-coding',
  'kimi-coding',
  'super-grok',
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

/**
 * Normalize a current-format Pet document. Missing fields fall back to
 * defaults and malformed values are dropped; provider ids, order and enabled
 * flags are copied verbatim because the runtime never reinterprets them.
 */
export function normalizeConfig(parsed: unknown): AppConfig {
  const obj = isRecord(parsed) ? parsed : {};
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

function normalizeQuotaConfig(obj: Record<string, unknown>): AppConfig['quota'] {
  const quotaObj = isRecord(obj.quota) ? obj.quota : {};
  const rawProviders = quotaObj.providers;
  if (Array.isArray(rawProviders)) {
    const providers: QuotaProviderEntry[] = [];
    const seen = new Set<string>();
    for (const entry of rawProviders) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      providers.push({
        id,
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
      });
    }
    return { providers };
  }
  return {
    providers: DEFAULT_PROVIDER_IDS.map((id) => ({ id, enabled: true })),
  };
}

export function normalizeWindowConfig(value: unknown): AppConfig['windows'] {
  return {
    graphSlip: normalizeSingleWindow(isRecord(value) ? value.graphSlip : undefined),
  };
}

function normalizeSingleWindow(value: unknown): WindowGeometry | undefined {
  if (!isRecord(value)) return undefined;
  const result: WindowGeometry = {};
  if (typeof value.x === 'number' && Number.isFinite(value.x)) result.x = value.x;
  if (typeof value.y === 'number' && Number.isFinite(value.y)) result.y = value.y;
  if (typeof value.width === 'number' && Number.isFinite(value.width)) result.width = value.width;
  if (typeof value.height === 'number' && Number.isFinite(value.height)) result.height = value.height;
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
  const obj = isRecord(partial) ? partial : {};
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
  if (isRecord(obj.entities)) {
    const entities = obj.entities;
    if (typeof entities.house === 'boolean') next.entities.house = entities.house;
    if (typeof entities.workers === 'boolean') next.entities.workers = entities.workers;
    if (typeof entities.taskgraphs === 'boolean') next.entities.taskgraphs = entities.taskgraphs;
  }
  if (isRecord(obj.appearance)) {
    const appearance = obj.appearance;
    if (appearance.houseSkin === 'classic' || appearance.houseSkin === 'mushroom') {
      next.appearance.houseSkin = appearance.houseSkin;
    }
  }
  if (isRecord(obj.quota)) {
    const quota = obj.quota;
    if (Array.isArray(quota.providers)) {
      const providers: QuotaProviderEntry[] = [];
      const seen = new Set<string>();
      for (const value of quota.providers) {
        if (!isRecord(value)) continue;
        const id = typeof value.id === 'string' ? value.id.trim() : '';
        if (id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        providers.push({
          id,
          enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
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

function normalizeHouseConfig(obj: Record<string, unknown>): HouseConfig {
  const houseObj = isRecord(obj.house) ? obj.house : undefined;
  return {
    displayId: validateOptionalInteger(houseObj?.displayId),
    x: validateOptionalFiniteNumber(houseObj?.x),
    y: validateOptionalFiniteNumber(houseObj?.y),
    entityX: validateOptionalFiniteNumber(houseObj?.entityX),
    entityY: validateOptionalFiniteNumber(houseObj?.entityY),
  };
}

function normalizeEntityVisibility(value: unknown): EntityVisibilityConfig {
  const obj = isRecord(value) ? value : {};
  return {
    house: typeof obj.house === 'boolean' ? obj.house : DEFAULT_CONFIG.entities.house,
    workers: typeof obj.workers === 'boolean' ? obj.workers : DEFAULT_CONFIG.entities.workers,
    taskgraphs: typeof obj.taskgraphs === 'boolean' ? obj.taskgraphs : DEFAULT_CONFIG.entities.taskgraphs,
  };
}

function normalizeAppearanceConfig(obj: Record<string, unknown>): AppConfig['appearance'] {
  const appearanceObj = isRecord(obj.appearance) ? obj.appearance : {};
  const skin = appearanceObj.houseSkin;
  return {
    houseSkin: skin === 'classic' || skin === 'mushroom' ? skin : DEFAULT_CONFIG.appearance.houseSkin,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
