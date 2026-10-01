import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs';
import type { InspectorTarget, LedgerEvent, SessionModel } from '../../model/types.js';
import { useSessionUsage } from '../../state/usage-selection.js';
import { ContextTab } from './ContextTab.js';
import { DetailPane } from './details/DetailPane.js';
import { LedgerList } from './LedgerList.js';
import { TurnTimeline } from './TurnTimeline.js';

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

/** Right-hand inspector: details, turn timeline, the raw ledger and the context audit. */
export function Inspector({ model, events, target, tab, onTabChange, onSelect, onClose }: InspectorProps) {
  // A requested ledger jump (from the usage panel or the context tab) is
  // preserved in the shared store; forward its seq so the ledger focuses it.
  const { inspection, sessionKey } = useSessionUsage();
  const focusSeq = inspection?.sessionKey === sessionKey && inspection.tab === 'ledger' ? inspection.seq : undefined;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs value={tab} onValueChange={(value) => onTabChange(String(value))} className="flex h-full min-h-0 flex-col gap-0">
        <div className="flex h-(--header-height) items-center justify-between px-4">
          <TabsList variant="line">
            <TabsTrigger value="detail">详情</TabsTrigger>
            <TabsTrigger value="timeline">时间线</TabsTrigger>
            <TabsTrigger value="ledger">账本</TabsTrigger>
            <TabsTrigger value="context">上下文</TabsTrigger>
          </TabsList>
          <Button variant="ghost" size="icon" aria-label="关闭检查器" onClick={onClose}><X /></Button>
        </div>
        <TabsContent value="detail" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="p-4">
              <DetailPane model={model} target={target} onSelect={onSelect} />
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="timeline" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="p-4">
              <TurnTimeline model={model} target={target} onSelect={onSelect} />
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="ledger" className="min-h-0 flex-1">
          <div className="flex h-full min-h-0 flex-col p-4">
            <LedgerList key={focusSeq === undefined ? 'ledger' : inspection?.nonce} model={model} events={events} focusSeq={focusSeq} />
          </div>
        </TabsContent>
        <TabsContent value="context" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="p-4">
              <ContextTab model={model} />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
