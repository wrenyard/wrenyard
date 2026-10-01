import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '@wrenyard/themes';
import {
  normalizeConfig,
  type AppConfig,
  type QuotaProviderEntry,
} from '../../pet/main/config';
import type { EntityVisibilityConfig } from '../../pet/main/config';
import {
  APPEARANCE_ZOOM_OPTIONS,
  NOTIFICATION_EVENT_IDS,
  validatePreferenceValue,
  type AppearanceSettings,
  type GeneralPreferences,
  type NotificationEventPreferences,
  type NotificationPreferences,
  type PreferenceId,
  type SessionPreferences,
  type StatusBarPreferences,
  type UpdatePreferences,
} from '../../shell-contract.js';

export type { NotificationEventPreferences, NotificationPreferences };

/**
 * Desktop-owned UI preference document. A single store in the Desktop main
 * process is the only writer: every mutation patches one partition and is
 * merged serially into the latest on-disk document, written atomically, and
 * then broadcast as a fresh snapshot so no controller can clobber a partition
 * it does not own.
 *
 * Source layout and document schema are the only migration surface. The
 * runtime never reads a Pet-specific file or a legacy document: a one-time
 * offline conversion tool (`apps/desktop/tools/convert-settings.mjs`) produced
 * the version 2 document from older layouts; version 3 is produced in place by
 * normalization, which preserves every version 2 partition and fills the new
 * `general`, `session`, `statusBar` partitions (and `appearance.zoom`) with
 * defaults.
 */
export const DESKTOP_SETTINGS_VERSION = 3 as const;

/** Highest version this store can upgrade in place. */
const UPGRADABLE_SETTINGS_VERSIONS = new Set([2, 3]);

/** Low-level window chrome the Desktop shell reuses across restarts. */
export interface WindowGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface WindowSettings {
  /** Primary shell window geometry; absent until the user moves/resizes it. */
  shell?: WindowGeometry;
  /** Shared TaskGraph detail / transcript geometry, by surface id. */
  graphSlip?: WindowGeometry;
}

export interface TraySettings {
  /** Reserved for future tray-only toggles; currently the tray mirrors Pet. */
  showQuota?: boolean;
}

/** Desktop display preference for provider ordering/visibility. */
export interface ProviderDisplaySettings {
  providers: QuotaProviderEntry[];
}

/** Desktop UI preference for the Pet module, distinct from its runtime state. */
export interface PetSettings {
  /** User intent: whether the Pet is shown. Distinct from runtime disposal. */
  visible: boolean;
  displayId?: number;
  scale: number;
  bubbleSeconds: number;
  bottomOffset: number;
  entities: EntityVisibilityConfig;
  appearance: AppConfig['appearance'];
  layout?: {
    entityX?: number;
    entityY?: number;
  };
}

export interface DesktopSettings {
  version: typeof DESKTOP_SETTINGS_VERSION;
  window: WindowSettings;
  tray: TraySettings;
  providers: ProviderDisplaySettings;
  pet: PetSettings;
  /** Shared appearance preferences, owned by the main process. */
  appearance: AppearanceSettings;
  notifications: NotificationPreferences;
  /** General shell behaviour (startup page, quit confirmation). */
  general: GeneralPreferences;
  /** Session defaults and last-sent model memory. */
  session: SessionPreferences;
  /** Status-bar item visibility. */
  statusBar: StatusBarPreferences;
  /** Update behaviour. */
  update: UpdatePreferences;
}

/**
 * Reported when the on-disk document cannot be used as-is. The caller decides
 * whether to surface or fail; the original file is always preserved.
 */
export class DesktopSettingsCorruptError extends Error {
  readonly code: 'parse_failed' | 'unsupported_version';
  readonly path: string;

  constructor(code: 'parse_failed' | 'unsupported_version', path: string, message: string) {
    super(message);
    this.name = 'DesktopSettingsCorruptError';
    this.code = code;
    this.path = path;
  }
}

const DEFAULT_PROVIDER_IDS = [
  'chatgpt',
  'cursor',
  'deepseek',
  'zhipu-coding',
  'kimi-coding',
  'super-grok',
];

/** Appearance defaults used when the partition is absent or partially invalid. */
export function defaultAppearanceSettings(): AppearanceSettings {
  return { theme: DEFAULT_THEME_ID, colorMode: 'system', motion: 'system', zoom: 100 };
}

export function defaultGeneralPreferences(): GeneralPreferences {
  return { startupPage: 'last', confirmQuit: true };
}

export function defaultSessionPreferences(): SessionPreferences {
  return {
    defaultModel: 'last',
    model: null,
    effort: null,
    lastSentModel: null,
    lastSentEffort: null,
    sendKey: 'enter',
  };
}

export function defaultNotificationPreferences(): NotificationPreferences {
  return {
    system: true,
    sound: true,
    doNotDisturb: false,
    events: {
      taskCompleted: true,
      taskFailed: true,
      sessionReplyCompleted: true,
      quotaWarning: true,
      updateAvailable: true,
      daemonDisconnected: true,
    },
  };
}

export function defaultDesktopSettings(): DesktopSettings {
  return {
    version: DESKTOP_SETTINGS_VERSION,
    window: {},
    tray: {},
    providers: { providers: DEFAULT_PROVIDER_IDS.map((id) => ({ id, enabled: true })) },
    appearance: defaultAppearanceSettings(),
    pet: {
      visible: true,
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true, taskgraphs: true },
      appearance: { houseSkin: 'classic' },
    },
    notifications: defaultNotificationPreferences(),
    general: defaultGeneralPreferences(),
    session: defaultSessionPreferences(),
    statusBar: { hidden: [] },
    update: { autoCheck: true },
  };
}

export interface DesktopSettingsStoreOptions {
  path: string;
  /** Defaults applied when the file is absent (fresh install). */
  defaults?: () => DesktopSettings;
  /** Invoked whenever the persisted document changes. */
  onChange?: (settings: DesktopSettings) => void;
}

/**
 * Partitioned, single-writer settings store. `load` is lenient only for a
 * missing file (defaults) — a present-but-unparsable or future-version
 * document raises {@link DesktopSettingsCorruptError} and is left untouched so
 * a corrupted file is never silently overwritten with defaults.
 */
export class DesktopSettingsStore {
  private readonly path: string;
  private readonly defaults: () => DesktopSettings;
  private readonly onChange: ((settings: DesktopSettings) => void) | undefined;
  private cached: DesktopSettings | null = null;

  constructor(options: DesktopSettingsStoreOptions) {
    this.path = options.path;
    this.defaults = options.defaults ?? defaultDesktopSettings;
    this.onChange = options.onChange;
  }

  /** Load (and cache) the current document. Missing file yields defaults. */
  load(): DesktopSettings {
    if (this.cached) return cloneSettings(this.cached);
    const parsed = this.read();
    if (parsed === undefined) {
      this.cached = this.defaults();
      return cloneSettings(this.cached);
    }
    this.cached = normalizeDesktopSettings(parsed);
    return cloneSettings(this.cached);
  }

  /** Replace one partition, merging against the latest document on disk. */
  patch<K extends keyof Omit<DesktopSettings, 'version'>>(
    section: K,
    value: DesktopSettings[K],
  ): DesktopSettings {
    const current = this.load();
    const next: DesktopSettings = {
      ...current,
      [section]: value,
    };
    this.write(next);
    return cloneSettings(next);
  }

  /** Persist a whole document; used by the store's own bootstrap only. */
  save(settings: DesktopSettings): DesktopSettings {
    this.write(settings);
    return cloneSettings(this.cached ?? settings);
  }

  private read(): unknown | undefined {
    if (!existsSync(this.path)) return undefined;
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      throw new DesktopSettingsCorruptError(
        'parse_failed',
        this.path,
        `Desktop settings could not be read at ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new DesktopSettingsCorruptError(
        'parse_failed',
        this.path,
        `Desktop settings are not valid JSON at ${this.path}; the file was preserved and defaults were not written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private write(settings: DesktopSettings): void {
    const document: DesktopSettings = { ...settings, version: DESKTOP_SETTINGS_VERSION };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.path);
    this.cached = cloneSettings(document);
    this.onChange?.(cloneSettings(document));
  }
}

/**
 * Normalize a persisted document into the version 3 shape. Version 2 files are
 * upgraded in place: every existing partition is preserved and the new
 * `general`, `session`, `statusBar` partitions and `appearance.zoom` receive
 * defaults. An unsupported (future or pre-version-2, unversioned) document is
 * rejected explicitly, because older migration is offline-only and must never
 * be inferred at runtime.
 */
export function normalizeDesktopSettings(parsed: unknown): DesktopSettings {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DesktopSettingsCorruptError(
      'parse_failed',
      '',
      'Desktop settings document must be a JSON object at the document root.',
    );
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (typeof version !== 'number' || !UPGRADABLE_SETTINGS_VERSIONS.has(version)) {
    throw new DesktopSettingsCorruptError(
      'unsupported_version',
      '',
      `Unsupported Desktop settings version ${String(version)}; expected ${DESKTOP_SETTINGS_VERSION}. Run the offline conversion tool before starting Desktop.`,
    );
  }
  const defaults = defaultDesktopSettings();
  return {
    version: DESKTOP_SETTINGS_VERSION,
    window: normalizeWindowSettings(obj.window),
    tray: normalizeTraySettings(obj.tray),
    providers: normalizeProviderDisplaySettings(obj.providers, defaults.providers),
    appearance: normalizeAppearanceSettings(obj.appearance, defaults.appearance),
    pet: normalizePetSettings(obj.pet, defaults.pet),
    notifications: normalizeNotificationPreferences(obj.notifications, defaults.notifications),
    general: normalizeGeneralPreferences(obj.general, defaults.general),
    session: normalizeSessionPreferences(obj.session, defaults.session),
    statusBar: normalizeStatusBarPreferences(obj.statusBar, defaults.statusBar),
    update: normalizeUpdatePreferences(obj.update, defaults.update),
  };
}

function normalizeUpdatePreferences(value: unknown, fallback: UpdatePreferences): UpdatePreferences {
  const obj = isRecord(value) ? value : {};
  return { autoCheck: typeof obj.autoCheck === 'boolean' ? obj.autoCheck : fallback.autoCheck };
}

function normalizeAppearanceSettings(value: unknown, fallback: AppearanceSettings): AppearanceSettings {
  const obj = isRecord(value) ? value : {};
  const rawTheme = obj.theme;
  const theme: AppearanceSettings['theme'] = typeof rawTheme === 'string' && BUILTIN_THEMES.some((entry) => entry.id === rawTheme)
    ? (rawTheme as AppearanceSettings['theme'])
    : fallback.theme;
  const colorMode = obj.colorMode === 'light' || obj.colorMode === 'dark' || obj.colorMode === 'system'
    ? obj.colorMode
    : fallback.colorMode;
  const motion = obj.motion === 'reduce' || obj.motion === 'system' ? obj.motion : fallback.motion;
  const zoom = typeof obj.zoom === 'number' && APPEARANCE_ZOOM_OPTIONS.some((option) => option.value === obj.zoom)
    ? obj.zoom
    : fallback.zoom;
  return { theme, colorMode, motion, zoom };
}

function normalizeGeneralPreferences(value: unknown, fallback: GeneralPreferences): GeneralPreferences {
  const obj = isRecord(value) ? value : {};
  return {
    startupPage: obj.startupPage === 'session' ? 'session' : fallback.startupPage,
    confirmQuit: typeof obj.confirmQuit === 'boolean' ? obj.confirmQuit : fallback.confirmQuit,
  };
}

function normalizeOptionalPreferenceString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  return value;
}

function normalizeSessionPreferences(value: unknown, fallback: SessionPreferences): SessionPreferences {
  const obj = isRecord(value) ? value : {};
  return {
    defaultModel: obj.defaultModel === 'specified' ? 'specified' : fallback.defaultModel,
    model: obj.model === undefined ? fallback.model : normalizeOptionalPreferenceString(obj.model),
    effort: obj.effort === undefined ? fallback.effort : normalizeOptionalPreferenceString(obj.effort),
    lastSentModel: obj.lastSentModel === undefined
      ? fallback.lastSentModel
      : normalizeOptionalPreferenceString(obj.lastSentModel),
    lastSentEffort: obj.lastSentEffort === undefined
      ? fallback.lastSentEffort
      : normalizeOptionalPreferenceString(obj.lastSentEffort),
    sendKey: obj.sendKey === 'mod-enter' ? 'mod-enter' : fallback.sendKey,
  };
}

function normalizeStatusBarPreferences(value: unknown, fallback: StatusBarPreferences): StatusBarPreferences {
  const obj = isRecord(value) ? value : {};
  const raw = Array.isArray(obj.hidden) ? obj.hidden : undefined;
  if (!raw) return { hidden: [...fallback.hidden] };
  const hidden = raw.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 512);
  return { hidden: [...new Set(hidden)] };
}

function normalizeWindowSettings(value: unknown): WindowSettings {
  const obj = isRecord(value) ? value : {};
  const result: WindowSettings = {};
  const shell = normalizeGeometry(obj.shell);
  if (shell) result.shell = shell;
  const graphSlip = normalizeGeometry(obj.graphSlip);
  if (graphSlip) result.graphSlip = graphSlip;
  return result;
}

function normalizeGeometry(value: unknown): WindowGeometry | undefined {
  if (!isRecord(value)) return undefined;
  const result: WindowGeometry = {};
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) result[key] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTraySettings(value: unknown): TraySettings {
  const obj = isRecord(value) ? value : {};
  const result: TraySettings = {};
  if (typeof obj.showQuota === 'boolean') result.showQuota = obj.showQuota;
  return result;
}

function normalizeProviderDisplaySettings(value: unknown, fallback: ProviderDisplaySettings): ProviderDisplaySettings {
  const obj = isRecord(value) ? value : {};
  const raw = Array.isArray(obj.providers) ? obj.providers : undefined;
  if (!raw) return { providers: fallback.providers.map((entry) => ({ ...entry })) };
  const providers: QuotaProviderEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    providers.push({ id, enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true });
  }
  return {
    providers: providers.length > 0 ? providers : fallback.providers.map((entry) => ({ ...entry })),
  };
}

function normalizePetSettings(value: unknown, fallback: PetSettings): PetSettings {
  const obj = isRecord(value) ? value : {};
  const entities = isRecord(obj.entities) ? obj.entities : {};
  const appearance = isRecord(obj.appearance) ? obj.appearance : {};
  const skin = appearance.houseSkin;
  const layout = isRecord(obj.layout) ? obj.layout : {};
  const result: PetSettings = {
    visible: typeof obj.visible === 'boolean' ? obj.visible : fallback.visible,
    scale: rangeNumber(obj.scale, fallback.scale, 1, 6),
    bubbleSeconds: rangeNumber(obj.bubbleSeconds, fallback.bubbleSeconds, 1, 60),
    bottomOffset: rangeNumber(obj.bottomOffset, fallback.bottomOffset, 0, 512),
    entities: {
      house: typeof entities.house === 'boolean' ? entities.house : fallback.entities.house,
      workers: typeof entities.workers === 'boolean' ? entities.workers : fallback.entities.workers,
      taskgraphs: typeof entities.taskgraphs === 'boolean' ? entities.taskgraphs : fallback.entities.taskgraphs,
    },
    appearance: { houseSkin: skin === 'classic' || skin === 'mushroom' ? skin : fallback.appearance.houseSkin },
  };
  const displayId = optionalInteger(obj.displayId);
  if (displayId !== undefined) result.displayId = displayId;
  const entityX = optionalFinite(obj.layout && layout.entityX);
  const entityY = optionalFinite(layout.entityY);
  if (entityX !== undefined || entityY !== undefined) {
    result.layout = { ...(entityX !== undefined ? { entityX } : {}), ...(entityY !== undefined ? { entityY } : {}) };
  }
  return result;
}

function normalizeNotificationPreferences(
  value: unknown,
  fallback: NotificationPreferences,
): NotificationPreferences {
  const obj = isRecord(value) ? value : {};
  const events = isRecord(obj.events) ? obj.events : {};
  const bool = (raw: unknown, fallbackValue: boolean): boolean =>
    typeof raw === 'boolean' ? raw : fallbackValue;
  return {
    system: bool(obj.system, fallback.system),
    sound: bool(obj.sound, fallback.sound),
    doNotDisturb: bool(obj.doNotDisturb, fallback.doNotDisturb),
    events: {
      taskCompleted: bool(events.taskCompleted, fallback.events.taskCompleted),
      taskFailed: bool(events.taskFailed, fallback.events.taskFailed),
      sessionReplyCompleted: bool(events.sessionReplyCompleted, fallback.events.sessionReplyCompleted),
      quotaWarning: bool(events.quotaWarning, fallback.events.quotaWarning),
      updateAvailable: bool(events.updateAvailable, fallback.events.updateAvailable),
      daemonDisconnected: bool(events.daemonDisconnected, fallback.events.daemonDisconnected),
    },
  };
}

function rangeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return undefined;
  return value;
}

function optionalFinite(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSettings(settings: DesktopSettings): DesktopSettings {
  return {
    version: DESKTOP_SETTINGS_VERSION,
    window: { ...settings.window },
    tray: { ...settings.tray },
    providers: { providers: settings.providers.providers.map((entry) => ({ ...entry })) },
    appearance: { ...settings.appearance },
    pet: {
      ...settings.pet,
      entities: { ...settings.pet.entities },
      appearance: { ...settings.pet.appearance },
      ...(settings.pet.layout ? { layout: { ...settings.pet.layout } } : {}),
    },
    notifications: {
      ...settings.notifications,
      events: { ...settings.notifications.events },
    },
    general: { ...settings.general },
    session: { ...settings.session },
    statusBar: { hidden: [...settings.statusBar.hidden] },
    update: { ...settings.update },
  };
}

/**
 * Returns the version 3 document produced by applying one validated preference
 * mutation. Unknown ids and illegal values are rejected so the single store is
 * only ever written through the shared shell-contract schema.
 */
export function applyPreference(
  settings: DesktopSettings,
  id: PreferenceId,
  value: unknown,
): DesktopSettings {
  if (!validatePreferenceValue(id, value)) {
    throw new Error(`偏好值无效：${id}`);
  }
  const next = cloneSettings(settings);
  switch (id) {
    case 'general.startupPage':
      next.general.startupPage = value as GeneralPreferences['startupPage'];
      break;
    case 'general.confirmQuit':
      next.general.confirmQuit = value as boolean;
      break;
    case 'appearance.theme':
      next.appearance.theme = value as AppearanceSettings['theme'];
      break;
    case 'appearance.colorMode':
      next.appearance.colorMode = value as AppearanceSettings['colorMode'];
      break;
    case 'appearance.motion':
      next.appearance.motion = value as AppearanceSettings['motion'];
      break;
    case 'appearance.zoom':
      next.appearance.zoom = value as number;
      break;
    case 'session.defaultModel':
      next.session.defaultModel = value as SessionPreferences['defaultModel'];
      break;
    case 'session.model':
      next.session.model = value as string | null;
      break;
    case 'session.effort':
      next.session.effort = value as string | null;
      break;
    case 'session.lastSentModel':
      next.session.lastSentModel = value as string | null;
      break;
    case 'session.lastSentEffort':
      next.session.lastSentEffort = value as string | null;
      break;
    case 'session.sendKey':
      next.session.sendKey = value as SessionPreferences['sendKey'];
      break;
    case 'notifications.system':
      next.notifications.system = value as boolean;
      break;
    case 'notifications.sound':
      next.notifications.sound = value as boolean;
      break;
    case 'notifications.doNotDisturb':
      next.notifications.doNotDisturb = value as boolean;
      break;
    case 'statusBar.hidden':
      next.statusBar.hidden = [...(value as string[])];
      break;
    case 'update.autoCheck':
      next.update.autoCheck = value as boolean;
      break;
    default: {
      const event = notificationEventKey(id);
      if (event === null) throw new Error(`未知偏好：${id}`);
      next.notifications.events[event] = value as boolean;
    }
  }
  return next;
}

function notificationEventKey(id: PreferenceId): keyof NotificationEventPreferences | null {
  for (const event of NOTIFICATION_EVENT_IDS) {
    if (id === `notifications.events.${event}`) return event;
  }
  return null;
}

/**
 * Bridge between the v2 Desktop document and the Pet module's runtime config.
 * The Pet partition keeps the module's public `AppConfig` shape so runtime
 * code is unchanged, but the persisted document owns visibility under
 * `pet.visible` (never the legacy `enabled`).
 */
export function petSettingsFromConfig(config: AppConfig): PetSettings {
  const normalized = normalizeConfig(config);
  const result: PetSettings = {
    visible: normalized.enabled,
    scale: normalized.scale,
    bubbleSeconds: normalized.bubbleSeconds,
    bottomOffset: normalized.bottomOffset,
    entities: { ...normalized.entities },
    appearance: { ...normalized.appearance },
  };
  if (normalized.house.displayId !== undefined) result.displayId = normalized.house.displayId;
  if (normalized.house.entityX !== undefined || normalized.house.entityY !== undefined) {
    result.layout = {
      ...(normalized.house.entityX !== undefined ? { entityX: normalized.house.entityX } : {}),
      ...(normalized.house.entityY !== undefined ? { entityY: normalized.house.entityY } : {}),
    };
  }
  return result;
}

/**
 * Runtime view of the Pet partition, matching the Pet module's `AppConfig`.
 * The shared TaskGraph detail window geometry is owned by the Desktop `window`
 * partition, so it is injected here rather than persisted inside the Pet
 * partition.
 */
export function configFromPetSettings(
  pet: PetSettings,
  providers: QuotaProviderEntry[],
  graphSlip?: WindowGeometry,
): AppConfig {
  const graphSlipGeometry = graphSlip
    ? { ...(graphSlip.x !== undefined ? { x: graphSlip.x } : {}), ...(graphSlip.y !== undefined ? { y: graphSlip.y } : {}), ...(graphSlip.width !== undefined ? { width: graphSlip.width } : {}), ...(graphSlip.height !== undefined ? { height: graphSlip.height } : {}) }
    : undefined;
  return normalizeConfig({
    enabled: pet.visible,
    scale: pet.scale,
    bubbleSeconds: pet.bubbleSeconds,
    bottomOffset: pet.bottomOffset,
    house: {
      ...(pet.displayId !== undefined ? { displayId: pet.displayId } : {}),
      ...(pet.layout?.entityX !== undefined ? { entityX: pet.layout.entityX } : {}),
      ...(pet.layout?.entityY !== undefined ? { entityY: pet.layout.entityY } : {}),
    },
    entities: { ...pet.entities },
    appearance: { ...pet.appearance },
    quota: { providers: providers.map((entry) => ({ ...entry })) },
    windows: graphSlipGeometry ? { graphSlip: graphSlipGeometry } : {},
  });
}
