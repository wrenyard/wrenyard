import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Alert, AlertAction, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/renderer/components/ui/combobox';
import { Input } from '@/renderer/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { cn } from 'cn';
import type {
  RuntimeAliasEntry,
  TaskSettingsMode,
  TaskSettingsPatch,
  TaskSettingsTaskRow,
} from '@/shell-contract';
import * as copy from '../model/describe.js';
import {
  buildLayerPatch,
  explicitReferenceText,
  msToSecondsText,
  resetPatch,
  taskIdentityLabel,
  taskResolutionFailureMessage,
  taskRuntimeLine,
  timeoutHint,
} from '../model/settings.js';
import { useRuntimeAliasesQuery } from '../queries.js';
import { TemplatePreview } from './TemplatePreview.js';

export interface TaskDetailProps {
  row: TaskSettingsTaskRow;
  /** Snapshot-carried aliases used before the scoped alias query resolves. */
  fallbackAliases: RuntimeAliasEntry[];
  loading: boolean;
  busy: boolean;
  /** Bumped by the page after a successful save/reset to re-seed the draft. */
  reseedNonce: number;
  error: string;
  successNote: string;
  onCommit: (patch: TaskSettingsPatch) => void;
  onError: (message: string) => void;
  onClearError: () => void;
}

/** One task's editable settings: selection mode, timeout and explicit runtime. */
export function TaskDetail({
  row,
  fallbackAliases,
  loading,
  busy,
  reseedNonce,
  error,
  successNote,
  onCommit,
  onError,
  onClearError,
}: TaskDetailProps) {
  const [mode, setMode] = useState<TaskSettingsMode>(row.effective.mode.value);
  const [runtime, setRuntime] = useState(() => explicitReferenceText(row.effective.explicit_runtime.value));
  const [timeoutText, setTimeoutText] = useState(() => msToSecondsText(row.user_task.timeout_ms));

  // Re-seed the draft when the selected task changes or the page confirms a
  // successful save/reset. Background refetches and conflict reloads keep the
  // user's in-progress edits intact.
  useEffect(() => {
    setMode(row.effective.mode.value);
    setRuntime(explicitReferenceText(row.effective.explicit_runtime.value));
    setTimeoutText(msToSecondsText(row.user_task.timeout_ms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.identity, reseedNonce]);

  const aliasesQuery = useRuntimeAliasesQuery(mode === 'explicit');
  const aliases = aliasesQuery.data?.aliases ?? fallbackAliases;
  const aliasNames = useMemo(() => aliases.map((entry) => entry.name), [aliases]);

  const runtimeLine = taskRuntimeLine(row);
  const failure = taskResolutionFailureMessage(row);
  const hint = timeoutHint(row);
  const overrideTimeout = row.user_task.timeout_ms;
  const hasOverrides = Object.keys(row.user_task).length > 0;
  const disabled = busy || loading;
  // Read-only definition inheritance: rendered only when the daemon supplies
  // the ordered base→effective chain.
  const inheritanceChain = row.inheritanceChain ?? [];

  const save = (): void => {
    try {
      onCommit(buildLayerPatch(row, mode, runtime, timeoutText, aliases));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{row.display_name}</CardTitle>
            <p className="text-muted-foreground">{taskIdentityLabel(row.identity)}</p>
            {loading ? (
              <Skeleton className="h-4 w-40" />
            ) : runtimeLine !== '' ? (
              <p className="text-muted-foreground">{runtimeLine}</p>
            ) : null}
            {failure !== null ? <p className="text-destructive">{failure}</p> : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <SettingRow label={copy.MODE_LABEL}>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as TaskSettingsMode)}
                disabled={disabled}
              >
                <SelectTrigger className="w-40" aria-label={copy.MODE_LABEL}>
                  <SelectValue>{(value) => copy.taskModeLabel(value as TaskSettingsMode)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">{copy.MODE_AUTOMATIC_LABEL}</SelectItem>
                  <SelectItem value="explicit">{copy.MODE_EXPLICIT_LABEL}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow label={copy.TIMEOUT_LABEL}>
              <Input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                className="w-28"
                placeholder={copy.TIMEOUT_PLACEHOLDER}
                value={timeoutText}
                disabled={disabled}
                aria-label={copy.TIMEOUT_LABEL}
                onChange={(event) => setTimeoutText(event.target.value)}
              />
              <span className="text-muted-foreground">{copy.TIMEOUT_UNIT}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                title={copy.TIMEOUT_RESET_TITLE}
                aria-label={copy.TIMEOUT_RESET_LABEL}
                disabled={disabled || overrideTimeout === undefined || overrideTimeout === null}
                onClick={() => onCommit({ timeout_ms: null })}
              >
                ※
              </Button>
              <span className={cn(hint.overridden ? 'text-foreground' : 'text-muted-foreground')}>
                {hint.text}
              </span>
            </SettingRow>

            {mode === 'explicit' ? (
              <SettingRow label={copy.RUNTIME_LABEL}>
                <Combobox
                  items={aliasNames}
                  value={runtime}
                  inputValue={runtime}
                  onValueChange={(next) => setRuntime(typeof next === 'string' ? next : '')}
                  onInputValueChange={(text) => setRuntime(text)}
                  disabled={disabled}
                >
                  <ComboboxInput
                    className="w-full font-mono"
                    placeholder={copy.RUNTIME_PLACEHOLDER}
                    showClear
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>{copy.RUNTIME_NO_ALIASES}</ComboboxEmpty>
                    <ComboboxList>
                      {(name: string) => <ComboboxItem key={name} value={name}>{name}</ComboboxItem>}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={copy.RUNTIME_HELP_LABEL} />}>
                    ?
                  </TooltipTrigger>
                  <TooltipContent>{copy.RUNTIME_HELP}</TooltipContent>
                </Tooltip>
              </SettingRow>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={disabled || !hasOverrides}
                onClick={() => onCommit(resetPatch(row.user_task))}
              >
                {copy.RESET_LABEL}
              </Button>
              <Button disabled={disabled} onClick={save}>
                {copy.SAVE_LABEL}
              </Button>
            </div>
          </CardContent>
        </Card>

        {inheritanceChain.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{copy.INHERITANCE_TITLE}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {inheritanceChain.map((layer, index) => (
                <div key={`${layer.path}:${index}`} className="flex flex-col gap-1">
                  <span>{copy.inheritanceLayerLabel(layer)}</span>
                  <span className="break-words font-mono text-xs text-muted-foreground">{layer.path}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{copy.PREVIEW_TITLE}</CardTitle>
          </CardHeader>
          <CardContent>
            <TemplatePreview template={row.builtin.instruction_template} />
          </CardContent>
        </Card>

        {error !== '' ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="icon-sm" aria-label={copy.DISMISS_LABEL} onClick={onClearError}>
                <X />
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        {successNote !== '' ? <p className="text-muted-foreground">{successNote}</p> : null}
      </div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
