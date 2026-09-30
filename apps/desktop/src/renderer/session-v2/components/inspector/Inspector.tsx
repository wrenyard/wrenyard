import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs';
import type { InspectorTarget, LedgerEvent, SessionModel } from '../../model/types.js';
import { DetailPane } from './DetailPane.js';
import { LedgerList } from './LedgerList.js';

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
  target?: InspectorTarget;
  tab: string;
  onTabChange(tab: string): void;
  onSelect(target: InspectorTarget): void;
  onClose(): void;
}

/** Right-hand inspector: details, turn timeline and the raw ledger. */
export function Inspector({ model, events, target, tab, onTabChange, onSelect, onClose }: InspectorProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <Tabs value={tab} onValueChange={(value) => onTabChange(String(value))} className="flex h-full min-h-0 flex-col gap-0">
        <TabsList variant="line" className="m-2 w-fit">
          <TabsTrigger value="detail">详情</TabsTrigger>
          <TabsTrigger value="ledger">账本</TabsTrigger>
        </TabsList>
        <TabsContent value="detail" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <DetailPane model={model} target={target} onSelect={onSelect} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="ledger" className="min-h-0 flex-1">
          <LedgerList model={model} events={events} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
