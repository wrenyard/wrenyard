import { useEffect, useState, type ReactNode } from 'react';
import { Copy, RotateCcw, Settings2 } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { copyText } from '@/renderer/lib/desktop';
import {
  GEAR_COPY_ID_LABEL,
  GEAR_COPY_JSON_LABEL,
  GEAR_RESET_LABEL,
  SETTING_INVALID_NUMBER,
  SETTING_NUMBER_RANGE,
} from '../model/describe.js';
import type { CustomControlKey, SettingControl, SettingDefinition } from '../model/registry.js';
import { highlightText } from '../model/search.js';
import { CUSTOM_CONTROLS } from './custom-controls.js';

/**
 * The live value binding for a single setting row. Standard controls read and
 * write it; a row with no binding is read-only or manages its own state.
 */
export interface SettingBinding {
  value: unknown;
  modified: boolean;
  readonly: boolean;
  pending?: boolean;
  error?: string;
  onChange: (value: unknown) => void;
  onReset?: () => void;
}

export interface SettingRowProps {
  definition: SettingDefinition;
  binding?: SettingBinding;
  /** Lowercased search terms to wrap in `mark`. */
  highlightTerms?: readonly string[];
  /** Briefly true after a deep-link; paints the row background once. */
  flashed?: boolean;
}

function HighlightedText({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
  const segments = highlightText(text, terms);
  return segments.map((segment, index) => (
    segment.match
      ? <mark key={index} className="rounded-sm bg-primary/15 px-0.5 text-foreground">{segment.text}</mark>
      : <span key={index}>{segment.text}</span>
  ));
}

/**
 * Custom controls that need the whole card width: pickers and forms built from
 * several elements (theme cards, workspace, routing weights, the update panel
 * and runtime aliases). Every other custom control is a single widget and keeps
 * the standard label-left / control-right row.
 */
const STACKED_CUSTOM_CONTROLS: ReadonlySet<CustomControlKey> = new Set([
  'themeCards',
  'workspace',
  'routingWeights',
  'runtimeAliases',
  'updateStatus',
]);

function BooleanControl({ value, disabled, onChange }: {
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  // VS Code-style boolean: just the official Checkbox; the label and description
  // stay together on the left of the row.
  return (
    <Checkbox
      checked={value === true}
      disabled={disabled}
      onCheckedChange={(checked: boolean) => onChange(checked)}
    />
  );
}

function EnumControl({ control, value, disabled, onChange }: {
  control: Extract<SettingControl, { kind: 'enum' }>;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const current = value === undefined || value === null ? '' : String(value);
  if (control.presentation === 'toggle') {
    return (
      <ToggleGroup
        variant="outline"
        value={current === '' ? [] : [current]}
        onValueChange={(next) => {
          const chosen = next[0];
          if (chosen !== undefined) onChange(chosen);
        }}
        disabled={disabled}
      >
        {control.options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>{option.label}</ToggleGroupItem>
        ))}
      </ToggleGroup>
    );
  }
  return (
    <Select
      value={current}
      onValueChange={(next) => { if (next !== null) onChange(next); }}
      disabled={disabled}
    >
      <SelectTrigger className="max-w-80">
        <SelectValue>
          {(selected) => control.options.find((option) => option.value === selected)?.label ?? selected}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {control.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TextControl({ control, value, disabled, onCommit }: {
  control: Extract<SettingControl, { kind: 'number' | 'string' }>;
  value: unknown;
  disabled: boolean;
  onCommit: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => (value === undefined || value === null ? '' : String(value)));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!focused) {
      setText(value === undefined || value === null ? '' : String(value));
      setError('');
    }
  }, [value, focused]);

  const commit = (): void => {
    if (control.kind === 'string') {
      setError('');
      onCommit(text);
      return;
    }
    const trimmed = text.trim();
    if (trimmed === '' || !Number.isFinite(Number(trimmed))) {
      setError(SETTING_INVALID_NUMBER);
      return;
    }
    const parsed = Number(trimmed);
    if ((control.min !== undefined && parsed < control.min) || (control.max !== undefined && parsed > control.max)) {
      setError(SETTING_NUMBER_RANGE);
      return;
    }
    setError('');
    onCommit(parsed);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        type={control.kind === 'number' ? 'number' : 'text'}
        className={control.kind === 'number' ? 'w-30' : 'max-w-80'}
        {...(control.kind === 'number'
          ? {
              ...(control.min !== undefined ? { min: control.min } : {}),
              ...(control.max !== undefined ? { max: control.max } : {}),
              ...(control.step !== undefined ? { step: control.step } : {}),
            }
          : control.placeholder !== undefined ? { placeholder: control.placeholder } : {})}
        value={text}
        disabled={disabled}
        aria-invalid={error !== ''}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
      />
      {error !== '' && <FieldError>{error}</FieldError>}
    </div>
  );
}

function GearMenu({ definition, binding, canReset }: {
  definition: SettingDefinition;
  binding?: SettingBinding;
  canReset: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="设置项操作"
            className="opacity-0 transition-opacity group-hover/setting:opacity-100 group-focus-within/setting:opacity-100"
          />
        )}
      >
        <Settings2 />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {canReset && (
          <>
            <DropdownMenuItem onClick={() => binding?.onReset?.()}>
              <RotateCcw />
              {GEAR_RESET_LABEL}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => { void copyText(definition.id); }}>
          <Copy />
          {GEAR_COPY_ID_LABEL}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            void copyText(JSON.stringify({ id: definition.id, value: binding?.value ?? null }, null, 2));
          }}
        >
          <Copy />
          {GEAR_COPY_JSON_LABEL}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One settings row. Inside a single category page the category prefix on the
 * label would only repeat the page heading, so it is dropped; the label and
 * description sit on the left and the control on the right on wide layouts,
 * stacking in narrow ones. A genuinely complex custom control takes the full
 * row width and owns its own persistence.
 */
export function SettingRow({ definition, binding, highlightTerms = [], flashed = false }: SettingRowProps) {
  const readonly = definition.readonly === true || binding?.readonly === true;
  const modified = binding !== undefined && binding.modified && !readonly;
  const canReset = !readonly && definition.default !== undefined && binding?.onReset !== undefined && modified === true;
  const isCustom = definition.control.kind === 'custom';
  // Only a genuinely complex custom control stacks full-width; a simple one
  // keeps the responsive label-left / control-right layout.
  const stackControl = definition.control.kind === 'custom' && STACKED_CUSTOM_CONTROLS.has(definition.control.render);
  const disabled = readonly || binding?.pending === true;

  const control = (() => {
    if (definition.control.kind === 'custom') {
      const CustomControl = CUSTOM_CONTROLS[definition.control.render];
      return <CustomControl />;
    }
    if (binding === undefined) return null;
    const onChange = (value: unknown): void => { binding.onChange(value); };
    switch (definition.control.kind) {
      case 'boolean':
        return <BooleanControl value={binding.value} disabled={disabled} onChange={onChange} />;
      case 'enum':
        return (
          <EnumControl
            control={definition.control}
            value={binding.value}
            disabled={disabled}
            onChange={onChange}
          />
        );
      case 'number':
      case 'string':
        return (
          <TextControl
            control={definition.control}
            value={binding.value}
            disabled={disabled}
            onCommit={onChange}
          />
        );
    }
  })();

  return (
    <div
      id={`setting-${definition.id}`}
      data-setting-id={definition.id}
      data-flash={flashed ? 'true' : undefined}
      tabIndex={-1}
      className="group/setting relative flex gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/40 focus-within:bg-muted/40 data-[flash=true]:bg-primary/10"
    >
      <div className="relative flex w-5 shrink-0 justify-center self-stretch">
        {modified && <span aria-hidden="true" className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
        {!isCustom && <GearMenu definition={definition} binding={binding} canReset={canReset} />}
      </div>
      <Field
        orientation={stackControl ? 'vertical' : 'responsive'}
        className="min-w-0"
        data-invalid={binding?.error !== undefined && binding.error !== '' ? true : undefined}
      >
        <FieldContent>
          <FieldLabel>
            <span className="font-medium">
              <HighlightedText text={definition.title} terms={highlightTerms} />
            </span>
          </FieldLabel>
          {definition.description !== undefined && (
            <FieldDescription>
              <HighlightedText text={definition.description} terms={highlightTerms} />
            </FieldDescription>
          )}
          {binding?.error !== undefined && binding.error !== '' && <FieldError>{binding.error}</FieldError>}
        </FieldContent>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {control}
        </div>
      </Field>
    </div>
  );
}
