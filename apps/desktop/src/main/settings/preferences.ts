import type { AppearanceSettings, DesktopPreferences, PreferenceId } from '../../shell-contract.js';
import { isPreferenceId, validatePreferenceValue } from '../../shell-contract.js';
import type { DesktopSettings, DesktopSettingsStore } from './desktop-settings.js';
import { applyPreference } from './desktop-settings.js';

/** The Desktop settings partition a preference id belongs to. */
type PreferencePartition = 'general' | 'appearance' | 'session' | 'notifications' | 'statusBar' | 'update';

function preferencePartition(id: PreferenceId): PreferencePartition {
  if (id.startsWith('general.')) return 'general';
  if (id.startsWith('appearance.')) return 'appearance';
  if (id.startsWith('session.')) return 'session';
  if (id.startsWith('statusBar.')) return 'statusBar';
  if (id.startsWith('update.')) return 'update';
  return 'notifications';
}

/** Appearance ids whose write must go through the appearance controller. */
function isAppearanceResolvedId(id: PreferenceId): boolean {
  return id === 'appearance.theme' || id === 'appearance.colorMode' || id === 'appearance.motion';
}

function appearancePatch(id: PreferenceId, value: unknown): Partial<AppearanceSettings> {
  switch (id) {
    case 'appearance.theme':
      return { theme: value as AppearanceSettings['theme'] };
    case 'appearance.colorMode':
      return { colorMode: value as AppearanceSettings['colorMode'] };
    case 'appearance.motion':
      return { motion: value as AppearanceSettings['motion'] };
    default:
      return {};
  }
}

export function preferencesFromDocument(settings: DesktopSettings): DesktopPreferences {
  return {
    general: { ...settings.general },
    appearance: { ...settings.appearance },
    session: { ...settings.session },
    notifications: {
      ...settings.notifications,
      events: { ...settings.notifications.events },
    },
    statusBar: { hidden: [...settings.statusBar.hidden] },
    update: { ...settings.update },
  };
}

export interface DesktopPreferencesControllerOptions {
  store: DesktopSettingsStore;
  /**
   * Appearance theme/colorMode/motion are owned by the appearance controller,
   * which also re-resolves nativeTheme and pushes `appearanceChanged`; the
   * preference bridge delegates those three ids rather than double-writing.
   */
  saveAppearance?: (patch: Partial<AppearanceSettings>) => void;
  /** Mirrors the do-not-disturb write into the notification center. */
  onDoNotDisturb?: (value: boolean) => void;
}

/**
 * The single main-process writer for the version 3 preference partitions.
 * Every mutation is validated against the shared shell-contract schema before
 * the store is touched, so an illegal value can never be persisted.
 */
export class DesktopPreferencesController {
  constructor(private readonly options: DesktopPreferencesControllerOptions) {}

  get(): DesktopPreferences {
    return preferencesFromDocument(this.options.store.load());
  }

  set(id: string, value: unknown): DesktopPreferences {
    if (!isPreferenceId(id)) throw new Error('未知偏好');
    if (!validatePreferenceValue(id, value)) throw new Error(`偏好值无效：${id}`);
    if (isAppearanceResolvedId(id)) {
      this.options.saveAppearance?.(appearancePatch(id, value));
      return this.get();
    }
    const next = applyPreference(this.options.store.load(), id, value);
    this.options.store.patch(preferencePartition(id), next[preferencePartition(id)]);
    if (id === 'notifications.doNotDisturb') {
      this.options.onDoNotDisturb?.(value as boolean);
    }
    return this.get();
  }
}
