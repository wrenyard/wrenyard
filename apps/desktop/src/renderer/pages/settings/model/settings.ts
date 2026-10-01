import type { StatusTone } from '@/renderer/components/status-badge';
import type {
  DaemonLifecycleSnapshot,
  DaemonProcessState,
  DesktopPreferences,
  NotificationEventPreferences,
  PetCompanionSettings,
  PetCompanionSnapshot,
  PreferenceId,
  ServiceSnapshot,
  SettingsSnapshot,
  WorkspaceConfigurationSnapshot,
} from '@/shell-contract';

/**
 * Pure model for the Settings page. Every helper here is framework-free: no
 * React, no DOM and no window access. The UI components translate the neutral
 * results into product copy (see `describe.ts`) and render them.
 */

/** Error text with the Electron IPC invocation prefix stripped. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }
  return String(error);
}

/* ------------------------------------------------------------------ */
/* Local service                                                       */
/* ------------------------------------------------------------------ */

export function formatServiceDuration(uptimeMs: number | undefined): string {
  if (uptimeMs === undefined) return '已连接';
  const totalMinutes = Math.max(0, Math.floor(uptimeMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `已连接 · 已运行 ${days} 天 ${hours} 小时`;
  if (hours > 0) return `已连接 · 已运行 ${hours} 小时 ${minutes} 分钟`;
  return `已连接 · 已运行 ${minutes} 分钟`;
}

/** Human description of the local service row. */
export function serviceDescription(service: Pick<ServiceSnapshot, 'status' | 'uptimeMs'>): string {
  return service.status === 'connected'
    ? formatServiceDuration(service.uptimeMs)
    : '未能连接本地 Wrenyard 服务';
}

export function serviceTone(status: ServiceSnapshot['status']): StatusTone {
  return status === 'connected' ? 'success' : 'danger';
}

/* ------------------------------------------------------------------ */
/* Daemon lifecycle                                                    */
/* ------------------------------------------------------------------ */

export type DaemonLifecycleAction = 'start' | 'restart';

export function daemonStateTone(state: DaemonProcessState): StatusTone {
  if (state === 'running') return 'success';
  if (state === 'starting') return 'running';
  return 'danger';
}

/**
 * Human reason shown under the daemon row. The snapshot `message` is
 * authoritative when present; otherwise a state/mode-specific fallback keeps
 * the stopped/crash/lost-connection cause visible.
 */
export function daemonLifecycleDescription(snapshot: DaemonLifecycleSnapshot): string {
  const message = snapshot.message?.trim();
  if (message) return message;
  switch (snapshot.state) {
    case 'running':
      return snapshot.mode === 'supervised'
        ? `本地 Daemon 运行中${snapshot.pid ? `（进程 ${snapshot.pid}）` : ''}。`
        : '已连接到外部启动的本地 Daemon。';
    case 'starting':
      return '本地 Daemon 正在启动…';
    case 'stopped':
      return snapshot.mode === 'supervised'
        ? '本地 Daemon 已停止，可由啾啾工坊重新启动。'
        : '本地 Daemon 已停止，需从外部重新启动。';
    case 'failed':
      return '本地 Daemon 启动失败。';
    default:
      return '未能连接本地 Daemon。';
  }
}

/**
 * Which launch action the snapshot admits, or null when no launch is allowed.
 * `canStart` is the authoritative gate: a source-supervised Desktop reports
 * `false` and must never offer a start/restart button.
 */
export function daemonLifecycleAction(snapshot: DaemonLifecycleSnapshot): DaemonLifecycleAction | null {
  if (!snapshot.canStart) return null;
  if (snapshot.state === 'stopped' || snapshot.state === 'failed') {
    return snapshot.mode === 'supervised' ? 'restart' : 'start';
  }
  if (snapshot.state === 'unavailable') return 'start';
  return null;
}

/** A launch button is offered while the daemon is starting or has a valid action. */
export function daemonActionVisible(snapshot: DaemonLifecycleSnapshot): boolean {
  return daemonLifecycleAction(snapshot) !== null || (snapshot.state === 'starting' && snapshot.canStart);
}

export function daemonActionPending(snapshot: DaemonLifecycleSnapshot, inFlight: boolean): boolean {
  return inFlight || (snapshot.state === 'starting' && snapshot.canStart);
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

export interface WorkspaceDraft {
  path: string;
  /** `create` maps to `saveWorkspace(path, true)`: initialize an empty dir. */
  create: boolean;
}

export const WORKSPACE_MODE_OPTIONS = [
  { value: 'existing', label: '选择已有 workspace' },
  { value: 'create', label: '新建 workspace' },
] as const;

export function isWorkspaceReadOnly(workspace: WorkspaceConfigurationSnapshot): boolean {
  return workspace.source === 'environment';
}

export function workspaceDraftFromSnapshot(workspace: WorkspaceConfigurationSnapshot): WorkspaceDraft {
  return { path: workspace.path ?? '', create: false };
}

/** Note under the workspace input; explains the binding source and its owner. */
export function workspaceNote(workspace: WorkspaceConfigurationSnapshot): string {
  if (isWorkspaceReadOnly(workspace)) {
    return '由环境变量 WRENYARD_DESKTOP_WORKSPACE 提供；路径只读，如需修改请调整启动环境。';
  }
  if (workspace.status === 'configured') {
    return `已绑定 · 配置写入 ${workspace.configPath}`;
  }
  return workspace.message ?? `尚未配置 · 将写入 ${workspace.configPath}`;
}

/** Hint shown while choosing how to bind the configured workspace. */
export function workspaceModeHint(create: boolean): string {
  return create
    ? '新建模式会初始化一个空的 workspace 目录，已有内容的目录请改用「选择已有 workspace」。'
    : '选择模式只会绑定已存在的 workspace 目录。';
}

/* ------------------------------------------------------------------ */
/* Global auto output cap                                              */
/* ------------------------------------------------------------------ */

/** Input text for a persisted global auto cap: the number verbatim (0 stays), unset → empty. */
export function autoCapDisplayValue(value: number | null | undefined): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

export type AutoCapParseResult =
  | { ok: true; value: number | null }
  | { ok: false; reason: 'not-number' | 'negative' };

/** Parse the raw cap input; empty clears with `null`, zero is preserved. */
export function parseAutoCapInput(raw: string): AutoCapParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, reason: 'not-number' };
  if (parsed < 0) return { ok: false, reason: 'negative' };
  return { ok: true, value: parsed };
}

/* ------------------------------------------------------------------ */
/* Runtime aliases                                                     */
/* ------------------------------------------------------------------ */

export const ALIAS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ALIAS_TARGET_MAX_LENGTH = 512;

export type AliasValidationReason = 'invalid-name' | 'empty-target' | 'long-target';

/** Validates the alias name and target; `null` means acceptable. */
export function validateAlias(name: string, target: string): AliasValidationReason | null {
  if (!ALIAS_NAME_PATTERN.test(name)) return 'invalid-name';
  if (target.length === 0) return 'empty-target';
  if (target.length > ALIAS_TARGET_MAX_LENGTH) return 'long-target';
  return null;
}

/* ------------------------------------------------------------------ */
/* Pet companion                                                       */
/* ------------------------------------------------------------------ */

export const PET_SCALE_MIN = 1;
export const PET_SCALE_MAX = 6;
export const PET_BOTTOM_OFFSET_MIN = 0;
export const PET_BOTTOM_OFFSET_MAX = 512;
export const PET_BUBBLE_SECONDS_MIN = 1;
export const PET_BUBBLE_SECONDS_MAX = 60;

export const PET_HOUSE_SKINS = [
  { value: 'classic', label: '经典木屋' },
  { value: 'mushroom', label: '蘑菇小屋' },
] as const;

/** The full editable Pet payload, cloned so a draft never aliases a snapshot. */
export type PetDraft = PetCompanionSettings;

/** Clones the pet settings into an editable draft, defaulting the display. */
export function petDraftFromSnapshot(pet: PetCompanionSnapshot): PetDraft {
  const draft = structuredClone(pet.settings);
  const fallbackDisplay = pet.displays.find((item) => item.isPrimary)?.id ?? pet.displays[0]?.id;
  if (draft.displayId === undefined && fallbackDisplay !== undefined) draft.displayId = fallbackDisplay;
  return draft;
}

/** Clamps an edited numeric field into the persisted range. */
export function clampPetNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/* ------------------------------------------------------------------ */
/* About                                                               */
/* ------------------------------------------------------------------ */

/** Local build-time label, delegating to the one canonical generic formatter. */
export { formatBuildTime } from '@/renderer/lib/format';

export type AboutSnapshot = SettingsSnapshot['about'];

/* ------------------------------------------------------------------ */
/* Desktop preference bindings                                         */
/* ------------------------------------------------------------------ */

function notificationEventKey(id: PreferenceId): keyof NotificationEventPreferences | null {
  if (!id.startsWith('notifications.events.')) return null;
  return id.slice('notifications.events.'.length) as keyof NotificationEventPreferences;
}

/** Reads one preference value out of the version 3 snapshot. */
export function readPreference(preferences: DesktopPreferences, id: PreferenceId): unknown {
  switch (id) {
    case 'general.startupPage':
      return preferences.general.startupPage;
    case 'general.confirmQuit':
      return preferences.general.confirmQuit;
    case 'general.openAtLogin':
      return preferences.general.openAtLogin;
    case 'general.menuBarQuota':
      return preferences.general.menuBarQuota;
    case 'appearance.theme':
      return preferences.appearance.theme;
    case 'appearance.colorMode':
      return preferences.appearance.colorMode;
    case 'appearance.motion':
      return preferences.appearance.motion;
    case 'appearance.zoom':
      return preferences.appearance.zoom;
    case 'session.defaultModel':
      return preferences.session.defaultModel;
    case 'session.model':
      return preferences.session.model;
    case 'session.effort':
      return preferences.session.effort;
    case 'session.lastSentModel':
      return preferences.session.lastSentModel;
    case 'session.lastSentEffort':
      return preferences.session.lastSentEffort;
    case 'session.sendKey':
      return preferences.session.sendKey;
    case 'notifications.system':
      return preferences.notifications.system;
    case 'notifications.sound':
      return preferences.notifications.sound;
    case 'notifications.doNotDisturb':
      return preferences.notifications.doNotDisturb;
    case 'statusBar.hidden':
      return preferences.statusBar.hidden;
    case 'update.autoCheck':
      return preferences.update.autoCheck;
    default: {
      const key = notificationEventKey(id);
      return key === null ? undefined : preferences.notifications.events[key];
    }
  }
}

/**
 * Renderer-side optimistic update for one preference, mirroring the main
 * process `applyPreference` so an immediate-save control does not lag behind
 * its input. The authoritative snapshot still replaces this on success.
 */
export function applyLocalPreference(
  preferences: DesktopPreferences,
  id: PreferenceId,
  value: unknown,
): DesktopPreferences {
  const next: DesktopPreferences = {
    general: { ...preferences.general },
    appearance: { ...preferences.appearance },
    session: { ...preferences.session },
    notifications: { ...preferences.notifications, events: { ...preferences.notifications.events } },
    statusBar: { hidden: [...preferences.statusBar.hidden] },
    update: { ...preferences.update },
  };
  switch (id) {
    case 'general.startupPage':
      next.general.startupPage = value as DesktopPreferences['general']['startupPage'];
      break;
    case 'general.confirmQuit':
      next.general.confirmQuit = value as boolean;
      break;
    case 'general.openAtLogin':
      next.general.openAtLogin = value as boolean;
      break;
    case 'general.menuBarQuota':
      next.general.menuBarQuota = value as boolean;
      break;
    case 'appearance.theme':
      next.appearance.theme = value as DesktopPreferences['appearance']['theme'];
      break;
    case 'appearance.colorMode':
      next.appearance.colorMode = value as DesktopPreferences['appearance']['colorMode'];
      break;
    case 'appearance.motion':
      next.appearance.motion = value as DesktopPreferences['appearance']['motion'];
      break;
    case 'appearance.zoom':
      next.appearance.zoom = value as number;
      break;
    case 'session.defaultModel':
      next.session.defaultModel = value as DesktopPreferences['session']['defaultModel'];
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
      next.session.sendKey = value as DesktopPreferences['session']['sendKey'];
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
      const key = notificationEventKey(id);
      if (key !== null) next.notifications.events[key] = value as boolean;
    }
  }
  return next;
}

/**
 * Structural equality for preference values. Composite preferences (the hidden
 * status-bar id list, notification event flags) are fresh objects on every
 * snapshot, so reference inequality would mark every such row as modified.
 */
export function preferenceValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => preferenceValuesEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => preferenceValuesEqual(left[key], right[key]));
  }
  return false;
}
