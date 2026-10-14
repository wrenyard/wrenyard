import { useMemo } from 'react';
import { BatteryFull, Gauge, Gift, Zap } from 'lucide-react';
import { REASONING_EFFORT_NAMES, type ReasoningEffort } from '@wrenyard/models';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@/renderer/components/ui/combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import { InputGroupButton } from '@/renderer/components/ui/input-group';

/** One catalog-derived supply badge. Runtime is never a badge. */
export interface ModelBadge {
  kind: 'turbo' | 'fast' | 'quota' | 'free';
  text: string;
  tps?: number;
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
    if (tps > 200) badges.push({ kind: 'turbo', text: `极速 · ${Math.round(tps)} TPS`, tps: Math.round(tps) });
    else if (tps > 100) badges.push({ kind: 'fast', text: `快速 · ${Math.round(tps)} TPS`, tps: Math.round(tps) });
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
}

export interface ModelPickerProps {
  models: ModelOption[];
  value: string;
  onChange: (value: string) => void;
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
      <span className={className} role="img" aria-label={badge.text}>
        <Icon className={`size-3.5 ${kind === 'turbo' ? 'text-amber-500' : 'text-muted-foreground'}`} />
        {kind === 'turbo' || kind === 'fast' ? (
          !compact && <span className="text-xs tabular-nums text-muted-foreground">{badge.tps}</span>
        ) : null}
      </span>
    );
  };

  return (
    <span className={compact ? 'flex w-full min-w-0 items-center gap-2' : 'flex w-full min-w-0 items-center gap-1.5'}>
      <span className="min-w-0 truncate">{option.label}</span>
      {speed && slot(speed, speed.kind, 'flex shrink-0 items-center gap-1')}
      {!compact && free && slot(free, 'free', 'flex w-3.5 shrink-0 items-center justify-center')}
      {!compact && quota && slot(quota, 'quota', 'flex w-3.5 shrink-0 items-center justify-center')}
    </span>
  );
}

/** Searchable model picker grouped by provider. Values are opaque to the page. */
export function ModelPicker({ models, value, onChange, disabled = false, placeholder = '选择模型', className }: ModelPickerProps) {
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

  const valueContent = (
    <ComboboxValue>
      {(current: ModelOption | null) => (current ? <ModelOptionContent option={current} compact /> : placeholder)}
    </ComboboxValue>
  );

  return (
    <Combobox
      items={groups}
      value={selected}
      onValueChange={(next) => onChange(next ? next.value : '')}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      isItemEqualToValue={(a, b) => a.value === b.value}
      disabled={disabled}
    >
      <ComboboxTrigger render={<InputGroupButton variant="ghost" className={className} />}>
        {valueContent}
      </ComboboxTrigger>
      <ComboboxContent side="top" className="min-w-64">
        <ComboboxInput showTrigger={false} placeholder={placeholder} disabled={disabled} />
        <ComboboxEmpty>没有匹配的模型</ComboboxEmpty>
        <ComboboxList>
          {(group: { value: string; items: ModelOption[] }) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(option: ModelOption) => (
                  <ComboboxItem
                    key={option.value}
                    value={option}
                    showIndicator={false}
                    className="not-data-[highlighted]:data-[selected]:bg-accent/60 data-[selected]:font-medium"
                  >
                    <ModelOptionContent option={option} />
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

export interface EffortPickerProps {
  /** The current route's supported efforts, in ladder order (non-empty by contract). */
  levels: readonly ReasoningEffort[];
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
}

/**
 * Reasoning-effort picker. Offers only the current route's supported levels,
 * labelled with the shared Chinese names, with no unset/default option, so a
 * level is always selected. Renders nothing only when the route declares none.
 */
export function EffortPicker({ levels, value, onChange }: EffortPickerProps) {
  if (levels.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<InputGroupButton variant="ghost" />}>
        {REASONING_EFFORT_NAMES[value]}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (typeof next === 'string' && (levels as readonly string[]).includes(next)) {
              onChange(next as ReasoningEffort);
            }
          }}
        >
          {levels.map((level) => (
            <DropdownMenuRadioItem
              key={level}
              value={level}
              showIndicator={false}
              className="not-focus:data-[checked]:bg-accent/60 data-[checked]:font-medium"
            >
              {REASONING_EFFORT_NAMES[level]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
