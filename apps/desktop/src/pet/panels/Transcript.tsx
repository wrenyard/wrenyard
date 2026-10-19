// ── Task transcript panel (React) ─────────────────────────────────────
// Frameless task transcript styled like the Desktop Mini card: a 36px themed
// title bar with the task title, the task type display name and the run
// status, over the shared transcript stream (`renderer/components/task-transcript`)
// that the activity side panel also renders. Only the SafeTranscriptEventData
// allowlist crosses the preload boundary.

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { X } from 'lucide-react';
import { cn } from 'cn';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { runStatusView, TaskTranscriptStream } from '@/renderer/components/task-transcript';
import { petAppearanceBridge, type PetAppearanceApi } from '../shared/appearance';
import type { SafeTaskRunEventsResult, SafeTranscriptEventData, TranscriptRunInfo } from '../shared/taskgraph';

interface TranscriptWindowApi {
  onData: (taskRunId: string, cb: (data: SafeTaskRunEventsResult) => void) => () => void;
  onError: (cb: (message: string) => void) => () => void;
  retry: (taskRunId: string) => Promise<void>;
  close: () => Promise<void>;
}

declare global {
  interface Window {
    transcriptApi: TranscriptWindowApi;
    petAppearance: PetAppearanceApi;
  }
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_TITLE = '任务对话';
const DRAG = '[-webkit-app-region:drag] [app-region:drag]';
const NO_DRAG = '[-webkit-app-region:no-drag] [app-region:no-drag]';

// ── Panel ────────────────────────────────────────────────────────────

type TranscriptState = 'loading' | 'data' | 'empty' | 'error';

/** Current Pet appearance, mirrored synchronously from the preload bridge. */
function usePetAppearance(): { dark: boolean } {
  return useSyncExternalStore(
    (listener) => petAppearanceBridge.subscribe(listener),
    () => petAppearanceBridge.getSnapshot(),
    () => petAppearanceBridge.getSnapshot(),
  );
}

export function Transcript(): ReactElement {
  const [taskRunId] = useState(() => new URLSearchParams(window.location.search).get('task_run_id') ?? '');
  const [taskLabel] = useState(() => (new URLSearchParams(window.location.search).get('task_label') ?? '').trim());
  const [platform] = useState(() => new URLSearchParams(window.location.search).get('platform') ?? '');
  const [events, setEvents] = useState<SafeTranscriptEventData[]>([]);
  const [run, setRun] = useState<TranscriptRunInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const missingRunId = taskRunId.length === 0;
  const appearance = usePetAppearance();
  const onOpenExternal = useCallback((href: string) => {
    void window.petAppearance.openExternal(href);
  }, []);

  const status = runStatusView(run?.status);
  const live = status?.live ?? false;
  const typeName = run?.task_name;
  const title = taskLabel && taskLabel !== DEFAULT_TITLE ? taskLabel : (typeName ?? DEFAULT_TITLE);
  const showType = typeName !== undefined && typeName !== title;

  useEffect(() => {
    document.title = showType ? `${title} · ${typeName}` : title;
  }, [showType, title, typeName]);

  useEffect(() => {
    if (platform) document.documentElement.dataset.platform = platform;
  }, [platform]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.transcriptReady = '1';
    return () => {
      delete root.dataset.transcriptReady;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const state: TranscriptState = error ? 'error' : events.length > 0 ? 'data' : 'empty';
    root.dataset.transcriptState = loading ? 'loading' : state;
  }, [error, events.length, loading]);

  useEffect(() => {
    if (missingRunId) {
      setLoading(false);
      setError('Missing task_run_id');
      return;
    }
    const api = window.transcriptApi;
    if (!api) return;
    const disposeData = api.onData(taskRunId, (data) => {
      setLoading(false);
      setError(null);
      if (data.run) setRun(data.run);
      if (data.events.length > 0) setEvents((current) => [...current, ...data.events]);
    });
    const disposeError = api.onError((message) => {
      setLoading(false);
      setError(message);
    });
    return () => {
      disposeData();
      disposeError();
    };
  }, [missingRunId, taskRunId]);

  const retry = useCallback((): void => {
    setError(null);
    setLoading(true);
    void window.transcriptApi.retry(taskRunId);
  }, [taskRunId]);

  return (
    <div className="relative flex h-screen w-screen flex-col bg-background text-xs text-foreground">
      <header data-titlebar className={cn('flex h-9 shrink-0 items-center gap-2 border-b bg-sidebar pl-3 pr-1.5 text-sidebar-foreground', DRAG)}>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground" title={title}>{title}</span>
        {showType && (
          <Badge variant="secondary" className="min-w-0 max-w-32 shrink-0" title={typeName}>
            <span className="truncate">{typeName}</span>
          </Badge>
        )}
        {status && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', status.dot)} />
            <span className={status.tone}>{status.label}</span>
          </span>
        )}
        <div className={cn('flex shrink-0 items-center', NO_DRAG)}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="hover:text-destructive"
            onClick={() => void window.transcriptApi.close()}
          >
            <X />
          </Button>
        </div>
      </header>

      <TaskTranscriptStream
        events={events}
        live={live}
        loading={loading}
        error={error}
        onRetry={missingRunId ? undefined : retry}
        dark={appearance.dark}
        onOpenExternal={onOpenExternal}
      />
    </div>
  );
}
