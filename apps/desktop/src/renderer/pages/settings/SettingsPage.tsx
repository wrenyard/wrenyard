import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Braces, RefreshCw } from 'lucide-react';
import { Page, PageActions, PageHeader, PageTitle } from '@/renderer/components/page';
import { SourceDevelopmentBadge } from '@/renderer/components/source-development-badge';
import { Button } from '@/renderer/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Sidebar, SidebarContent, SidebarProvider } from '@/renderer/components/ui/sidebar';
import { notify } from '@/renderer/lib/notify';
import { useNavLocation, useSecondarySidebar } from '@/renderer/lib/navigation';
import { shell } from '@/renderer/lib/desktop';
import { preferencesQueryKey } from '@/renderer/lib/queries';
import type { DesktopPreferences, PreferenceId } from '@/shell-contract';
import { KNOWN_SHORTCUTS, knownShortcutKeys } from '@/shell-contract';
import { PetSettingsProvider, PetStatusBadge } from './components/PetSettings.js';
import { SettingRow, type SettingBinding } from './components/SettingRow.js';
import { SettingsSearch } from './components/SettingsSearch.js';
import { SettingsToc, type TocCategory } from './components/SettingsToc.js';
import { ShortcutsTable } from './components/ShortcutsTable.js';
import {
  OPEN_SETTINGS_FILE_LABEL,
  PAGE_TITLE,
  REFRESH_LABEL,
  SEARCH_EMPTY_DESCRIPTION,
  SEARCH_EMPTY_TITLE,
} from './model/describe.js';
import {
  SETTINGS_CATEGORIES,
  isSettingsCategoryId,
  settingsCategoryLabel,
  type SettingsCategoryId,
} from './model/categories.js';
import {
  SETTINGS_GROUP_LABELS,
  SETTINGS_REGISTRY,
  settingSearchFields,
  settingsForCategory,
  type SettingDefinition,
} from './model/registry.js';
import { parseSearchQuery, settingMatches, shortcutMatches, isEmptyQuery, type SearchQuery } from './model/search.js';
import { registerPageCommands } from '@/renderer/lib/commands';
import { applyLocalPreference, errorMessage, readPreference } from './model/settings.js';
import { SETTINGS_QUERY_KEYS, usePreferencesQuery } from './queries.js';

interface CategoryMatch {
  id: SettingsCategoryId;
  label: string;
  definitions: SettingDefinition[];
  groups: Array<{ key: string; label: string; definitions: SettingDefinition[] }>;
}

function isSettingIdMatch(query: SearchQuery, ...ids: string[]): boolean {
  return query.id !== null && ids.includes(query.id);
}

/**
 * The Settings Activity: a 220px secondary sidebar directory, a fixed search
 * row, and a scrolling list of setting rows. Reads come from the shared
 * Desktop preference and daemon queries; the page owns only the search, active
 * category and deep-link state.
 */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const platform = shell.platform;

  const [searchInput, setSearchInput] = useState('');
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [pendingScroll, setPendingScroll] = useState<
    { kind: 'category'; id: SettingsCategoryId } | { kind: 'setting'; id: string } | null
  >(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useSecondarySidebar({ open: sidebarOpen, setOpen: setSidebarOpen });

  const navState = useMemo<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    if (activeCategory !== null) next.category = activeCategory;
    return next;
  }, [activeCategory]);
  const restoreLocation = useCallback((state: Record<string, string>) => {
    const category = state.category;
    if (category !== undefined && isSettingsCategoryId(category)) {
      setSearchInput('');
      setPendingScroll({ kind: 'category', id: category });
      return true;
    }
    return false;
  }, []);
  useNavLocation(navState, restoreLocation);

  const query = useMemo(() => parseSearchQuery(searchInput), [searchInput]);

  const preferences = usePreferencesQuery();

  const savePreference = useMutation({
    mutationFn: (input: { id: PreferenceId; value: unknown }) => shell.setPreference(input.id, input.value),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: preferencesQueryKey });
      const previous = queryClient.getQueryData<DesktopPreferences>(preferencesQueryKey);
      if (previous) {
        queryClient.setQueryData(preferencesQueryKey, applyLocalPreference(previous, input.id, input.value));
      }
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(preferencesQueryKey, context.previous);
      notify({
        level: 'error',
        source: 'settings',
        title: '偏好保存失败',
        description: errorMessage(error),
      });
    },
    onSuccess: (next) => queryClient.setQueryData(preferencesQueryKey, next),
  });

  const preferenceBindings = useMemo(() => {
    const map = new Map<string, SettingBinding>();
    const data = preferences.data;
    if (data === undefined) return map;
    for (const definition of SETTINGS_REGISTRY) {
      if (definition.source.kind !== 'preference') continue;
      const id = definition.source.preference;
      const value = readPreference(data, id);
      map.set(definition.id, {
        value,
        modified: definition.default !== undefined && value !== definition.default,
        readonly: definition.readonly === true,
        pending: savePreference.isPending && savePreference.variables?.id === id,
        ...(savePreference.isError && savePreference.variables?.id === id
          ? { error: errorMessage(savePreference.error) }
          : {}),
        onChange: (next) => savePreference.mutate({ id, value: next }),
        ...(definition.default !== undefined
          ? { onReset: () => savePreference.mutate({ id, value: definition.default }) }
          : {}),
      });
    }
    return map;
  }, [preferences.data, savePreference.isPending, savePreference.isError, savePreference.variables, savePreference.error, savePreference]);

  const shortcutCount = useMemo(() => {
    return KNOWN_SHORTCUTS.filter((shortcut) => {
      const keys = knownShortcutKeys(shortcut, platform);
      if (keys === null) return false;
      return shortcutMatches({ title: shortcut.title, category: shortcut.category, scope: shortcut.scope, keys }, query);
    }).length;
  }, [platform, query]);

  const matches = useMemo(() => {
    const result: CategoryMatch[] = [];
    for (const category of SETTINGS_CATEGORIES) {
      const definitions = settingsForCategory(category.id).filter((definition) => {
        const binding = preferenceBindings.get(definition.id);
        return settingMatches(
          {
            ...settingSearchFields(definition),
            categoryLabel: category.label,
            modified: binding?.modified === true,
          },
          query,
        );
      });
      const groupLabels = SETTINGS_GROUP_LABELS[category.id] ?? [];
      const groups = groupLabels
        .map((group) => ({
          key: group.key,
          label: group.label,
          definitions: definitions.filter((definition) => definition.group === group.key),
        }))
        .filter((group) => group.definitions.length > 0);
      if (definitions.length > 0 || isSettingIdMatch(query, category.id)) {
        result.push({ id: category.id, label: category.label, definitions, groups });
      }
    }
    return result;
  }, [query, preferenceBindings]);

  const shortcutsVisible = shortcutCount > 0 || isSettingIdMatch(query, 'shortcuts');
  const totalResults = matches.reduce((sum, category) => sum + category.definitions.length, 0)
    + (shortcutsVisible ? shortcutCount : 0);
  const showEmpty = isEmptyQuery(query) ? false : totalResults === 0;

  const visibleKey = `${matches.map((category) => `${category.id}:${category.definitions.length}`).join(',')}|${shortcutsVisible ? shortcutCount : 0}`;

  const scrollTo = useCallback((selector: string, block: ScrollLogicalPosition) => {
    scrollRef.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block });
  }, []);

  // Apply a queued deep-link / history-restore scroll once the target renders.
  useEffect(() => {
    if (pendingScroll === null) return;
    const request = pendingScroll;
    setPendingScroll(null);
    if (request.kind === 'category') {
      setActiveCategory(request.id);
      scrollTo(`[data-category="${request.id}"]`, 'start');
      return;
    }
    setActiveCategory(null);
    setFlashId(request.id);
    requestAnimationFrame(() => {
      scrollTo(`#setting-${CSS.escape(request.id)}`, 'center');
    });
  }, [pendingScroll, scrollTo]);

  // Clear the deep-link flash after one pulse.
  useEffect(() => {
    if (flashId === null) return;
    const timer = window.setTimeout(() => setFlashId(null), 1_200);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  // Scroll-linked directory highlight: the topmost category in view wins.
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;
    const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-category]'));
    if (sections.length === 0) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-category');
          if (id === null) continue;
          if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top);
          else visible.delete(id);
        }
        const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
        if (top !== undefined && isSettingsCategoryId(top[0])) setActiveCategory(top[0]);
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [visibleKey]);

  // `settings.open` deep links land here after the command router navigates.
  useEffect(() => registerPageCommands('settings', [{
    id: 'settings.open',
    title: PAGE_TITLE,
    run: (args: unknown) => {
      const target = typeof args === 'string'
        ? args
        : args !== null && typeof args === 'object'
          ? (args as { target?: unknown; id?: unknown }).target ?? (args as { id?: unknown }).id
          : null;
      if (typeof target !== 'string') return;
      setSearchInput('');
      if (isSettingsCategoryId(target)) setPendingScroll({ kind: 'category', id: target });
      else if (SETTINGS_REGISTRY.some((definition) => definition.id === target)) {
        setPendingScroll({ kind: 'setting', id: target });
      }
    },
  }]), []);

  const refresh = (): void => {
    for (const queryKey of SETTINGS_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  const selectCategory = useCallback((id: SettingsCategoryId) => {
    setActiveCategory(id);
    scrollTo(`[data-category="${id}"]`, 'start');
  }, [scrollTo]);

  const selectGroup = useCallback((categoryId: SettingsCategoryId, group: string) => {
    setActiveCategory(categoryId);
    scrollTo(`[data-category="${categoryId}"] [data-group="${group}"]`, 'start');
  }, [scrollTo]);

  const tocCategories = useMemo<TocCategory[]>(() => {
    return matches.map((category) => ({
      id: category.id,
      label: category.label,
      count: category.definitions.length,
      groups: category.groups.map((group) => ({ key: group.key, label: group.label, count: group.definitions.length })),
    }));
  }, [matches]);

  const renderCategoryBody = (category: CategoryMatch): ReactNode => {
    if (category.groups.length > 0) {
      return category.groups.map((group) => (
        <div key={group.key} data-group={group.key} className="flex flex-col gap-2 scroll-mt-4">
          <h3 className="text-sm font-medium">{group.label}</h3>
          {group.definitions.map(renderRow)}
        </div>
      ));
    }
    return category.definitions.map(renderRow);
  };

  function renderRow(definition: SettingDefinition): ReactNode {
    return (
      <SettingRow
        key={definition.id}
        definition={definition}
        binding={preferenceBindings.get(definition.id)}
        highlightTerms={query.terms}
        flashed={flashId === definition.id}
      />
    );
  }

  return (
    <Page data-page="settings">
      <PageHeader>
        <PageTitle>{PAGE_TITLE}</PageTitle>
        <PageActions>
          <Button variant="outline" onClick={() => { void shell.openSettingsFile(); }}>
            <Braces />
            {OPEN_SETTINGS_FILE_LABEL}
          </Button>
          <Button variant="outline" onClick={refresh}>
            <RefreshCw />
            {REFRESH_LABEL}
          </Button>
        </PageActions>
      </PageHeader>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        className="min-h-0 flex-1"
        style={{ '--sidebar-width': '220px' } as CSSProperties}
      >
        <div className="flex min-h-0 w-full flex-1">
          {sidebarOpen && (
            <Sidebar collapsible="none" className="border-r">
              <SidebarContent>
                <SettingsToc
                  categories={tocCategories}
                  activeCategory={activeCategory}
                  activeGroup={null}
                  onSelectCategory={selectCategory}
                  onSelectGroup={selectGroup}
                />
              </SidebarContent>
            </Sidebar>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-4 py-3">
              <SettingsSearch value={searchInput} resultCount={totalResults} onChange={setSearchInput} />
            </div>
            <div ref={scrollRef} className="@container/main min-h-0 flex-1 overflow-auto">
              <div className="flex w-full max-w-3xl flex-col gap-6 p-4">
                <PetSettingsProvider>
                  {showEmpty ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{SEARCH_EMPTY_TITLE}</EmptyTitle>
                        <EmptyDescription>{SEARCH_EMPTY_DESCRIPTION}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <>
                      {matches.map((category) => (
                        <section
                          key={category.id}
                          data-category={category.id}
                          className="flex flex-col gap-3 scroll-mt-4"
                        >
                          <h2 className="flex items-center gap-3 text-lg font-medium">
                            {category.label}
                            {category.id === 'runtime' && <SourceDevelopmentBadge />}
                            {category.id === 'pet' && <PetStatusBadge />}
                          </h2>
                          {renderCategoryBody(category)}
                        </section>
                      ))}
                      {shortcutsVisible && !matches.some((category) => category.id === 'shortcuts') && (
                        <section data-category="shortcuts" className="flex flex-col gap-3 scroll-mt-4">
                          <h2 className="text-lg font-medium">{settingsCategoryLabel('shortcuts')}</h2>
                          <ShortcutsTable platform={platform} query={query} />
                        </section>
                      )}
                    </>
                  )}
                </PetSettingsProvider>
              </div>
            </div>
          </div>
        </div>
      </SidebarProvider>
    </Page>
  );
}
