import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PanelRight, X } from 'lucide-react';
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
  useMessageScroller,
} from '@/renderer/components/ui/message-scroller';
import { Page, PageHeader, PageTitle, TitleBarAuxiliary } from '@/renderer/components/page';
import { registerPageCommands } from '@/renderer/lib/commands';
import { openMiniCard, restoreMain, setCurrentSession, useMiniMode } from '@/renderer/lib/mini';
import { useNewItemKeys } from '@/renderer/lib/motion';
import { useNavLocation, useSecondarySidebar } from '@/renderer/lib/navigation';
import { getSessionApi } from './api.js';
import { Composer } from './components/Composer.js';
import { EmptySession } from './components/EmptySession.js';
import { SessionSearch } from './components/SessionSearch.js';
import { SessionSidebar } from './components/SessionSidebar.js';
import { SessionTitle } from './components/SessionTitle.js';
import { SessionStatusItems } from './components/status/SessionStatusItems.js';
import { MessageTimeline, buildMessageTimeline } from './components/conversation/MessageTimeline.js';
import { withReplyQuote } from './components/conversation/UserMessage.js';
import { Inspector, InspectorProvider } from './components/inspector/Inspector.js';
import { fold } from './model/fold.js';
import type { ActionModel, DraftAttachment, InspectorTarget, SessionBridgeTaskBrief } from './model/types.js';
import { SessionUsageProvider } from './state/session-usage.js';
import { useSessionController } from './state/use-session-controller.js';
import { useTaskStatus } from './state/use-task-status.js';

const LAYOUT_ID = 'session-shell-v3';
/** A card persists under its own id so it never overwrites the shell layout. */
const CARD_LAYOUT_ID = 'session-card-v1';

/** Sending a message resumes bottom following even while reading history. */
function FollowSentMessage({ pendingId }: { pendingId: string | undefined }) {
  const { scrollToEnd } = useMessageScroller();
  useLayoutEffect(() => {
    if (pendingId !== undefined) scrollToEnd({ behavior: 'auto' });
  }, [pendingId, scrollToEnd]);
  return null;
}

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
  const mini = useMiniMode();
  const { state, selectSession, newDraft, sendMessage, deleteSession, removePending, setTasks, clearError } = useSessionController(api);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: mini ? CARD_LAYOUT_ID : LAYOUT_ID, storage: localStorage });
  const [inspectorOpen, setInspectorOpen] = useState(() => (defaultLayout?.inspector ?? 0) > 0);
  const [sidebarOpen, setSidebarOpen] = useState(() => (defaultLayout?.sidebar ?? 1) > 0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [target, setTarget] = useState<InspectorTarget | undefined>(undefined);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [retry, setRetry] = useState<{ text: string; attachments: DraftAttachment[]; nonce: number } | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<{ sessionKey: string; quote: string } | undefined>(undefined);
  const sidebarPanel = usePanelRef();
  const inspectorPanel = usePanelRef();

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

  const inspect = useCallback((next: InspectorTarget): void => {
    setTarget(next);
    setInspectorOpen(true);
  }, []);

  const inspectTimeline = useCallback((next: InspectorTarget): void => {
    setTarget(next);
    setInspectorOpen(true);
  }, []);

  // Keep the controlled sidebar state and the collapsible panel in sync.
  useEffect(() => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (sidebarOpen) panel.expand();
    else panel.collapse();
  }, [sidebarOpen, sidebarPanel]);

  // Keep the controlled inspector state and its always-mounted collapsible
  // panel in sync, mirroring the sidebar above.
  useEffect(() => {
    const panel = inspectorPanel.current;
    if (!panel) return;
    if (inspectorOpen) panel.expand();
    else panel.collapse();
  }, [inspectorOpen, inspectorPanel]);

  // Register the session list as this page's secondary sidebar. The shell
  // title bar and the global Cmd/Ctrl+B command toggle it while this page is
  // the active Activity; hidden pages unregister on effect cleanup.
  useSecondarySidebar({ open: sidebarOpen, setOpen: setSidebarOpen });

  // Publish the shown session so the title bar can open a card for it (shell)
  // or return to it (card). No cleanup: the last value survives a page switch.
  useEffect(() => {
    setCurrentSession(state.selectedId);
  }, [state.selectedId]);

  // Cmd/Ctrl+Shift+M: the shell opens a card for the current session; a card
  // returns to the main window on the same session (a draft when there is none).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== 'm') return;
      event.preventDefault();
      if (mini) restoreMain(state.selectedId);
      else openMiniCard(state.selectedId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mini, state.selectedId]);

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

  // Page commands: session.open (routed here by the command table) and the
  // inspector toggle used by the title bar.
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
      id: 'session.toggleInspector',
      title: '切换检查器',
      run: () => setInspectorOpen((value) => !value),
    },
    {
      id: 'session.newDraft',
      title: '新建对话',
      run: () => {
        newDraft();
        setComposerFocusRequest((value) => value + 1);
      },
    },
  ]), [selectSession, newDraft]);

  // Entry animation applies only to messages appended after the conversation
  // settles; history loads are absorbed into the baseline (foundation §2.3).
  const timeline = useMemo(
    () => buildMessageTimeline(model.turns, state.pending),
    [model.turns, state.pending],
  );
  const messageKeys = useMemo(() => timeline.map((entry) => entry.id), [timeline]);
  const freshMessageKeys = useNewItemKeys(messageKeys, {
    scope: sessionKey,
    ready: !state.loadingLedger,
  });

  const reply = replyTo?.sessionKey === sessionKey ? replyTo.quote : undefined;
  const composer = (
    <Composer
      models={state.models}
      turns={model.turns}
      sessionKey={sessionKey}
      disabled={state.loadingLedger}
      compact={mini}
      draft={draft}
      onSend={async (text, entry, effort, attachments) => {
        await sendMessage(reply === undefined ? text : withReplyQuote(reply, text), entry, effort, attachments);
        setReplyTo(undefined);
      }}
      injectedText={retry}
      focusRequest={composerFocusRequest}
      reply={reply}
      onCancelReply={() => setReplyTo(undefined)}
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
          ledgerReady={sessionKey === 'draft' || !state.loadingLedger}
        >
          <RunningDispatchTasks api={api} turns={model.turns} setTasks={setTasks} />
          <SessionStatusItems />
        <SidebarProvider open={mini ? false : sidebarOpen} onOpenChange={setSidebarOpen} className="h-full min-h-0">
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={mini ? undefined : defaultLayout}
            onLayoutChanged={onLayoutChanged}
            resizeTargetMinimumSize={{ fine: 6, coarse: 20 }}
            className="h-full min-h-0 min-w-0 overflow-hidden"
          >
            {!mini && (
              <>
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
                    onSelect={(sessionId) => { void selectSession(sessionId).catch(() => undefined); }}
                    onNew={newDraft}
                    onSearch={() => setSearchOpen(true)}
                    onDelete={(sessionId) => { void deleteSession(sessionId).catch(() => undefined); }}
                  />
                </ResizablePanel>
                <ResizableHandle
                  className="w-1.5 bg-transparent after:w-px after:bg-border"
                  onPointerDown={() => setResizing(true)}
                />
              </>
            )}
            <ResizablePanel
              id="main"
              minSize={mini ? 0 : 340}
              className={cn('relative flex min-h-0 flex-col', panelMotion)}
            >
              {empty ? (
                <EmptySession>
                  {errorAlert}
                  {composer}
                </EmptySession>
              ) : (
                <>
                  <MessageScrollerProvider key={sessionKey} autoScroll>
                    <MessageScroller className={cn('min-h-0 flex-1', conversationEnter && 'motion-conversation-enter')}>
                      <MessageScrollerViewport className="scroll-fade-t">
                        <MessageScrollerContent className={cn('w-full gap-2 pt-(--header-height) pb-4', mini ? 'px-3' : 'mx-auto max-w-3xl px-4')}>
                          <MessageTimeline
                            timeline={timeline}
                            turns={model.turns}
                            sessionId={state.selectedId}
                            freshMessageKeys={freshMessageKeys}
                            onRetry={(text, attachments) => setRetry({ text, attachments, nonce: Date.now() })}
                            onRemove={removePending}
                            onReply={(quote) => {
                              setReplyTo({ sessionKey, quote });
                              setComposerFocusRequest((value) => value + 1);
                            }}
                          />
                        </MessageScrollerContent>
                      </MessageScrollerViewport>
                      <FollowSentMessage pendingId={state.pending.at(-1)?.localId} />
                      <MessageScrollerButton />
                    </MessageScroller>
                  </MessageScrollerProvider>
                  <div className={cn('w-full', mini ? 'px-4 pt-2 pb-5' : 'mx-auto max-w-3xl px-4 pb-4')}>
                    {errorAlert}
                    {composer}
                  </div>
                </>
              )}
            </ResizablePanel>
            {!mini && (
              <>
                <ResizableHandle
                  className={cn('w-1.5 bg-transparent after:w-px after:bg-border', !inspectorOpen && 'invisible pointer-events-none')}
                  onPointerDown={() => setResizing(true)}
                />
                <ResizablePanel
                  id="inspector"
                  defaultSize="45%"
                  minSize={280}
                  collapsible
                  collapsedSize={0}
                  groupResizeBehavior="preserve-pixel-size"
                  panelRef={inspectorPanel}
                  className={cn('min-h-0', panelMotion)}
                  onResize={(size) => setInspectorOpen(size.inPixels > 0)}
                >
                  <Inspector
                    model={model}
                    events={state.events}
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
