import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useSessionUsage } from '../../state/session-usage.js';
import { X } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Sidebar } from '@/renderer/components/ui/sidebar';
import type { InspectorTarget, LedgerEvent, SessionModel } from '../../model/types.js';
import { SessionTree } from './tree/SessionTree.js';

export interface InspectorContextValue {
  target?: InspectorTarget;
  inspect(target: InspectorTarget): void;
  inspectTimeline?(target: InspectorTarget): void;
}

const InspectorContext = createContext<InspectorContextValue>({ inspect: () => undefined });

/** Access the currently inspected target and the setter from any child. */
export function useInspector(): InspectorContextValue {
  return useContext(InspectorContext);
}

export function InspectorProvider({ children, target, inspect, inspectTimeline }: InspectorContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ target, inspect, inspectTimeline }), [target, inspect, inspectTimeline]);
  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

export interface InspectorProps {
  model: SessionModel;
  events: readonly LedgerEvent[];
  onClose(): void;
}

/** Right-hand inspector for session details. */
export function Inspector({ model, events, onClose }: InspectorProps) {
  const { sessionKey } = useSessionUsage();
  const queuedTaskRuns = useMemo(() => {
    const ids = new Set<string>();
    for (const turn of model.turns) {
      for (const action of turn.actions) {
        if (action.taskRunId !== undefined && action.task?.status === 'queued') ids.add(action.taskRunId);
      }
    }
    return ids;
  }, [model]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Sidebar collapsible="none" className="min-h-0 w-full">
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
          <span className="text-sm font-medium">详情</span>
          <Button variant="ghost" size="icon" aria-label="关闭检查器" onClick={onClose}><X /></Button>
      </div>
      {/* Plain scroller: the tree must be sized by the panel, never by its widest row. */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="min-w-0 p-3 wrap-anywhere">
          <SessionTree key={sessionKey} events={events} queuedTaskRuns={queuedTaskRuns} />
        </div>
          </div>
    </Sidebar>
  );
}
