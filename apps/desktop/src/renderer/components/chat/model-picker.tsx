import { useMemo } from 'react';
import { BatteryFull, Gauge, Gift, Zap } from 'lucide-react';
import { REASONING_EFFORT_NAMES, type ReasoningEffort } from '@wrenyard/models';
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
import { InputGroupButton } from '@/renderer/components/ui/input-group';

/** One catalog-derived supply badge. Runtime is never a badge. */
export interface ModelBadge {
  kind: 'turbo' | 'fast' | 'quota' | 'free';
  text: string;
}

const MODEL_BADGE_ICONS = {
  turbo: Zap,
  fast: Gauge,
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
    <span className={compact ? 'flex min-w-0 flex-1 items-center gap-2' : 'flex min-w-0 flex-1 items-center gap-1.5'}>
      <span className="min-w-0 truncate">{option.label}</span>
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
 */
export function ModelPicker({ models, value, effort, onChange, disabled = false, placeholder = '选择模型', className }: ModelPickerProps) {
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            variant="ghost"
            className={className}
            disabled={disabled}
            aria-label={selected === null ? placeholder : `${selected.label}，思考强度：${effortLabel}`}
          />
        }
      >
        {selected === null ? (
          placeholder
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <ModelOptionContent option={selected} compact />
            <span className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">{effortLabel}</span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="min-w-64">
        {groups.map((group) => (
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
                  <DropdownMenuSubTrigger className={isCurrent ? 'bg-accent/60 font-medium' : undefined}>
                    <ModelOptionContent option={option} />
                    {isCurrent && <SelectedModelIndicator />}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={checked}
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
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
