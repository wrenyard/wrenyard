import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleHelp, RotateCcw, X } from 'lucide-react';
import { Alert, AlertAction, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { cn } from 'cn';
import type {
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
import { TemplatePreview } from './TemplatePreview.js';

export interface TaskDetailProps {
  row: TaskSettingsTaskRow;
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

/** One task's settings panel: header actions, aligned settings grid and a height-bounded template preview. */
export function TaskDetail({
  row,
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
      onCommit(buildLayerPatch(row, mode, runtime, timeoutText));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate font-medium">{row.display_name}</h2>
            <span className="truncate font-mono text-xs text-muted-foreground">{taskIdentityLabel(row.identity)}</span>
          </div>
          {loading ? (
            <Skeleton className="h-4 w-40" />
          ) : runtimeLine !== '' ? (
            <p className="truncate text-xs text-muted-foreground">{runtimeLine}</p>
          ) : null}
          {failure !== null ? <p className="text-xs text-destructive">{failure}</p> : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {successNote !== '' ? <span role="status" className="text-xs text-muted-foreground">{successNote}</span> : null}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !hasOverrides}
            onClick={() => onCommit(resetPatch(row.user_task))}
          >
            {copy.RESET_LABEL}
          </Button>
          <Button size="sm" disabled={disabled} onClick={save}>
            {copy.SAVE_LABEL}
          </Button>
        </div>
      </header>

      {error !== '' ? (
        <div className="border-b px-4 py-3">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="icon-sm" aria-label={copy.DISMISS_LABEL} onClick={onClearError}>
                <X />
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <dl className="grid shrink-0 grid-cols-[minmax(5.5rem,max-content)_minmax(0,1fr)] items-start gap-x-6 gap-y-3">
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

          {mode === 'explicit' ? (
            <SettingRow label={copy.RUNTIME_LABEL}>
              <div className="flex w-full max-w-md min-w-0 items-center gap-1">
                <Input
                  className="w-full font-mono"
                  placeholder={copy.RUNTIME_PLACEHOLDER}
                  value={runtime}
                  disabled={disabled}
                  aria-label={copy.RUNTIME_LABEL}
                  onChange={(event) => setRuntime(event.target.value)}
                />
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={copy.RUNTIME_HELP_LABEL} />}>
                    <CircleHelp />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{copy.RUNTIME_HELP}</TooltipContent>
                </Tooltip>
              </div>
            </SettingRow>
          ) : null}

          <SettingRow label={copy.TIMEOUT_LABEL}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  className="w-24"
                  placeholder={copy.TIMEOUT_PLACEHOLDER}
                  value={timeoutText}
                  disabled={disabled}
                  aria-label={copy.TIMEOUT_LABEL}
                  onChange={(event) => setTimeoutText(event.target.value)}
                />
                <span className="text-muted-foreground">{copy.TIMEOUT_UNIT}</span>
              </div>
              <span className={cn('text-xs', hint.overridden ? 'text-foreground' : 'text-muted-foreground')}>{hint.text}</span>
              {overrideTimeout !== undefined && overrideTimeout !== null ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={copy.TIMEOUT_RESET_TITLE}
                  aria-label={copy.TIMEOUT_RESET_LABEL}
                  disabled={disabled}
                  onClick={() => onCommit({ timeout_ms: null })}
                >
                  <RotateCcw />
                </Button>
              ) : null}
            </div>
          </SettingRow>

          {inheritanceChain.length > 0 ? (
            <SettingRow label={copy.INHERITANCE_TITLE}>
              <ol className="flex w-full min-w-0 flex-col gap-1 py-1.5">
                {inheritanceChain.map((layer, index) => (
                  <li key={`${layer.path}:${index}`} className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0">{copy.inheritanceLayerLabel(layer)}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={layer.path}>{layer.path}</span>
                  </li>
                ))}
              </ol>
            </SettingRow>
          ) : null}
        </dl>

        <TemplatePreview template={row.builtin.instruction_template} className="min-h-72 flex-1" />
      </div>
    </section>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex min-h-8 items-center text-muted-foreground">{label}</dt>
      <dd className="flex min-h-8 min-w-0 items-center">{children}</dd>
    </>
  );
}
