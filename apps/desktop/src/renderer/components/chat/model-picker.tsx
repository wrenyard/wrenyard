import { useMemo } from 'react';
import { REASONING_EFFORT_NAMES, type ReasoningEffort } from '@wrenyard/models';
import type { SessionInferenceMode } from '@wrenyard/protocol';
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
import { Badge } from '@/renderer/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import { InputGroupButton } from '@/renderer/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';

/** One catalog-derived supply badge. Runtime is never a badge. */
export interface ModelBadge {
  kind: 'fast' | 'very-fast' | 'quota' | 'free';
  label: string;
}

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
    if (tps > 200) badges.push({ kind: 'very-fast', label: `极速 · ${tps} TPS` });
    else if (tps > 100) badges.push({ kind: 'fast', label: `快速 · ${tps} TPS` });
  }
  if (facts.quotaAbundant === true) badges.push({ kind: 'quota', label: '额度充足' });
  if (facts.free === true) badges.push({ kind: 'free', label: '免费模型' });
  return badges;
}

/**
 * Hover copy for a main-model row's runtime. The runtime is never rendered as
 * an icon or badge. Shared by the composer and the settings model pickers.
 */
export function modelRuntimeDescription(runtime: SessionInferenceMode): string {
  return runtime === 'openai_responses'
    ? '经网关的推理接口运行（Responses 协议）'
    : '经网关的推理接口运行（Chat 协议）';
}

export interface ModelOption {
  value: string;
  label: string;
  group: string;
  /** Hover tooltip copy shown on the row and the selected trigger. */
  description?: string;
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

/** One option's label followed by its supply badges. */
function ModelOptionContent({ option }: { option: ModelOption }) {
  return (
    <>
      <span className="truncate">{option.label}</span>
      {option.badges?.map((badge) => (
        <Badge key={badge.kind} variant="secondary" className="shrink-0">
          {badge.label}
        </Badge>
      ))}
    </>
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
      <Tooltip>
        <TooltipTrigger
          render={<ComboboxTrigger render={<InputGroupButton variant="ghost" className={className} />} />}
        >
          <ComboboxValue>
            {(current: ModelOption | null) => (current ? <ModelOptionContent option={current} /> : placeholder)}
          </ComboboxValue>
        </TooltipTrigger>
        {selected?.description !== undefined && <TooltipContent>{selected.description}</TooltipContent>}
      </Tooltip>
      <ComboboxContent side="top" className="min-w-64">
        <ComboboxInput showTrigger={false} placeholder={placeholder} disabled={disabled} />
        <ComboboxEmpty>没有匹配的模型</ComboboxEmpty>
        <ComboboxList>
          {(group: { value: string; items: ModelOption[] }) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(option: ModelOption) => (
                  <ComboboxItem key={option.value} value={option}>
                    {option.description === undefined ? (
                      <ModelOptionContent option={option} />
                    ) : (
                      <Tooltip>
                        <TooltipTrigger render={<span className="flex min-w-0 flex-1 items-center gap-1.5" />}>
                          <ModelOptionContent option={option} />
                        </TooltipTrigger>
                        <TooltipContent side="right">{option.description}</TooltipContent>
                      </Tooltip>
                    )}
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
  className?: string;
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
            <DropdownMenuRadioItem key={level} value={level}>{REASONING_EFFORT_NAMES[level]}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
