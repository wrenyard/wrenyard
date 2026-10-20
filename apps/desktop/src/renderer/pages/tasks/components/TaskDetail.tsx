import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Alert, AlertAction, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import type {
  TaskSettingsPatch,
  TaskSettingsTaskRow,
} from '@/shell-contract';
import * as copy from '../model/describe.js';
import {
  buildLayerPatch,
  resetPatch,
  taskIdentityLabel,
  taskResolutionFailureMessage,
  taskRuntimeLine,
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
  error,
  successNote,
  onCommit,
  onClearError,
}: TaskDetailProps) {
  const runtimeLine = taskRuntimeLine(row);
  const failure = taskResolutionFailureMessage(row);
  const hasOverrides = Object.keys(row.user_task).length > 0;
  const disabled = busy || loading;
  const inheritanceChain = row.inheritanceChain ?? [];

  const save = (): void => {
    onCommit(buildLayerPatch());
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

        {loading || row.builtin === undefined ? (
          <Skeleton className="min-h-72 flex-1" />
        ) : (
          <TemplatePreview template={row.builtin.instruction_template} className="min-h-72 flex-1" />
        )}
      </div>
    </section>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex min-h-8 items-center text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
