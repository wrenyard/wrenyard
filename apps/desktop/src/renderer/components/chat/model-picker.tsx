import { useMemo } from 'react';
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

export interface ModelOption {
  value: string;
  label: string;
  group: string;
  description?: string;
}

export interface ModelPickerProps {
  models: ModelOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const DEFAULT_VALUE = '__default__';

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
      <ComboboxTrigger render={<InputGroupButton variant="ghost" className={className} />}>
        <ComboboxValue>{(current) => current?.label ?? placeholder}</ComboboxValue>
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
                  <ComboboxItem key={option.value} value={option}>{option.label}</ComboboxItem>
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
  levels: string[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/** Reasoning-effort picker. Renders nothing when the model has no levels. */
export function EffortPicker({ levels, value, onChange }: EffortPickerProps) {
  if (levels.length === 0) return null;
  const options = [DEFAULT_VALUE, ...levels];
  const labelOf = (current: string): string => (current === DEFAULT_VALUE ? '默认' : current);
  const current = value === '' ? DEFAULT_VALUE : value;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<InputGroupButton variant="ghost" />}>
        {labelOf(current)}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(next) => onChange(next === DEFAULT_VALUE ? '' : String(next))}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>{labelOf(option)}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
