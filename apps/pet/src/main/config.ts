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
  /** Persisted marker: provider identities in this document were migrated once.
   *  Its presence is what stops a modern `anthropic` API preference from being
   *  silently reinterpreted as the legacy subscription provider again. */
  providerMigration?: string;
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
/** Single unified ChatGPT provider; legacy codex ids normalize here. */
const CHATGPT_PROVIDER_ID = 'chatgpt';
const LEGACY_CHATGPT_PROVIDER_IDS = ['codex'];

/**
 * Exact legacy quota-provider ids mapped to their renamed canonical ids.
 * `anthropic-api` was the API provider that is now simply `anthropic`; the
 * legacy `anthropic` id was the subscription provider that is now
 * `claude-coding`. The internal `opencode-native` route is now `opencode-zen`.
 * Only these exact ids change, and only while the document is unmarked.
 */
const LEGACY_PROVIDER_ID_MAP: Readonly<Record<string, string>> = {
  'anthropic-api': 'anthropic',
  'opencode-native': 'opencode-zen',
};
/** Legacy subscription provider id, renamed to the distinct `claude-coding`. */
const LEGACY_SUBSCRIPTION_PROVIDER_ID = 'anthropic';
const SUBSCRIPTION_PROVIDER_ID = 'claude-coding';

/** Marker persisted alongside the config once provider identities are migrated. */
const PROVIDER_MIGRATION_MARKER = 'provider-identity-v1';

/** One-shot left-to-right renames. The legacy subscription id is checked first
 *  so the legacy subscription `anthropic` becomes `claude-coding`; the legacy
 *  API `anthropic-api` is checked afterwards and becomes `anthropic` without
 *  being chained into `claude-coding`. Matching stops at the first hit, so a
 *  value is rewritten at most once and a canonical `anthropic` written by an
 *  earlier migration is only preserved while the document stays unmarked. */
const PROVIDER_ID_RENAMES: ReadonlyArray<readonly [string, string]> = [
  [LEGACY_SUBSCRIPTION_PROVIDER_ID, SUBSCRIPTION_PROVIDER_ID],
  ...Object.entries(LEGACY_PROVIDER_ID_MAP).map(([from, to]) => [from, to] as const),
];

/** Collapse an exact legacy quota-provider id to its canonical id. */
function canonicalQuotaProviderId(id: string): string {
  for (const [from, to] of PROVIDER_ID_RENAMES) {
    if (id === from) return to;
  }
  return id;
}

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
        // The page order is a runtime concern, not a persisted one, so it is
        // computed during normalization and dropped before saving.
        const { config, changed } = normalizeConfigWithMigration(parsed);
        const result = { ...config };
        // Persist the migrated document once so a legacy subscription id is
        // not reinterpreted on the next read; saveConfig writes the marker.
        if (changed) saveConfig(result, opts);
        return result;
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
    const { config, changed } = normalizeConfigWithMigration(parsed);
    const result = { ...config };
    if (changed) saveConfig(result, opts);
    return result;
  } catch {
    return createDefaultConfig(cfgPath);
  }
}

export function normalizeConfig(parsed: unknown): AppConfig {
  const { config } = normalizeConfigWithMigration(parsed);
  return config;
}

/**
 * Normalize a persisted document and, when its provider identities are still
 * on legacy ids, rewrite them exactly once: the legacy subscription `anthropic`
 * becomes `claude-coding`, legacy API `anthropic-api` becomes `anthropic`, and
 * `opencode-native` becomes `opencode-zen`. Order, enabled flags, and unknown
 * providers are preserved. Unmarked documents are persisted with the marker
 * even when they contain no old provider references.
 */
function normalizeConfigWithMigration(
  parsed: unknown,
): { config: AppConfig; changed: boolean } {
  const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  if (obj.providerMigration === PROVIDER_MIGRATION_MARKER) {
    return { config: normalizeConfigDocument(obj, false), changed: false };
  }
  const firstId = firstQuotaProviderId(obj);
  const rewritten = firstId !== undefined && canonicalQuotaProviderId(firstId) !== firstId;
  const config = normalizeConfigDocument(
    obj,
    true,
    rewritten ? DEFAULT_PROVIDER_IDS[0] : undefined,
  );
  return { config, changed: true };
}

function firstQuotaProviderId(obj: Record<string, unknown>): string | undefined {
  const quota = obj.quota && typeof obj.quota === 'object' ? obj.quota as Record<string, unknown> : undefined;
  if (!quota) return undefined;
  if (Array.isArray(quota.pools)) {
    return typeof quota.pools[0] === 'string' ? quota.pools[0] : undefined;
  }
  const providers = quota.providers;
  if (!Array.isArray(providers)) return undefined;
  for (const entry of providers) {
    if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string') {
      return (entry as Record<string, unknown>).id as string;
    }
  }
  return undefined;
}

/** Marker entry spread into every fresh or migrated persisted document. */
function migrationMarkerEntry(): { providerMigration: string } {
  return { providerMigration: PROVIDER_MIGRATION_MARKER };
}

function normalizeConfigDocument(
  obj: Record<string, unknown>,
  migrateProviders: boolean,
  reorderAfterKey?: string,
): AppConfig {
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_CONFIG.enabled,
    scale: validateRangeNumber(obj.scale, DEFAULT_CONFIG.scale, 1, 6),
    bubbleSeconds: validateRangeNumber(obj.bubbleSeconds, DEFAULT_CONFIG.bubbleSeconds, 1, 60),
    bottomOffset: validateRangeNumber(obj.bottomOffset, DEFAULT_CONFIG.bottomOffset, 0, 512),
    house: normalizeHouseConfig(obj),
    entities: normalizeEntityVisibility(obj.entities),
    appearance: normalizeAppearanceConfig(obj),
    quota: normalizeQuotaConfig(obj, migrateProviders, reorderAfterKey),
    windows: normalizeWindowConfig(obj.windows),
  };
}

export function normalizeQuotaConfig(
  obj: Record<string, unknown>,
  migrateProviders = true,
  reorderAfterKey?: string,
): AppConfig['quota'] {
  const quotaObj = obj.quota && typeof obj.quota === 'object' ? obj.quota as Record<string, unknown> : {};

  // Legacy migration: if quota.pools (string[]) exists, convert to providers
  if (Array.isArray(quotaObj.pools)) {
    const ids = quotaObj.pools as string[];
    const migratedIds = migrateProviders ? migrateQuotaPoolIds(ids) : ids;
    return {
      providers: migrateDefaultGapProviders(migratedIds.map((id) => ({ id, enabled: true })), reorderAfterKey),
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
      const migrated = migrateProviders ? migrateQuotaProviderIds(providers) : providers;
      return { providers: migrateDefaultGapProviders(migrated, reorderAfterKey) };
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
 * When the first entry's id was itself rewritten during migration
 * (`reorderAfterKey`), the newly inserted gap default is placed after that
 * re-anchored entry instead of before it. Also inserts deepseek exactly once
 * immediately after cursor when cursor exists, otherwise after chatgpt, when
 * absent — preserving enabled values and unknown providers and never
 * duplicating entries.
 */
function migrateDefaultGapProviders(
  providers: QuotaProviderEntry[],
  reorderAfterKey?: string,
): QuotaProviderEntry[] {
  const result = appendCursorWhenAbsent(providers, reorderAfterKey);
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
function appendCursorWhenAbsent(
  providers: QuotaProviderEntry[],
  reorderAfterKey?: string,
): QuotaProviderEntry[] {
  const hasCursor = providers.some((p) => p.id === CURSOR_PROVIDER_ID);
  if (hasCursor) return providers;
  const chatgptIdx = providers.findIndex((p) => p.id === CHATGPT_PROVIDER_ID);
  let insertAt: number;
  if (chatgptIdx !== -1) {
    insertAt = reorderAfterKey === CHATGPT_PROVIDER_ID ? 0 : chatgptIdx + 1;
  } else {
    insertAt = providers.length;
  }
  return [
    ...providers.slice(0, insertAt),
    { id: CURSOR_PROVIDER_ID, enabled: true },
    ...providers.slice(insertAt),
  ];
}

/**
 * Migrate legacy `quota.pools` string ids to canonical provider ids.
 * Maps the exact legacy `grok` id to `super-grok` and the legacy ChatGPT id
 * (`codex`) to the single `chatgpt` id, preserves ordering, and
 * deduplicates when both the legacy and canonical ids coexist.
 */
function migrateQuotaPoolIds(ids: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const renamed = canonicalQuotaProviderId(id);
    const mapped = renamed === LEGACY_GROK_ID
      ? GROK_PROVIDER_ID
      : LEGACY_CHATGPT_PROVIDER_IDS.includes(renamed)
        ? CHATGPT_PROVIDER_ID
        : renamed;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    result.push(mapped);
  }
  return result;
}

/**
 * Migrate legacy `quota.providers` entries to canonical ids.
 * Maps the exact legacy `grok` id to `super-grok` and the legacy ChatGPT
 * provider id (`codex`) to the single `chatgpt` id, preserves
 * entry ordering and enabled state, and deduplicates when both ids coexist:
 * the explicit canonical entry's enabled value wins, while the merged entry
 * retains the stable position of its first occurrence.
 */
function migrateQuotaProviderIds(entries: QuotaProviderEntry[]): QuotaProviderEntry[] {
  const result: QuotaProviderEntry[] = [];
  const mergedIndexById = new Map<string, number>();
  for (const entry of entries) {
    const renamedId = canonicalQuotaProviderId(entry.id);
    const mappedId = renamedId === LEGACY_GROK_ID
      ? GROK_PROVIDER_ID
      : LEGACY_CHATGPT_PROVIDER_IDS.includes(renamedId)
        ? CHATGPT_PROVIDER_ID
        : renamedId;
    // Every canonical id is tracked so a renamed legacy id (anthropic-api ->
    // anthropic, opencode-native -> opencode-zen) merges into an already-present
    // canonical entry instead of duplicating it. The merged entry keeps the
    // first occurrence's position; an explicit canonical entry's enabled value
    // wins over any mapped legacy duplicate.
    const mergedIndex = mergedIndexById.get(mappedId);
    if (mergedIndex === undefined) {
      mergedIndexById.set(mappedId, result.length);
      result.push({ id: mappedId, enabled: entry.enabled });
    } else if (entry.id === mappedId) {
      result[mergedIndex].enabled = entry.enabled;
    }
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
    // Persist canonical provider identities once.
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ ...config, ...migrationMarkerEntry() }, null, 2),
      'utf-8',
    );
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
    // Fresh defaults already use canonical provider ids, so they are written
    // pre-marked and never trigger a legacy rewrite.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...DEFAULT_CONFIG, ...migrationMarkerEntry() }, null, 2),
      'utf-8',
    );
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
    ...migrationMarkerEntry(),
  };
}
