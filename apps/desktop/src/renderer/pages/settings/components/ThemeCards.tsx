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
 * never hardcodes a per-theme color table. The thumbnail mirrors the M3 shell:
 * a recessed shell surface with the sidebar's pill nav (active pill in the
 * secondary container, FAB in the primary container) beside the floating
 * rounded inset workspace canvas carrying a user bubble and the composer
 * pill.
 */
function ThemeThumbnail({ themeId }: { themeId: string }) {
  const half = (dark: boolean) => (
    <div
      data-theme={themeId}
      className={cn('relative h-full w-1/2 overflow-hidden bg-surface-shell', dark && 'dark')}
    >
      {/* Mini sidebar on the shell surface: active pill + quiet rows + FAB. */}
      <div className="absolute inset-y-1.5 left-1.5 flex w-6 flex-col gap-1">
        <span className="h-2.5 rounded-full bg-secondary-container" />
        <span className="h-2.5 rounded-full bg-muted-foreground/15" />
        <span className="h-2.5 rounded-full bg-muted-foreground/15" />
        <span className="mt-auto h-2.5 rounded-full bg-primary-container" />
      </div>
      {/* Floating rounded inset workspace canvas over the shell. */}
      <div className="absolute inset-y-1.5 left-8 right-1.5 rounded-lg bg-background shadow-xs ring-1 ring-border/50">
        <span className="absolute left-1.5 top-1.5 h-1.5 w-10 rounded-full bg-muted-foreground/20" />
        <span className="absolute right-1 top-1 size-3 rounded-full bg-primary-container" />
        {/* Floating composer pill at the canvas bottom. */}
        <span className="absolute bottom-1 left-1/2 h-2.5 w-[78%] -translate-x-1/2 rounded-full bg-surface-container-low shadow-xs ring-1 ring-border/50" />
      </div>
    </div>
  );
  return (
    <div className="flex h-[72px] w-[120px] overflow-hidden rounded-lg border border-border/60">
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
        <ToggleGroupItem
          key={theme.id}
          value={theme.id}
          className="h-auto flex-col gap-1.5 rounded-2xl p-2 transition-all duration-fast data-[pressed]:border-primary/40 data-[pressed]:bg-secondary-container/70"
        >
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
