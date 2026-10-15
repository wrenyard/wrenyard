import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Braces, RefreshCw } from 'lucide-react';
import { Page, PageActions, PageHeader, PageTitle } from '@/renderer/components/page';
import { Button } from '@/renderer/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { QueryError } from '@/renderer/components/query-error';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/renderer/components/ui/sidebar';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { toast } from '@/renderer/lib/notify';
import { useNavLocation, useSecondarySidebar } from '@/renderer/lib/navigation';
import { shell } from '@/renderer/lib/desktop';
import { preferencesQueryKey } from '@/renderer/lib/queries';
import type { DesktopPreferences, PreferenceId, ProviderCatalogSnapshot } from '@/shell-contract';
import { KNOWN_SHORTCUTS, knownShortcutKeys } from '@/shell-contract';
import { PetSettingsProvider, PetStatusBadge } from './components/PetSettings.js';
import { SettingRow, type SettingBinding } from './components/SettingRow.js';
import { SettingsSearch } from './components/SettingsSearch.js';
import { SettingsToc, type TocCategory } from './components/SettingsToc.js';
import { ShortcutsTable } from './components/ShortcutsTable.js';
import { ModelList } from './supply/components/ModelList.js';
import { ProviderDialog } from './supply/components/ProviderDialog.js';
import { ProviderSupply } from './supply/components/ProviderSupply.js';
import { ProviderUsage } from './supply/components/ProviderUsage.js';
import { RoutingTest } from './supply/components/RoutingTest.js';
import { QUOTA_UNAVAILABLE_FALLBACK } from './supply/model/describe.js';
import { buildModelListRows } from './supply/model/models.js';
import { quotaQuery, useQuotaQuery, useQuotaRefresh, useSaveProviderOrder } from './supply/queries.js';
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
  settingsCategoryDescription,
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
import { parseSearchQuery, settingMatches, shortcutMatches, isEmptyQuery, highlightText } from './model/search.js';
import { registerPageCommands } from '@/renderer/lib/commands';
import { applyLocalPreference, errorMessage, preferenceValuesEqual, readPreference } from './model/settings.js';
import { SETTINGS_QUERY_KEYS, usePreferencesQuery } from './queries.js';

/**
 * A queued in-page target applied after the owning category page renders: the
 * deep-link / cross-group search jump scrolls to (and flashes) one setting, or
 * scrolls to one in-page group card. A `setting` target marked `focus` also
 * moves keyboard focus onto the row, so activating a search result does not
 * lose focus when the result list unmounts.
 */
type PendingTarget =
  | { kind: 'setting'; id: string; focus?: boolean }
  | { kind: 'group'; group: string };

function HighlightedText({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
  return highlightText(text, terms).map((segment, index) =>
    segment.match
      ? <mark key={index} className="rounded-sm bg-primary/15 px-0.5 text-foreground">{segment.text}</mark>
      : <span key={index}>{segment.text}</span>,
  );
}

/** Supply pages whose header carries the quota refresh action (usage spec 6). */
const QUOTA_REFRESH_CATEGORIES: ReadonlySet<SettingsCategoryId> = new Set<SettingsCategoryId>([
  'usage',
  'providers',
  'catalog',
]);

/**
 * The Settings Activity: a 220px secondary sidebar that switches between one
 * page per category, a fixed search row, and a scrolling body. Every category
 * page stays mounted but hidden, so only the selected one is visible and a
 * category switch never unmounts a custom control's draft. The navigation state
 * records the category, so back/forward and `settings.open` deep links land on
 * the right page; a queued target scrolls (and flashes/focuses) the exact row
 * after that page renders. Search remains a cross-category result list.
 */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const platform = shell.platform;

  const [searchInput, setSearchInput] = useState('');
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('general');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // The shell keeps the Settings page mounted inside an `Activity` boundary that
  // pauses effects while the page is hidden and re-runs them when it becomes
  // visible again, so reopening the group sidebar here restores the open default
  // on every re-entry. It runs on mount/resume only — never on each render — so
  // the title-bar / Cmd-or-Ctrl+B toggle still controls the sidebar while the
  // user stays on the page.
  useEffect(() => {
    setSidebarOpen(true);
  }, []);
  const [pendingTarget, setPendingTarget] = useState<PendingTarget | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  // The shared provider dialog entry: 用量 and 供应商 both open this one instance.
  const [dialogEntry, setDialogEntry] = useState<ProviderCatalogSnapshot | null>(null);
  const [reorderError, setReorderError] = useState('');

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useSecondarySidebar({ open: sidebarOpen, setOpen: setSidebarOpen });

  const navState = useMemo<Record<string, string>>(() => ({ category: activeCategory }), [activeCategory]);
  const restoreLocation = useCallback((state: Record<string, string>) => {
    const category = state.category;
    if (category !== undefined && isSettingsCategoryId(category)) {
      setSearchInput('');
      setActiveCategory(category);
      return true;
    }
    return false;
  }, []);
  useNavLocation(navState, restoreLocation);

  const query = useMemo(() => parseSearchQuery(searchInput), [searchInput]);
  const searchActive = !isEmptyQuery(query);

  // What the scroll container currently shows: the search results, or the one
  // selected category page. A change of this value resets the scroll to the top
  // unless a pending target scrolls somewhere specific instead.
  const visiblePage = searchActive ? '__search__' : activeCategory;
  const visiblePageRef = useRef(visiblePage);

  const preferences = usePreferencesQuery();

  // The supply categories (用量 / 供应商 / 模型 / 派发测试) read the shared quota
  // snapshot and its provider-order mutation; the same cache entry backs the
  // status-bar quota panel.
  const quota = useQuotaQuery();
  const quotaRefresh = useQuotaRefresh();
  const providerOrder = useSaveProviderOrder();
  const snapshot = quota.data ?? null;
  const modelRows = useMemo(() => buildModelListRows(snapshot), [snapshot]);
  const quotaFallback = quota.isPending
    ? <Skeleton className="h-24 w-full" />
    : <QueryError query={quota} title={QUOTA_UNAVAILABLE_FALLBACK} />;

  const handleReorder = (providerIds: string[]): void => {
    setReorderError('');
    providerOrder.mutate(providerIds, {
      onError: (cause) => setReorderError(errorMessage(cause)),
    });
  };

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
      toast(`偏好保存失败：${errorMessage(error)}`, { level: 'error' });
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
      // A numeric preference surfaced through an enum Select (zoom) arrives as a
      // string from the option value; coerce it back before validation.
      const coerce = (next: unknown): unknown =>
        typeof definition.default === 'number' && typeof next === 'string' ? Number(next) : next;
      map.set(definition.id, {
        value,
        modified: definition.default !== undefined && !preferenceValuesEqual(value, definition.default),
        readonly: definition.readonly === true,
        pending: savePreference.isPending && savePreference.variables?.id === id,
        ...(savePreference.isError && savePreference.variables?.id === id
          ? { error: errorMessage(savePreference.error) }
          : {}),
        onChange: (next) => savePreference.mutate({ id, value: coerce(next) }),
        ...(definition.default !== undefined
          ? { onReset: () => savePreference.mutate({ id, value: definition.default }) }
          : {}),
      });
    }
    return map;
  }, [preferences.data, savePreference.isPending, savePreference.isError, savePreference.variables, savePreference.error, savePreference]);

  const matchingShortcuts = useMemo(() => {
    return KNOWN_SHORTCUTS.filter((shortcut) => {
      const keys = knownShortcutKeys(shortcut, platform);
      if (keys === null) return false;
      return shortcutMatches({ title: shortcut.title, category: shortcut.category, scope: shortcut.scope, keys }, query);
    });
  }, [platform, query]);
  const shortcutCount = matchingShortcuts.length;

  // Every registry setting that matches the active search, grouped by category.
  // An empty query matches everything, so this also backs the full category
  // counts shown in the directory.
  const categoryMatches = useMemo(() => {
    const map = new Map<SettingsCategoryId, SettingDefinition[]>();
    for (const category of SETTINGS_CATEGORIES) {
      const definitions = settingsForCategory(category.id)
        .filter((definition) => definition.platform === undefined || definition.platform.includes(platform))
        .filter((definition) => {
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
      map.set(category.id, definitions);
    }
    return map;
  }, [platform, query, preferenceBindings]);

  const totalResults = useMemo(() => {
    let count = shortcutCount;
    for (const definitions of categoryMatches.values()) count += definitions.length;
    return count;
  }, [categoryMatches, shortcutCount]);
  const showEmpty = searchActive && totalResults === 0;

  const scrollTo = useCallback((selector: string, block: ScrollLogicalPosition) => {
    scrollRef.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block });
  }, []);

  const focusSetting = useCallback((id: string) => {
    scrollRef.current?.querySelector<HTMLElement>(`#setting-${CSS.escape(id)}`)?.focus({ preventScroll: true });
  }, []);

  // Apply a queued deep-link / search jump once the owning page has rendered.
  // A pending target always wins over the page-change scroll reset, so it works
  // the same when the category changes (nav restore, `settings.open`, a search
  // result) and when it only scrolls within the current page. Otherwise, any
  // change of the visible page (category switch, entering or leaving search)
  // resets the scroll container to the top.
  useEffect(() => {
    const pageChanged = visiblePageRef.current !== visiblePage;
    visiblePageRef.current = visiblePage;
    if (pendingTarget === null) {
      if (pageChanged) scrollRef.current?.scrollTo({ top: 0 });
      return;
    }
    const request = pendingTarget;
    setPendingTarget(null);
    if (request.kind === 'group') {
      requestAnimationFrame(() => scrollTo(`[data-group="${CSS.escape(request.group)}"]`, 'start'));
      return;
    }
    setFlashId(request.id);
    requestAnimationFrame(() => {
      scrollTo(`#setting-${CSS.escape(request.id)}`, 'center');
      if (request.focus === true) focusSetting(request.id);
    });
  }, [pendingTarget, visiblePage, scrollTo, focusSetting]);

  // Clear the deep-link flash after one pulse.
  useEffect(() => {
    if (flashId === null) return;
    const timer = window.setTimeout(() => setFlashId(null), 1_200);
    return () => window.clearTimeout(timer);
  }, [flashId]);

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
      setPendingTarget(null);
      if (isSettingsCategoryId(target)) {
        setActiveCategory(target);
        return;
      }
      const definition = SETTINGS_REGISTRY.find((candidate) => candidate.id === target);
      if (definition !== undefined) {
        setActiveCategory(definition.category);
        setPendingTarget({ kind: 'setting', id: target });
      }
    },
  }]), []);

  const refresh = (): void => {
    for (const queryKey of SETTINGS_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  // Sidebar category click: switch pages, leaving search and any stale target.
  const selectCategory = useCallback((id: SettingsCategoryId) => {
    setSearchInput('');
    setPendingTarget(null);
    setActiveCategory(id);
  }, []);

  // Sidebar group click: open the owning page, then scroll to that group card.
  const selectGroup = useCallback((categoryId: SettingsCategoryId, group: string) => {
    setSearchInput('');
    setActiveCategory(categoryId);
    setPendingTarget({ kind: 'group', group });
  }, []);

  // Search result activation: open the category page, then focus and flash the
  // setting. The focus lands after the result list unmounts, so it is not lost.
  const activateResult = useCallback((categoryId: SettingsCategoryId, settingId?: string) => {
    setSearchInput('');
    setActiveCategory(categoryId);
    setPendingTarget(settingId !== undefined ? { kind: 'setting', id: settingId, focus: true } : null);
  }, []);

  // The directory lists every registry category; counts reflect the search.
  const tocCategories = useMemo<TocCategory[]>(() => {
    return SETTINGS_CATEGORIES.map((category) => {
      const definitions = categoryMatches.get(category.id) ?? [];
      const groupLabels = SETTINGS_GROUP_LABELS[category.id] ?? [];
      return {
        id: category.id,
        label: category.label,
        count: category.id === 'shortcuts' ? shortcutCount : definitions.length,
        groups: groupLabels.map((group) => ({
          key: group.key,
          label: group.label,
          count: definitions.filter((definition) => definition.group === group.key).length,
        })),
      };
    });
  }, [categoryMatches, shortcutCount]);

  // Each category page's group cards. Every category page stays mounted (just
  // hidden when it is not the visible page), so groups are computed for all of
  // them and a category switch never discards a custom control's draft.
  const categoryGroups = useMemo(() => {
    return new Map(
      SETTINGS_CATEGORIES.map((category) => {
        const definitions = settingsForCategory(category.id)
          .filter((definition) => definition.platform === undefined || definition.platform.includes(platform));
        const groupLabels = SETTINGS_GROUP_LABELS[category.id] ?? [];
        const groups = groupLabels.length === 0
          ? [{ key: '', label: '', definitions }]
          : groupLabels
              .map((group) => ({
                key: group.key,
                label: group.label,
                definitions: definitions.filter((definition) => definition.group === group.key),
              }))
              .filter((group) => group.definitions.length > 0);
        return [category.id, groups] as const;
      }),
    );
  }, [platform]);

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

  // One category page's body. 快捷键 and the four supply pages render their own
  // component instead of registry groups; every other category renders its
  // group cards. The supply pages keep the same always-mounted,
  // hidden-when-inactive section, so switching categories never discards a
  // dialog draft.
  function renderCategoryBody(categoryId: SettingsCategoryId): ReactNode {
    if (categoryId === 'shortcuts') {
      return <ShortcutsTable platform={platform} query={query} />;
    }
    if (categoryId === 'usage') {
      return <ProviderUsage />;
    }
    if (categoryId === 'providers') {
      if (snapshot === null) return quotaFallback;
      return (
        <ProviderSupply
          snapshot={snapshot}
          savingOrder={providerOrder.isPending}
          reorderError={reorderError}
          onReorder={handleReorder}
          onConfigure={setDialogEntry}
        />
      );
    }
    if (categoryId === 'catalog') {
      if (snapshot === null) return quotaFallback;
      return <ModelList rows={modelRows} />;
    }
    if (categoryId === 'routingTest') {
      return (
        <RoutingTest
          snapshot={snapshot}
          active={!searchActive && activeCategory === 'routingTest'}
        />
      );
    }
    const groups = categoryGroups.get(categoryId) ?? [];
    return groups.map((group) => (
      <section
        key={group.key || 'all'}
        data-group={group.key === '' ? undefined : group.key}
        className="flex scroll-mt-4 flex-col gap-2"
      >
        {group.label !== '' && (
          <h3 className="text-sm font-medium text-muted-foreground">{group.label}</h3>
        )}
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="@container/field-group flex w-full flex-col divide-y">
            {group.definitions.map(renderRow)}
          </div>
        </div>
      </section>
    ));
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
              <SidebarHeader>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton tooltip="返回首页" onClick={() => void shell.navigate('session')}>
                      <ArrowLeft />
                      <span>返回首页</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarHeader>
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
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
                <PetSettingsProvider>
                  {searchActive && (
                    showEmpty ? (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>{SEARCH_EMPTY_TITLE}</EmptyTitle>
                          <EmptyDescription>{SEARCH_EMPTY_DESCRIPTION}</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <>
                        {SETTINGS_CATEGORIES.map((category) => {
                          const definitions = categoryMatches.get(category.id) ?? [];
                          if (definitions.length === 0) return null;
                          return (
                            <section key={category.id} className="flex flex-col gap-1">
                              <h3 className="px-3 text-xs font-medium tracking-wide text-muted-foreground">
                                {category.label}
                              </h3>
                              {definitions.map((definition) => (
                                <button
                                  key={definition.id}
                                  type="button"
                                  onClick={() => activateResult(category.id, definition.id)}
                                  className="flex flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                                >
                                  <span className="text-sm font-medium">
                                    <HighlightedText text={definition.title} terms={query.terms} />
                                  </span>
                                  {definition.description !== undefined && (
                                    <span className="text-xs text-muted-foreground">
                                      <HighlightedText text={definition.description} terms={query.terms} />
                                    </span>
                                  )}
                                </button>
                              ))}
                            </section>
                          );
                        })}
                        {shortcutCount > 0 && (
                          <section className="flex flex-col gap-1">
                            <h3 className="px-3 text-xs font-medium tracking-wide text-muted-foreground">
                              {settingsCategoryLabel('shortcuts')}
                            </h3>
                            {matchingShortcuts.map((shortcut) => (
                              <button
                                key={`${shortcut.category}-${shortcut.title}`}
                                type="button"
                                onClick={() => activateResult('shortcuts')}
                                className="flex flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                              >
                                <span className="text-sm font-medium">
                                  <HighlightedText text={shortcut.title} terms={query.terms} />
                                </span>
                                <span className="text-xs text-muted-foreground">{shortcut.scope}</span>
                              </button>
                            ))}
                          </section>
                        )}
                      </>
                    )
                  )}
                  {SETTINGS_CATEGORIES.map((category) => {
                    const visible = !searchActive && category.id === activeCategory;
                    return (
                      <section
                        key={category.id}
                        className={visible ? 'flex flex-col gap-6' : 'hidden'}
                      >
                        <header className="flex flex-col gap-1">
                          <h1 className="flex items-center gap-3 text-xl font-semibold">
                            {settingsCategoryLabel(category.id)}
                            {category.id === 'pet' && <PetStatusBadge />}
                            {QUOTA_REFRESH_CATEGORIES.has(category.id) && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="ml-auto"
                                aria-label="刷新"
                                disabled={quotaRefresh.isPending}
                                onClick={() => quotaRefresh.mutate()}
                              >
                                <RefreshCw />
                              </Button>
                            )}
                          </h1>
                          <p className="text-sm text-muted-foreground">
                            {settingsCategoryDescription(category.id)}
                          </p>
                        </header>
                        {renderCategoryBody(category.id)}
                      </section>
                    );
                  })}
                </PetSettingsProvider>
              </div>
            </div>
          </div>
        </div>
      </SidebarProvider>
      <ProviderDialog
        entry={dialogEntry}
        onClose={() => setDialogEntry(null)}
        onSaved={(next) => queryClient.setQueryData(quotaQuery.queryKey, next)}
      />
    </Page>
  );
}
