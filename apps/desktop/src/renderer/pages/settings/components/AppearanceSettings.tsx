import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription } from '@/renderer/components/ui/card';
import { Label } from '@/renderer/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import {
  THEMES,
  isThemeId,
  useAppearance,
  type AppearanceSettings as AppearancePreferences,
  type ColorMode,
} from '@/renderer/lib/theme';
import { shell } from '@/renderer/lib/desktop';
import {
  APPEARANCE_COLOR_MODE_LABEL,
  APPEARANCE_COLOR_MODE_OPTIONS,
  APPEARANCE_DESCRIPTION,
  APPEARANCE_THEME_LABEL,
} from '../model/describe.js';

/**
 * Theme and color-mode picker. Both preferences live in the main process, so a
 * change is persisted and broadcast; the local state only mirrors the save.
 */
export function AppearanceSettings() {
  const appearance = useAppearance();
  const [settings, setSettings] = useState<AppearancePreferences | null>(null);

  useEffect(() => {
    let active = true;
    void shell.getAppearanceSettings()
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const theme = settings?.theme ?? appearance.theme;
  const colorMode = settings?.colorMode ?? 'system';

  const update = (patch: Partial<AppearancePreferences>): void => {
    void shell.setAppearance(patch).then(setSettings).catch(() => undefined);
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="appearance-theme">{APPEARANCE_THEME_LABEL}</Label>
            <CardDescription>{APPEARANCE_DESCRIPTION}</CardDescription>
          </div>
          <Select
            value={theme}
            onValueChange={(value: string | null) => {
              if (value !== null && isThemeId(value)) update({ theme: value });
            }}
          >
            <SelectTrigger id="appearance-theme" aria-label={APPEARANCE_THEME_LABEL}>
              <SelectValue>
                {(value) => THEMES.find((item) => item.id === value)?.label ?? value}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {THEMES.map((item) => (
                <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="appearance-color-mode">{APPEARANCE_COLOR_MODE_LABEL}</Label>
          <Select
            value={colorMode}
            onValueChange={(value: string | null) => {
              if (value !== null) update({ colorMode: value as ColorMode });
            }}
          >
            <SelectTrigger id="appearance-color-mode" aria-label={APPEARANCE_COLOR_MODE_LABEL}>
              <SelectValue>
                {(value) => APPEARANCE_COLOR_MODE_OPTIONS.find((item) => item.value === value)?.label ?? value}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {APPEARANCE_COLOR_MODE_OPTIONS.map((item) => (
                <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
