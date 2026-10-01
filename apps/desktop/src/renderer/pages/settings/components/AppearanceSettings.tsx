import { useState } from 'react';
import { Card, CardContent, CardDescription } from '@/renderer/components/ui/card';
import { Label } from '@/renderer/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { THEMES, applyTheme, readTheme, type ThemeId } from '@/renderer/lib/theme';
import { APPEARANCE_DESCRIPTION } from '../model/describe.js';

function isThemeId(value: string): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

/**
 * Theme picker. A theme change persists immediately and independently of every
 * other settings draft, so it is the only control that never needs a save step.
 */
export function AppearanceSettings() {
  const [theme, setTheme] = useState<ThemeId>(() => readTheme());

  const change = (value: string | null): void => {
    if (value === null || !isThemeId(value)) return;
    setTheme(value);
    applyTheme(value);
  };

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="appearance-theme">主题</Label>
          <CardDescription>{APPEARANCE_DESCRIPTION}</CardDescription>
        </div>
        <Select value={theme} onValueChange={change}>
          <SelectTrigger id="appearance-theme" aria-label="主题">
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
      </CardContent>
    </Card>
  );
}
