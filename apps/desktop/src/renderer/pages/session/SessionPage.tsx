import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader, PanelRight, X } from 'lucide-react';
import { cn } from 'cn';
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { Alert, AlertAction, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/components/ui/resizable';
import { SidebarProvider } from '@/renderer/components/ui/sidebar';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/renderer/components/ui/message-scroller';
import { Page, PageDescription, PageHeader, PageTitle, TitleBarAuxiliary } from '@/renderer/components/page';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import { registerPageCommands } from '@/renderer/lib/commands';
import { useStatusBarItem } from '@/renderer/lib/statusbar';
import { formatSnapshotStamp } from '@/renderer/lib/format';
import { useNewItemKeys } from '@/renderer/lib/motion';
import { useNavLocation, useSecondarySidebar } from '@/renderer/lib/navigation';
import { getSessionApi } from './api.js';
import { Composer } from './components/Composer.js';
import { Conversation } from './components/conversation/Conversation.js';
import { EmptySession } from './components/EmptySession.js';
import { SessionSearch } from './components/SessionSearch.js';
import { SessionSidebar } from './components/SessionSidebar.js';
import { SessionTitle } from './components/SessionTitle.js';
import { PendingTurnItem, TurnItem } from './components/conversation/TurnItem.js';
import { Inspector, InspectorProvider } from './components/inspector/Inspector.js';
import { fold } from './model/fold.js';
import type { ActionModel, InspectorTarget, SessionBridgeTaskBrief } from './model/types.js';
import { SessionUsageProvider } from './state/session-usage.js';
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

  // Panel collapse animates at `slow`; while a resize handle is dragged the
  // transition is suspended so dragging stays instant (foundation §2.3).
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    if (!resizing) return;
    const stop = (): void => setResizing(false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [resizing]);
  const panelMotion = resizing ? undefined : 'motion-panel';

  // The conversation fades in on a session switch; the first appearance is not
  // animated. The message scroller remounts per session, so the class replays.
  const [conversationEnter, setConversationEnter] = useState(false);
  const previousSession = useRef(state.selectedId);
  useLayoutEffect(() => {
    if (previousSession.current === state.selectedId) return;
    previousSession.current = state.selectedId;
    setConversationEnter(true);
  }, [state.selectedId]);

  const model = useMemo(
    () => fold(state.events, state.live, state.tasks, { sessionId: state.selectedId, interrupting: state.interrupting }),
    [state.events, state.live, state.tasks, state.selectedId, state.interrupting],
  );

  // Target the newest running turn, which can precede a later completed turn.
  const scrollToLatestRunningTurn = useCallback((): void => {
    const turn = [...model.turns].reverse().find((candidate) => candidate.status === 'running');
    if (!turn) return;
    const anchor = document.querySelector<HTMLElement>(`[data-turn-id="${turn.id}"]`);
    anchor?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [model.turns]);

  useStatusBarItem({
    id: 'session.turns',
    side: 'end',
    priority: 100,
    render: () => (model.runningTurns > 0
      ? (
        <StatusBarButton
          icon={Loader}
          label={`${model.runningTurns} 轮运行中`}
          tooltip="滚动到最近的运行中轮次"
          onClick={scrollToLatestRunningTurn}
        />
      )
      : null),
  });

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

  // Register the session list as this page's secondary sidebar. The shell
  // title bar and the global Cmd/Ctrl+B command toggle it while this page is
  // the active Activity; hidden pages unregister on effect cleanup.
  useSecondarySidebar({ open: sidebarOpen, setOpen: setSidebarOpen });

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

  // Record the selected session in the shell history. Restoring a session that
  // is no longer in the loaded list returns false so the history skips it.
  useNavLocation({ sessionId: state.selectedId }, (restored) => {
    const sessionId = restored.sessionId ?? '';
    if (sessionId === '') {
      newDraft();
      return true;
    }
    if (!state.sessions.some((session) => session.sessionId === sessionId)) return false;
    void selectSession(sessionId).catch(() => undefined);
    return true;
  });

  // Open the inspector for a usage request, selecting the session first when
  // the request targets a different one.
  const inspectRequest = useCallback((request: { sessionKey: string; tab: 'context' | 'ledger'; seq?: number }): void => {
    if (request.sessionKey !== sessionKey) {
      if (!state.sessions.some((session) => session.sessionId === request.sessionKey)) return;
      void selectSession(request.sessionKey).catch(() => undefined);
    }
    setTab(request.tab);
    setInspectorOpen(true);
  }, [sessionKey, state.sessions, selectSession]);

  // Page commands: session.open (routed here by the command table),
  // session.inspectContext and the inspector toggle used by the title bar.
  useEffect(() => registerPageCommands('session', [
    {
      id: 'session.open',
      title: '打开会话',
      run: (args) => {
        const sessionId = typeof args === 'string'
          ? args
          : args !== null && typeof args === 'object'
            && typeof (args as { sessionId?: unknown }).sessionId === 'string'
            ? (args as { sessionId: string }).sessionId
            : undefined;
        if (sessionId) void selectSession(sessionId).catch(() => undefined);
      },
    },
    {
      id: 'session.inspectContext',
      title: '查看上下文',
      run: (args) => {
        const options = args !== null && typeof args === 'object'
          ? (args as { tab?: 'context' | 'ledger'; seq?: number })
          : undefined;
        inspectRequest({
          sessionKey,
          tab: options?.tab ?? 'context',
          ...(options?.seq === undefined ? {} : { seq: options.seq }),
        });
      },
    },
    {
      id: 'session.toggleInspector',
      title: '切换检查器',
      run: () => setInspectorOpen((value) => !value),
    },
  ]), [selectSession, sessionKey, inspectRequest]);

  // Entry animation applies only to messages appended after the conversation
  // settles; history loads are absorbed into the baseline (foundation §2.3).
  const messageKeys = useMemo(() => {
    const keys: string[] = [];
    for (const turn of model.turns) {
      keys.push(`u:${turn.id}`);
      if (turn.final !== undefined || turn.status !== 'running') keys.push(`a:${turn.id}`);
    }
    return keys;
  }, [model.turns]);
  const freshMessageKeys = useNewItemKeys(messageKeys, {
    scope: sessionKey,
    ready: !state.loadingLedger,
  });

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
      <PageHeader>
        <PageTitle>
          <SessionTitle
            title={selectedTitle}
            session={selectedSession}
            snapshot={model.snapshot}
            turnCount={model.turns.length}
            draft={draft}
          />
        </PageTitle>
        {!draft && model.snapshot && (
          <PageDescription className="truncate">快照 {formatSnapshotStamp(model.snapshot.takenAt)}</PageDescription>
        )}
      </PageHeader>
      <TitleBarAuxiliary>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={inspectorOpen ? '关闭检查器' : '打开检查器'}
                aria-pressed={inspectorOpen}
                onClick={() => setInspectorOpen((value) => !value)}
              />
            )}
          >
            <PanelRight />
          </TooltipTrigger>
          <TooltipContent>{inspectorOpen ? '关闭检查器' : '打开检查器'}</TooltipContent>
        </Tooltip>
      </TitleBarAuxiliary>
      <InspectorProvider target={target} inspect={inspect} inspectTimeline={inspectTimeline}>
        <SessionUsageProvider
          sessionKey={sessionKey}
          models={state.models}
          events={state.events}
          turns={model.turns}
          onInspect={inspectRequest}
        >
          <RunningDispatchTasks api={api} turns={model.turns} setTasks={setTasks} />
        <Conversation sessionKey={sessionKey} turns={model.turns} ready={!state.loadingLedger} />
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="h-full min-h-0">
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
            resizeTargetMinimumSize={{ fine: 6, coarse: 20 }}
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
              className={panelMotion}
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
            <ResizableHandle
              className="w-1.5 bg-transparent after:w-px after:bg-border"
              onPointerDown={() => setResizing(true)}
            />
            <ResizablePanel id="main" className={cn('relative flex min-h-0 flex-col', panelMotion)}>
              {empty ? (
                <EmptySession>
                  {errorAlert}
                  {composer}
                </EmptySession>
              ) : (
                <>
                  <MessageScrollerProvider key={sessionKey}>
                    <MessageScroller className={cn('min-h-0 flex-1', conversationEnter && 'motion-conversation-enter')}>
                      <MessageScrollerViewport className="scroll-fade-t">
                        <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 pt-(--header-height) pb-4">
                          {model.turns.map((turn, index) => (
                            <TurnItem
                              key={turn.id}
                              turn={turn}
                              previous={index > 0 ? model.turns[index - 1] : undefined}
                              latest={index === model.turns.length - 1 && state.pending.length === 0}
                              enterUser={freshMessageKeys.has(`u:${turn.id}`)}
                              enterAssistant={freshMessageKeys.has(`a:${turn.id}`)}
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
                <ResizableHandle
                  className="w-1.5 bg-transparent after:w-px after:bg-border"
                  onPointerDown={() => setResizing(true)}
                />
                <ResizablePanel id="inspector" defaultSize={400} minSize={320} className={cn('min-h-0', panelMotion)}>
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
        </SessionUsageProvider>
      </InspectorProvider>
    </Page>
  );
}
