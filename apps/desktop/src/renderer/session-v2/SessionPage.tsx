import { useCallback, useMemo, useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/components/ui/resizable';
import { TooltipProvider } from '@/renderer/components/ui/tooltip';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/renderer/components/chat/conversation';
import { Composer } from './components/Composer.js';
import { EmptySession } from './components/EmptySession.js';
import { SessionHeader } from './components/SessionHeader.js';
import { SessionSidebar } from './components/SessionSidebar.js';
import { PendingTurnItem, TurnItem } from './components/TurnItem.js';
import { Inspector, InspectorProvider } from './components/inspector/Inspector.js';
import { fold } from './model/fold.js';
import type { ActionModel, InspectorTarget, SessionApi } from './model/types.js';
import { useSessionController } from './state/use-session-controller.js';
import { useTaskStatus } from './state/use-task-status.js';

const LAYOUT_ID = 'session-v2-shell';

function RunningDispatchTasks({ api, turns, setTasks }: {
  api: SessionApi;
  turns: ReturnType<typeof fold>['turns'];
  setTasks: (tasks: Record<string, import('./model/types.js').SessionV2BridgeTaskBrief>) => void;
}) {
  const actions = useMemo(
    () => turns.flatMap((turn) => turn.status === 'running'
      ? turn.actions.filter((action): action is ActionModel & { taskRunId: string } => action.kind === 'dispatch' && action.status === 'running' && action.taskRunId !== undefined)
      : []),
    [turns],
  );
  useTaskStatus(api, actions, setTasks);
  return null;
}

export function SessionPage({ api }: { api: SessionApi }) {
  const { state, selectSession, newDraft, sendMessage, interruptTurn, removePending, setTasks, clearError } = useSessionController(api);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [target, setTarget] = useState<InspectorTarget | undefined>(undefined);
  const [tab, setTab] = useState('detail');
  const [retry, setRetry] = useState<{ text: string; nonce: number } | undefined>(undefined);

  const model = useMemo(
    () => fold(state.events, state.live, state.tasks, { sessionId: state.selectedId, interrupting: state.interrupting }),
    [state.events, state.live, state.tasks, state.selectedId, state.interrupting],
  );

  const inspect = useCallback((next: InspectorTarget): void => {
    setTarget(next);
    setTab('detail');
    setInspectorOpen(true);
  }, []);

  const inspectTimeline = useCallback((next: InspectorTarget): void => {
    setTarget(next);
    setTab('timeline');
    setInspectorOpen(true);
  }, []);

  const panelIds = inspectorOpen ? ['sidebar', 'main', 'inspector'] : ['sidebar', 'main'];
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: LAYOUT_ID, panelIds, storage: window.localStorage });

  const selectedTitle = state.sessions.find((session) => session.sessionId === state.selectedId)?.title ?? '新会话';
  const draft = state.selectedId === '';
  const empty = draft || (!state.loadingLedger && model.turns.length === 0 && state.pending.length === 0);

  const composer = (
    <Composer
      models={state.models}
      turns={model.turns}
      sessionKey={state.selectedId === '' ? 'draft' : state.selectedId}
      disabled={state.loadingLedger}
      onSend={(text, entry, effort) => sendMessage(text, entry, effort)}
      injectedText={retry}
    />
  );

  return (
    <TooltipProvider>
      <InspectorProvider target={target} inspect={inspect} inspectTimeline={inspectTimeline}>
        <RunningDispatchTasks api={api} turns={model.turns} setTasks={setTasks} />
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="h-full min-h-0"
        >
          <ResizablePanel id="sidebar" defaultSize={240} minSize={180} collapsible collapsedSize={0}>
            <SessionSidebar
              sessions={state.sessions}
              selectedId={state.selectedId}
              loading={state.loadingList}
              running={model.runningTurns > 0}
              onSelect={(sessionId) => { void selectSession(sessionId).catch(() => undefined); }}
              onNew={newDraft}
            />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="main" minSize={360} className="flex min-h-0 flex-col">
            <SessionHeader
              title={selectedTitle}
              snapshot={model.snapshot}
              runningTurns={model.runningTurns}
              inspectorOpen={inspectorOpen}
              error={state.error}
              onToggleInspector={() => setInspectorOpen((value) => !value)}
              onDismissError={clearError}
            />
            {empty ? (
              <EmptySession>{composer}</EmptySession>
            ) : (
              <>
                <Conversation>
                  <ConversationContent className="mx-auto w-full max-w-3xl">
                    {model.turns.map((turn) => (
                      <TurnItem key={turn.id} turn={turn} onInterrupt={(id) => { void interruptTurn(id); }} />
                    ))}
                    {state.pending.map((pending) => (
                      <PendingTurnItem
                        key={pending.localId}
                        pending={pending}
                        onRetry={(text) => setRetry({ text, nonce: Date.now() })}
                        onRemove={removePending}
                      />
                    ))}
                  </ConversationContent>
                  <ConversationScrollButton />
                </Conversation>
                <div className="mx-auto w-full max-w-3xl px-4 pb-4">{composer}</div>
              </>
            )}
          </ResizablePanel>
          {inspectorOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel id="inspector" defaultSize={360} minSize={320} className="min-h-0">
                <Inspector
                  model={model}
                  events={state.events}
                  target={target}
                  tab={tab}
                  onTabChange={setTab}
                  onSelect={inspect}
                  onClose={() => setInspectorOpen(false)}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </InspectorProvider>
    </TooltipProvider>
  );
}
