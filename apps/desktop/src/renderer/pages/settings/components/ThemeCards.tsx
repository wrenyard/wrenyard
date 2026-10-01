import { useQuery } from '@tanstack/react-query';
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '@wrenyard/themes';
import { cn } from 'cn';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { preferencesQuery } from '@/renderer/lib/queries';
import { themeIconUrl } from '@/renderer/lib/theme';
import { usePreferenceMutation } from '../queries.js';

/**
 * A theme preview drawn with the theme's own tokens. `data-theme` on each half
 * scopes the token variables locally, and the right half adds `dark`; Desktop
 * never hardcodes a per-theme color table.
 */
function ThemeThumbnail({ themeId }: { themeId: string }) {
  const half = (dark: boolean) => (
    <div
      data-theme={themeId}
      className={cn('relative h-full w-1/2 overflow-hidden bg-background', dark && 'dark')}
    >
      <div className="absolute inset-y-0 left-0 w-3 border-r border-border bg-sidebar" />
      <div className="absolute inset-x-0 top-0 h-2 border-b border-border bg-card" />
      <div className="absolute left-4 top-3 h-2 w-8 rounded-full bg-muted" />
      <div className="absolute right-1.5 top-7 h-2 w-8 rounded-full bg-primary" />
      <div className="absolute bottom-2 left-1.5 h-1.5 w-10 rounded-full bg-muted-foreground/40" />
    </div>
  );
  return (
    <div className="flex h-[72px] w-[120px] overflow-hidden rounded-md border border-border">
      {half(false)}
      {half(true)}
    </div>
  );
}

/** Registry-driven theme picker: one 120×72 thumbnail per builtin theme. */
export function ThemeCardsControl() {
  const preferences = useQuery(preferencesQuery);
  const current = preferences.data?.appearance.theme ?? DEFAULT_THEME_ID;
  // Writes through the shared preference path so the theme card gets the same
  // optimistic update, error notification and rollback as every other setting.
  const save = usePreferenceMutation();

  return (
    <ToggleGroup
      variant="outline"
      value={[current]}
      onValueChange={(next) => {
        const chosen = next[0];
        if (chosen !== undefined && chosen !== current) save.mutate({ id: 'appearance.theme', value: chosen });
      }}
    >
      {BUILTIN_THEMES.map((theme) => (
        <ToggleGroupItem key={theme.id} value={theme.id} className="h-auto flex-col gap-1.5 p-1.5">
          <ThemeThumbnail themeId={theme.id} />
          <span className="flex items-center gap-1.5 text-xs">
            <img src={themeIconUrl(theme.id)} alt="" className="size-3.5 rounded-sm" />
            {theme.label}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
