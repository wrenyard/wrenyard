import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { Alert, AlertAction, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/components/ui/resizable';
import { SidebarProvider } from '@/renderer/components/ui/sidebar';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/renderer/components/ui/message-scroller';
import { Page } from '@/renderer/components/page';
import { getSessionApi } from './api.js';
import { Composer } from './components/Composer.js';
import { EmptySession } from './components/EmptySession.js';
import { SessionSearch } from './components/SessionSearch.js';
import { SessionSidebar } from './components/SessionSidebar.js';
import { SessionTopBar } from './components/SessionTopBar.js';
import { PendingTurnItem, TurnItem } from './components/conversation/TurnItem.js';
import { Inspector, InspectorProvider } from './components/inspector/Inspector.js';
import { fold } from './model/fold.js';
import type { ActionModel, InspectorTarget, SessionBridgeTaskBrief } from './model/types.js';
import { useSessionController } from './state/use-session-controller.js';
import { useTaskStatus } from './state/use-task-status.js';

const LAYOUT_ID = 'session-shell';

function RunningDispatchTasks({ api, turns, setTasks }: {
  api: ReturnType<typeof getSessionApi>;
  turns: ReturnType<typeof fold>['turns'];
  setTasks: (tasks: Record<string, SessionBridgeTaskBrief>) => void;
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

/** The session page: sidebar, conversation and inspector in one resizable shell. */
export function SessionPage() {
  const api = getSessionApi();
  const { state, selectSession, newDraft, sendMessage, interruptTurn, removePending, setTasks, clearError } = useSessionController(api);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [target, setTarget] = useState<InspectorTarget | undefined>(undefined);
  const [tab, setTab] = useState('detail');
  const [retry, setRetry] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const sidebarPanel = usePanelRef();

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
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: LAYOUT_ID, panelIds, storage: localStorage });

  // Keep the controlled sidebar state and the collapsible panel in sync.
  useEffect(() => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (sidebarOpen) panel.expand();
    else panel.collapse();
  }, [sidebarOpen, sidebarPanel]);

  // Page-scoped Cmd/Ctrl+B: stop the outer shell provider from also toggling.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return;
      if (document.visibilityState !== 'visible') return;
      event.preventDefault();
      event.stopPropagation();
      setSidebarOpen((value) => !value);
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  // Cmd/Ctrl+K opens search while this Activity is visible; hide closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') setSearchOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const selectedSession = state.sessions.find((session) => session.sessionId === state.selectedId);
  const selectedTitle = selectedSession?.title ?? '新会话';
  const draft = state.selectedId === '';
  const empty = draft || (!state.loadingLedger && model.turns.length === 0 && state.pending.length === 0);
  const sessionKey = state.selectedId === '' ? 'draft' : state.selectedId;

  const composer = (
    <Composer
      models={state.models}
      turns={model.turns}
      sessionKey={sessionKey}
      disabled={state.loadingLedger}
      onSend={(text, entry, effort) => sendMessage(text, entry, effort)}
      injectedText={retry}
    />
  );

  const errorAlert = state.error !== '' ? (
    <Alert variant="destructive">
      <AlertDescription>{state.error}</AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="关闭错误" onClick={clearError}><X /></Button>
      </AlertAction>
    </Alert>
  ) : null;

  return (
    <Page data-page="session">
      <InspectorProvider target={target} inspect={inspect} inspectTimeline={inspectTimeline}>
        <RunningDispatchTasks api={api} turns={model.turns} setTasks={setTasks} />
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="h-full min-h-0">
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
            className="h-full min-h-0"
          >
            <ResizablePanel
              id="sidebar"
              defaultSize={256}
              minSize={200}
              collapsible
              collapsedSize={0}
              groupResizeBehavior="preserve-pixel-size"
              panelRef={sidebarPanel}
              onResize={(size) => setSidebarOpen(size.inPixels > 0)}
            >
              <SessionSidebar
                sessions={state.sessions}
                selectedId={state.selectedId}
                loading={state.loadingList}
                running={model.runningTurns > 0}
                onSelect={(sessionId) => { void selectSession(sessionId).catch(() => undefined); }}
                onNew={newDraft}
                onSearch={() => setSearchOpen(true)}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="main" className="relative flex min-h-0 flex-col">
              <SessionTopBar
                title={selectedTitle}
                session={selectedSession}
                snapshot={model.snapshot}
                turnCount={model.turns.length}
                draft={draft}
                runningTurns={model.runningTurns}
                inspectorOpen={inspectorOpen}
                onToggleInspector={() => setInspectorOpen((value) => !value)}
              />
              {empty ? (
                <EmptySession>
                  {errorAlert}
                  {composer}
                </EmptySession>
              ) : (
                <>
                  <MessageScrollerProvider key={sessionKey}>
                    <MessageScroller className="min-h-0 flex-1">
                      <MessageScrollerViewport className="scroll-fade-t">
                        <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 pt-(--header-height) pb-4">
                          {model.turns.map((turn, index) => (
                            <TurnItem
                              key={turn.id}
                              turn={turn}
                              previous={index > 0 ? model.turns[index - 1] : undefined}
                              latest={index === model.turns.length - 1 && state.pending.length === 0}
                              onInterrupt={(id) => { void interruptTurn(id); }}
                            />
                          ))}
                          {state.pending.map((pending) => (
                            <PendingTurnItem
                              key={pending.localId}
                              pending={pending}
                              onRetry={(text) => setRetry({ text, nonce: Date.now() })}
                              onRemove={removePending}
                            />
                          ))}
                        </MessageScrollerContent>
                      </MessageScrollerViewport>
                      <MessageScrollerButton />
                    </MessageScroller>
                  </MessageScrollerProvider>
                  <div className="mx-auto w-full max-w-3xl px-4 pb-4">
                    {errorAlert}
                    {composer}
                  </div>
                </>
              )}
            </ResizablePanel>
            {inspectorOpen && (
              <>
                <ResizableHandle />
                <ResizablePanel id="inspector" defaultSize={400} minSize={320} className="min-h-0">
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
        </SidebarProvider>
        <SessionSearch
          open={searchOpen}
          onOpenChange={setSearchOpen}
          sessions={state.sessions}
          onSelect={(sessionId) => { void selectSession(sessionId).catch(() => undefined); }}
        />
      </InspectorProvider>
    </Page>
  );
}
