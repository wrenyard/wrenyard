import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BatteryFull, Gift, Search, SlidersHorizontal, Zap } from 'lucide-react';
import { REASONING_EFFORT_NAMES, type ReasoningEffort } from '@wrenyard/models';
import { cn } from 'cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/renderer/components/ui/input-group';

/** One catalog-derived supply badge. Runtime is never a badge. */
export interface ModelBadge {
  kind: 'turbo' | 'fast' | 'quota' | 'free';
  text: string;
}

const MODEL_BADGE_ICONS = {
  turbo: Zap,
  fast: Zap,
  quota: BatteryFull,
  free: Gift,
} as const;

/** The raw facts a badge is derived from; all are optional catalog flags. */
export interface ModelBadgeFacts {
  effectiveTps?: number | null;
  quotaAbundant?: boolean;
  free?: boolean;
}

/**
 * The original main-model supply badges in their fixed order: a strict speed
 * tier (very fast above 200 TPS, fast above 100 TPS), then the abundant-quota
 * marker, then the authoritative free-model marker. Only an explicit
 * `free === true` counts; a missing price is never treated as free.
 */
export function modelBadges(facts: ModelBadgeFacts): ModelBadge[] {
  const badges: ModelBadge[] = [];
  const tps = facts.effectiveTps;
  if (tps !== undefined && tps !== null) {
    if (tps > 200) badges.push({ kind: 'turbo', text: `极速 · ${Math.round(tps)} TPS` });
    else if (tps > 100) badges.push({ kind: 'fast', text: `快速 · ${Math.round(tps)} TPS` });
  }
  if (facts.quotaAbundant === true) badges.push({ kind: 'quota', text: '额度充足' });
  if (facts.free === true) badges.push({ kind: 'free', text: '免费模型' });
  return badges;
}

export interface ModelOption {
  value: string;
  label: string;
  group: string;
  badges?: ModelBadge[];
  /** Route-owned supported efforts in ladder order; empty means no effort submenu. */
  efforts: readonly ReasoningEffort[];
  /** Effort applied when this model is picked: the current one when supported, else the nearest default. */
  defaultEffort: ReasoningEffort;
}

export interface ModelPickerProps {
  models: ModelOption[];
  value: string;
  /** The current route's reasoning effort, shown on the trigger and checked for its own model. */
  effort: ReasoningEffort;
  /** Selecting an effort atomically selects that model and that exact supported level. */
  onChange: (modelId: string, effort: ReasoningEffort) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /**
   * Alternate trigger presentation for narrow composers. When true the trigger
   * follows the enclosing `composer` container query: at a wide container it
   * shows the full model name plus effort, and at a narrow one it collapses to
   * an icon whose accessible name/title still carries the full model name and
   * effort. It is never a truncation of the model name. Default false keeps the
   * existing full-name trigger untouched for other consumers.
   */
  compactTrigger?: boolean;
}

/** One option's truncating name and aligned supply indicators. */
function ModelOptionContent({ option, compact = false }: { option: ModelOption; compact?: boolean }) {
  const speed = option.badges?.find((badge) => badge.kind === 'turbo' || badge.kind === 'fast');
  const free = option.badges?.find((badge) => badge.kind === 'free');
  const quota = option.badges?.find((badge) => badge.kind === 'quota');

  const slot = (badge: ModelBadge | undefined, kind: ModelBadge['kind'], className: string) => {
    if (!badge) return <span className={className} aria-hidden="true" />;
    const Icon = MODEL_BADGE_ICONS[kind];
    return (
      <span
        className={className}
        role="img"
        aria-label={badge.text}
        title={kind === 'turbo' || kind === 'fast' ? badge.text : undefined}
      >
        <Icon className={`size-3.5 ${kind === 'turbo' ? 'text-amber-500' : 'text-muted-foreground'}`} />
      </span>
    );
  };

  return (
    <span className={compact ? 'flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-2' : 'flex min-w-0 flex-1 items-center gap-1.5'}>
      <span className={compact ? 'min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]' : 'min-w-0 truncate'}>{option.label}</span>
      {speed && slot(speed, speed.kind, 'flex shrink-0 items-center gap-1')}
      {!compact && free && slot(free, 'free', 'flex w-3.5 shrink-0 items-center justify-center')}
      {!compact && quota && slot(quota, 'quota', 'flex w-3.5 shrink-0 items-center justify-center')}
    </span>
  );
}

/**
 * A dot that marks the currently selected model. It is deliberately different
 * from the per-model radio check so the applied model and the checked effort
 * are never read as the same thing.
 */
function SelectedModelIndicator() {
  return (
    <span
      aria-hidden="true"
      data-slot="model-picker-selected-indicator"
      className="size-1.5 shrink-0 rounded-full bg-primary"
    />
  );
}

/**
 * One unified model picker: providers are labelled menu groups, each model is a
 * submenu trigger (with a distinct selected-model mark) whose content is a radio
 * group of that model's supported reasoning efforts. Choosing an effort selects
 * that model and that exact level in one action. Values are opaque to the page.
 *
 * The popup is capped at `min(24rem, available viewport space)` with a fixed
 * search header; only the result list scrolls (scrollbars hidden). The search
 * field filters by model name/id and provider group name, and takes over the
 * keyboard so its text editing never reaches the menu's typeahead.
 */
export function ModelPicker({ models, value, effort, onChange, disabled = false, placeholder = '选择模型', className, compactTrigger = false }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const model of models) {
      const bucket = map.get(model.group);
      if (bucket) bucket.push(model);
      else map.set(model.group, [model]);
    }
    return [...map.entries()].map(([group, items]) => ({ value: group, items }));
  }, [models]);

  const selected = useMemo(
    () => models.find((model) => model.value === value) ?? null,
    [models, value],
  );

  const effortLabel = REASONING_EFFORT_NAMES[effort];
  // The full model name plus effort, used as the trigger's accessible name and
  // (in compact mode) its title, so the narrow icon trigger is never ambiguous.
  const triggerLabel = selected === null ? placeholder : `${selected.label}，思考强度：${effortLabel}`;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    if (normalizedQuery === '') return groups;
    return groups
      .map((group) => {
        // A matching provider name keeps that provider's whole list.
        if (group.value.toLowerCase().includes(normalizedQuery)) return group;
        return {
          value: group.value,
          items: group.items.filter(
            (item) =>
              item.label.toLowerCase().includes(normalizedQuery) ||
              item.value.toLowerCase().includes(normalizedQuery),
          ),
        };
      })
      .filter((group) => group.items.length > 0);
  }, [groups, normalizedQuery]);

  // The open popup moves focus onto its menu items; hand focus to the search
  // field instead, and re-assert it on the next frame in case the menu's own
  // initial-focus pass lands after this effect.
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /** Result rows in visual order; disabled rows are never a focus target. */
  function modelRows(): HTMLElement[] {
    const container = resultsRef.current;
    if (container === null) return [];
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-menu-item"], [data-slot="dropdown-menu-sub-trigger"]',
      ),
    ).filter((row) => row.getAttribute('aria-disabled') !== 'true');
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // While the IME is composing, ArrowUp/ArrowDown and Escape belong to the
    // candidate window, not to us; keep the key in the field and never move
    // focus or prevent the IME's default handling.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    // Escape closes the menu and Tab leaves it; both stay with the menu.
    if (event.key === 'Escape' || event.key === 'Tab') return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rows = modelRows();
      const target = event.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1];
      event.preventDefault();
      event.stopPropagation();
      target?.focus();
      return;
    }
    // Text editing (including IME composition) must not reach the menu's
    // typeahead or list navigation; stopping propagation keeps the keystroke in
    // the field without preventing its default behaviour.
    event.stopPropagation();
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        // A reopened menu always starts from an unfiltered list.
        if (next) setQuery('');
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            variant="ghost"
            className={cn('h-auto min-h-8 max-w-full min-w-0 whitespace-normal py-1', className)}
            disabled={disabled}
            aria-label={triggerLabel}
            title={compactTrigger ? triggerLabel : undefined}
          />
        }
      >
        {selected === null ? (
          placeholder
        ) : compactTrigger ? (
          <>
            {/* Wide composer: the full model name plus effort, wrapping rather
                than truncating. */}
            <span className="hidden min-w-0 max-w-full flex-wrap items-center gap-2 @sm/composer:flex">
              <ModelOptionContent option={selected} compact />
              <span className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">{effortLabel}</span>
            </span>
            {/* Narrow composer: an icon-only trigger; the accessible name/title
                on the button still carries the full model name and effort. */}
            <span className="flex items-center @sm/composer:hidden" aria-hidden="true">
              <SlidersHorizontal className="size-4" />
            </span>
          </>
        ) : (
          <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <ModelOptionContent option={selected} compact />
            <span className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">{effortLabel}</span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        className="flex max-h-[min(24rem,var(--available-height))] min-h-0 min-w-64 flex-col overflow-hidden"
      >
        <div className="shrink-0 pb-1">
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search models"
              aria-label="Search models"
              spellCheck={false}
              autoComplete="off"
            />
          </InputGroup>
        </div>
        <div
          ref={resultsRef}
          className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {visibleGroups.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No models found</p>
          ) : (
            visibleGroups.map((group) => (
              <DropdownMenuGroup key={group.value}>
                <DropdownMenuLabel>{group.value}</DropdownMenuLabel>
                {group.items.map((option) => {
                  const isCurrent = option.value === value;
                  const checked = isCurrent ? effort : option.defaultEffort;
                  if (option.efforts.length === 0) {
                    return (
                      <DropdownMenuItem
                        key={option.value}
                        onClick={() => onChange(option.value, checked)}
                        className={isCurrent ? 'bg-accent/60 font-medium' : undefined}
                      >
                        <ModelOptionContent option={option} />
                        {isCurrent && <SelectedModelIndicator />}
                      </DropdownMenuItem>
                    );
                  }
                  return (
                    <DropdownMenuSub key={option.value}>
                      <DropdownMenuSubTrigger
                        className={
                          isCurrent
                            ? 'bg-accent/60 font-medium [&>svg:last-child]:hidden'
                            : '[&>svg:last-child]:hidden'
                        }
                      >
                        <ModelOptionContent option={option} />
                        {isCurrent && <SelectedModelIndicator />}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="no-scrollbar">
                        <DropdownMenuRadioGroup
                          value={isCurrent ? effort : ''}
                          onValueChange={(next) => {
                            if (typeof next === 'string' && (option.efforts as readonly string[]).includes(next)) {
                              onChange(option.value, next as ReasoningEffort);
                            }
                          }}
                        >
                          {option.efforts.map((level) => (
                            <DropdownMenuRadioItem
                              key={level}
                              value={level}
                              className="not-focus:data-[checked]:bg-accent/60 data-[checked]:font-medium"
                            >
                              {REASONING_EFFORT_NAMES[level]}
                              {!isCurrent && level === option.defaultEffort && (
                                <span className="ml-auto text-xs text-muted-foreground">预设</span>
                              )}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                        <DropdownMenuItem disabled>Fast（暂不支持：该模型未提供独立快速模式）</DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  );
                })}
              </DropdownMenuGroup>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
