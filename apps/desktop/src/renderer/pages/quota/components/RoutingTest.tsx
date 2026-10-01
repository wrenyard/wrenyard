import { useEffect, useMemo, useState } from 'react';
import { QueryError } from '@/renderer/components/query-error';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
} from '@/renderer/components/ui/combobox';
import { Field, FieldLabel } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { Switch } from '@/renderer/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/renderer/components/ui/table';
import { cn } from 'cn';
import type { QuotaSnapshot, TaskRoutingTestParams, TaskRoutingTestTask } from '@/shell-contract';
import {
  EXCLUDE_MODELS_LABEL,
  EXCLUDE_PROVIDERS_LABEL,
  EXCLUSION_EMPTY,
  EXPECTED_INTELLIGENCE_LABEL,
  EXPECTED_TPS_LABEL,
  INTELLIGENCE_ANY_LABEL,
  INTELLIGENCE_ANY_VALUE,
  MIN_INTELLIGENCE_LABEL,
  MIN_TPS_LABEL,
  OPTIONAL_PLACEHOLDER,
  OUTPUT_CAP_LABEL,
  OUTPUT_CAP_PLACEHOLDER,
  REQUIRE_IMAGE_LABEL,
  REQUIRE_SEARCH_LABEL,
  ROUTING_EMPTY,
  ROUTING_IMPORT_ERROR_PREFIX,
  ROUTING_RESULT_COLUMNS,
  ROUTING_RUN_ERROR_PREFIX,
  ROUTING_RUN_LABEL,
  ROUTING_RUNNING_LABEL,
  ROUTING_TASK_EMPTY,
  ROUTING_TASK_PLACEHOLDER,
  ROUTING_TITLE,
  errorMessage,
} from '../model/describe.js';
import {
  INTELLIGENCE_LABELS,
  INTELLIGENCE_TIERS,
  defaultRoutingTestForm,
  formFromTask,
  routingTestErrorMessage,
  routingTestRowCell,
  routingTestTaskLabel,
  serializeRoutingTestRequest,
  type RoutingTestFormState,
} from '../model/routing.js';
import { useRoutingTestRun, useRoutingTestTasksQuery } from '../queries.js';

export interface RoutingTestProps {
  /** Latest quota snapshot, used only for exclusion candidate options. */
  snapshot: QuotaSnapshot | null;
  /** True while the routing panel is visible; gates the lazy task import. */
  active: boolean;
}

interface ExclusionOption {
  id: string;
  label: string;
}

/**
 * Form-first routing test. Imports saved task definitions lazily on first
 * picker open, serializes the typed form, and renders the daemon-owned result.
 * The run request is sent only from an explicit click; nothing here computes
 * routing, ranking or scores.
 */
export function RoutingTest({ snapshot, active }: RoutingTestProps) {
  const [form, setForm] = useState<RoutingTestFormState>(defaultRoutingTestForm);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState('');
  const [runError, setRunError] = useState('');

  const tasks = useRoutingTestTasksQuery(active && pickerOpen);
  const run = useRoutingTestRun();

  const taskList = tasks.data?.tasks ?? [];
  const taskById = useMemo(() => {
    const map = new Map<string, TaskRoutingTestTask>();
    for (const task of taskList) map.set(task.identity, task);
    return map;
  }, [taskList]);
  const taskIds = useMemo(() => taskList.map((task) => task.identity), [taskList]);
  const labelForTask = (identity: string): string => {
    const task = taskById.get(identity);
    return task ? routingTestTaskLabel(task) : identity;
  };

  const modelOptions = useMemo<ExclusionOption[]>(() => {
    const options: ExclusionOption[] = [];
    const seen = new Set<string>();
    for (const entry of snapshot?.catalog ?? []) {
      for (const model of entry.models ?? []) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        options.push({ id: model.id, label: model.displayName });
      }
    }
    return options;
  }, [snapshot]);

  const providerOptions = useMemo<ExclusionOption[]>(
    () => (snapshot?.catalog ?? []).map((entry) => ({ id: entry.id, label: entry.label })),
    [snapshot],
  );

  const invalidateResult = (): void => {
    run.reset();
    setRunError('');
  };

  // Preserve the old default: once the picker first loads, nothing selected, pick explore.
  useEffect(() => {
    if (!pickerOpen || !tasks.data || selectedTask !== '') return;
    const explore = tasks.data.tasks.find((task) => task.identity === 'builtin:explore');
    if (!explore) return;
    setSelectedTask(explore.identity);
    setForm(formFromTask(explore));
    run.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen, tasks.data]);

  const updateForm = (patch: Partial<RoutingTestFormState>): void => {
    setForm((previous) => ({ ...previous, ...patch }));
    invalidateResult();
  };

  const applyTask = (identity: string): void => {
    const task = taskById.get(identity);
    if (!task) return;
    setForm(formFromTask(task));
    invalidateResult();
  };

  const handleRun = (): void => {
    let params: TaskRoutingTestParams;
    try {
      params = serializeRoutingTestRequest(form);
    } catch (cause) {
      setRunError(errorMessage(cause));
      return;
    }
    setRunError('');
    run.mutate(params, {
      onError: (cause) => setRunError(routingTestErrorMessage(cause)),
    });
  };

  const result = run.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2>{ROUTING_TITLE}</h2>
        <div className="flex items-center gap-2">
          <Combobox
            items={taskIds}
            value={selectedTask === '' ? null : selectedTask}
            onValueChange={(value) => {
              const next = typeof value === 'string' ? value : '';
              setSelectedTask(next);
              if (next !== '') applyTask(next);
            }}
            onOpenChange={(open) => {
              if (open) setPickerOpen(true);
            }}
            itemToStringLabel={(item: string) => labelForTask(item)}
          >
            <ComboboxTrigger render={<Button variant="outline" className="justify-between" />}>
              <ComboboxValue>
                {(current: string | null) => (current ? labelForTask(current) : ROUTING_TASK_PLACEHOLDER)}
              </ComboboxValue>
            </ComboboxTrigger>
            <ComboboxContent className="min-w-64">
              <ComboboxInput showTrigger={false} placeholder={ROUTING_TASK_PLACEHOLDER} />
              <ComboboxEmpty>{ROUTING_TASK_EMPTY}</ComboboxEmpty>
              <ComboboxList>
                {(item: string) => <ComboboxItem key={item} value={item}>{labelForTask(item)}</ComboboxItem>}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <Button type="button" disabled={run.isPending} onClick={handleRun}>
            {run.isPending ? ROUTING_RUNNING_LABEL : ROUTING_RUN_LABEL}
          </Button>
        </div>
      </div>

      {tasks.isError && (
        <QueryError
          query={tasks}
          description={`${ROUTING_IMPORT_ERROR_PREFIX}${errorMessage(tasks.error)}`}
        />
      )}

      <div className="grid gap-3 @3xl/main:grid-cols-2">
        <Field>
          <FieldLabel>{MIN_INTELLIGENCE_LABEL}</FieldLabel>
          <Select
            value={form.intelligenceMin === '' ? INTELLIGENCE_ANY_VALUE : form.intelligenceMin}
            onValueChange={(value) => {
              const next = String(value) === INTELLIGENCE_ANY_VALUE ? '' : String(value);
              const tiers: readonly string[] = INTELLIGENCE_TIERS;
              const patch: Partial<RoutingTestFormState> = { intelligenceMin: next };
              if (next !== '' && tiers.indexOf(form.intelligenceExpected) < tiers.indexOf(next)) {
                patch.intelligenceExpected = next;
              }
              updateForm(patch);
            }}
          >
            <SelectTrigger className="w-full" aria-label={MIN_INTELLIGENCE_LABEL}>
              <SelectValue>
                {(value) => (value === INTELLIGENCE_ANY_VALUE ? INTELLIGENCE_ANY_LABEL : INTELLIGENCE_LABELS[String(value)] ?? String(value))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INTELLIGENCE_ANY_VALUE}>{INTELLIGENCE_ANY_LABEL}</SelectItem>
              {INTELLIGENCE_TIERS.map((tier) => (
                <SelectItem key={tier} value={tier}>{INTELLIGENCE_LABELS[tier]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel>{EXPECTED_INTELLIGENCE_LABEL}</FieldLabel>
          <Select value={form.intelligenceExpected} onValueChange={(value) => updateForm({ intelligenceExpected: String(value) })}>
            <SelectTrigger className="w-full" aria-label={EXPECTED_INTELLIGENCE_LABEL}>
              <SelectValue>
                {(value) => INTELLIGENCE_LABELS[String(value)] ?? String(value)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {INTELLIGENCE_TIERS.map((tier) => (
                <SelectItem key={tier} value={tier}>{INTELLIGENCE_LABELS[tier]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel>{MIN_TPS_LABEL}</FieldLabel>
          <Input
            type="number"
            min={1}
            step={1}
            placeholder={OPTIONAL_PLACEHOLDER}
            value={form.minimumTps}
            onChange={(event) => updateForm({ minimumTps: event.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel>{EXPECTED_TPS_LABEL}</FieldLabel>
          <Input
            type="number"
            min={1}
            step={1}
            placeholder={OPTIONAL_PLACEHOLDER}
            value={form.expectedTps}
            onChange={(event) => updateForm({ expectedTps: event.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel>{OUTPUT_CAP_LABEL}</FieldLabel>
          <Input
            type="number"
            min={0}
            step={0.5}
            placeholder={OUTPUT_CAP_PLACEHOLDER}
            value={form.maxOutputUsdPerMillion}
            onChange={(event) => updateForm({ maxOutputUsdPerMillion: event.target.value })}
          />
        </Field>

        <div className="flex flex-wrap items-end gap-4">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="routing-require-image">
              <Switch
                id="routing-require-image"
                checked={form.requireImage}
                onCheckedChange={(checked) => updateForm({ requireImage: checked })}
              />
              {REQUIRE_IMAGE_LABEL}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="routing-require-search">
              <Switch
                id="routing-require-search"
                checked={form.requireWebSearch}
                onCheckedChange={(checked) => updateForm({ requireWebSearch: checked })}
              />
              {REQUIRE_SEARCH_LABEL}
            </FieldLabel>
          </Field>
        </div>

        <Field>
          <FieldLabel>{EXCLUDE_MODELS_LABEL}</FieldLabel>
          <ExclusionPicker
            options={modelOptions}
            selected={form.excludeModelIds}
            onChange={(next) => updateForm({ excludeModelIds: next })}
            placeholder={EXCLUDE_MODELS_LABEL}
          />
        </Field>

        <Field>
          <FieldLabel>{EXCLUDE_PROVIDERS_LABEL}</FieldLabel>
          <ExclusionPicker
            options={providerOptions}
            selected={form.excludeProviderIds}
            onChange={(next) => updateForm({ excludeProviderIds: next })}
            placeholder={EXCLUDE_PROVIDERS_LABEL}
          />
        </Field>
      </div>

      {runError !== '' && (
        <Alert variant="destructive">
          <AlertDescription>{`${ROUTING_RUN_ERROR_PREFIX}${runError}`}</AlertDescription>
        </Alert>
      )}

      {result && (
        <Table>
          <TableHeader>
            <TableRow>
              {ROUTING_RESULT_COLUMNS.map((column) => (
                <TableHead key={column.id} className="whitespace-nowrap">{column.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={ROUTING_RESULT_COLUMNS.length} className="text-muted-foreground">
                  {ROUTING_EMPTY}
                </TableCell>
              </TableRow>
            ) : (
              result.rows.map((row, index) => (
                <TableRow
                  key={`${row.provider}:${row.model}:${index}`}
                  className={cn(row.rank === null && 'text-muted-foreground')}
                >
                  {ROUTING_RESULT_COLUMNS.map((column) => (
                    <TableCell
                      key={column.id}
                      className={cn(
                        'whitespace-nowrap',
                        column.id !== 'provider' && column.id !== 'model' && column.id !== 'reason' && 'text-right tabular-nums',
                      )}
                    >
                      {routingTestRowCell(row, column.id)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** Multi-select chip combobox for one exclusion list; unknown imported ids stay selectable. */
function ExclusionPicker({
  options,
  selected,
  onChange,
  placeholder,
}: {
  options: ExclusionOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const anchor = useComboboxAnchor();
  const labels = useMemo(() => new Map(options.map((option) => [option.id, option.label])), [options]);
  const ids = useMemo(() => options.map((option) => option.id), [options]);
  const labelFor = (id: string): string => labels.get(id) ?? id;

  return (
    <Combobox
      multiple
      items={ids}
      value={selected}
      onValueChange={(value) => onChange(value as string[])}
      itemToStringLabel={(item: string) => labelFor(item)}
    >
      <ComboboxChips ref={anchor} className="w-full">
        <ComboboxValue>
          {(values: string[]) => (
            <>
              {values.map((value) => (
                <ComboboxChip key={value}>{labelFor(value)}</ComboboxChip>
              ))}
            </>
          )}
        </ComboboxValue>
        <ComboboxChipsInput placeholder={placeholder} />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{EXCLUSION_EMPTY}</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => <ComboboxItem key={item} value={item}>{labelFor(item)}</ComboboxItem>}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
