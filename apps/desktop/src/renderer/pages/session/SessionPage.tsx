import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, ScrollText, X } from 'lucide-react';
import { cn } from 'cn';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, AlertAction, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
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
import { markSessionSeen } from '@/renderer/lib/session-seen';
import { useNewItemKeys } from '@/renderer/lib/motion';
import { setActiveSession, useNavLocation } from '@/renderer/lib/navigation';
import { sessionListQueryKey } from '@/renderer/lib/queries';
import { getSessionApi } from './api.js';
import { Composer } from './components/Composer.js';
import { EmptySession } from './components/EmptySession.js';
import { SessionSearch } from './components/SessionSearch.js';
import { SessionTitle } from './components/SessionTitle.js';
import { SessionStatusItems } from './components/status/SessionStatusItems.js';
import { MessageTimeline, buildMessageTimeline } from './components/conversation/MessageTimeline.js';
import { withReplyQuote } from './components/conversation/UserMessage.js';
import { TranscriptView } from './components/transcript/TranscriptView.js';
import { fold } from './model/fold.js';
import type { ActionModel, DraftAttachment, SessionBridgeTaskBrief } from './model/types.js';
import { SessionUsageProvider } from './state/session-usage.js';
import { useSessionController } from './state/use-session-controller.js';
import { useTaskStatus } from './state/use-task-status.js';

/** The two ways to read the same ledger from the session page. */
type SessionView = 'chat' | 'transcript';
/** The chosen view persists across launches. */
const VIEW_STORAGE_KEY = 'session-view';

/** Accept the `{ sessionId }` object form or a bare id from a routed command. */
function sessionIdFromArgs(args: unknown): string | undefined {
  if (typeof args === 'string') return args;
  if (args !== null && typeof args === 'object' && typeof (args as { sessionId?: unknown }).sessionId === 'string') {
    return (args as { sessionId: string }).sessionId;
  }
  return undefined;
}

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

/** The session page: a chat view and a transcript view of the same ledger, switched from the title bar. */
export function SessionPage() {
  const api = getSessionApi();
  const mini = useMiniMode();
  const queryClient = useQueryClient();
  const { state, selectSession, newDraft, sendMessage, deleteSession, renameSession, removePending, setTasks, clearError, interruptTurn, cancelTask } = useSessionController(api);
  const [view, setView] = useState<SessionView>(() => localStorage.getItem(VIEW_STORAGE_KEY) === 'transcript' ? 'transcript' : 'chat');
  const [searchOpen, setSearchOpen] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [retry, setRetry] = useState<{ text: string; attachments: DraftAttachment[]; nonce: number } | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<{ sessionKey: string; quote: string } | undefined>(undefined);

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

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

  const onInterrupt = useCallback((turn: number): void => {
    void interruptTurn(turn);
  }, [interruptTurn]);

  // Publish the shown session so the title bar can open a card for it (shell)
  // or return to it (card), and so the shell sidebar highlights it. No cleanup:
  // the last value survives a page switch.
  useEffect(() => {
    setCurrentSession(state.selectedId);
    setActiveSession(state.selectedId);
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

  // Mark the shown session as seen while this window is visible and focused.
  // Re-runs on selection, on that session's new result, and on focus changes,
  // in both the main window and a mini card. A draft (empty id) is never marked.
  const selectedFinishedAt = selectedSession?.lastTurn?.finishedAt;
  useEffect(() => {
    const mark = (): void => {
      if (state.selectedId === '') return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      markSessionSeen(state.selectedId);
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [state.selectedId, selectedFinishedAt]);

  // The shell sidebar reads its own query cache, so a pushed `session.titled`
  // (automatic title generation or another client) must invalidate it. Tracking
  // the newest titled seq fires once per new event instead of every render.
  const titledSeq = useMemo(() => {
    let newest = 0;
    for (const event of state.events) {
      if (event.type === 'session.titled' && event.seq > newest) newest = event.seq;
    }
    return newest;
  }, [state.events]);
  useEffect(() => {
    if (titledSeq === 0) return;
    void queryClient.invalidateQueries({ queryKey: sessionListQueryKey });
  }, [titledSeq, queryClient]);

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

  // Page commands: session.open (routed here by the command table), the
  // view switch used by the title bar, and the shell sidebar's search and
  // delete rows, which reuse this page's search state and delete workflow.
  useEffect(() => registerPageCommands('session', [
    {
      id: 'session.open',
      title: '打开会话',
      run: (args) => {
        const sessionId = sessionIdFromArgs(args);
        if (sessionId) void selectSession(sessionId).catch(() => undefined);
      },
    },
    {
      id: 'session.toggleView',
      title: '切换会话视图',
      run: () => setView((value) => (value === 'chat' ? 'transcript' : 'chat')),
    },
    {
      id: 'session.newDraft',
      title: '新建对话',
      run: () => {
        newDraft();
        setComposerFocusRequest((value) => value + 1);
      },
    },
    {
      id: 'session.search',
      title: '搜索对话',
      run: () => setSearchOpen(true),
    },
    {
      id: 'session.delete',
      title: '删除对话',
      run: (args) => {
        const sessionId = sessionIdFromArgs(args);
        if (!sessionId) return;
        // The sidebar list cannot see the running flag on its own, so guard the
        // running-session protection here as well as in the row's disabled state.
        if (state.sessions.some((session) => session.sessionId === sessionId && session.running === true)) return;
        void deleteSession(sessionId)
          .then(() => queryClient.invalidateQueries({ queryKey: sessionListQueryKey }))
          .catch(() => undefined);
      },
    },
  ]), [selectSession, newDraft, deleteSession, state.sessions, queryClient]);

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
      onSend={async (text, entry, effort, attachments) => {
        await sendMessage(reply === undefined ? text : withReplyQuote(reply, text), entry, effort, attachments);
        setReplyTo(undefined);
      }}
      injectedText={retry}
      focusRequest={composerFocusRequest}
      onFocusRequestHandled={() => setComposerFocusRequest(0)}
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
            key={sessionKey}
            title={selectedTitle}
            session={selectedSession}
            draft={draft}
            onRename={selectedSession === undefined
              ? undefined
              : (title) => renameSession(selectedSession.sessionId, title)
                .then(() => queryClient.invalidateQueries({ queryKey: sessionListQueryKey }))}
          />
        </PageTitle>
      </PageHeader>
      <TitleBarAuxiliary>
        <ToggleGroup
          aria-label="会话视图"
          variant="outline"
          size="sm"
          spacing={0}
          value={[view]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === 'chat' || value === 'transcript') setView(value);
          }}
        >
          <Tooltip>
            <TooltipTrigger render={(<ToggleGroupItem value="chat" aria-label="对话视图" />)}>
              <MessageCircle />
            </TooltipTrigger>
            <TooltipContent>对话视图</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={(<ToggleGroupItem value="transcript" aria-label="详细视图" />)}>
              <ScrollText />
            </TooltipTrigger>
            <TooltipContent>详细视图</TooltipContent>
          </Tooltip>
        </ToggleGroup>
      </TitleBarAuxiliary>
      <SessionUsageProvider
        sessionKey={sessionKey}
        models={state.models}
        events={state.events}
        turns={model.turns}
        ledgerReady={sessionKey === 'draft' || !state.loadingLedger}
      >
        <RunningDispatchTasks api={api} turns={model.turns} setTasks={setTasks} />
        <SessionStatusItems />
        <div className="relative flex min-h-0 flex-1 flex-col">
          {empty ? (
            <EmptySession>
              {errorAlert}
              {composer}
            </EmptySession>
          ) : (
            <>
              <MessageScrollerProvider key={`${sessionKey}:${view}`} autoScroll>
                <MessageScroller className={cn('min-h-0 flex-1', conversationEnter && 'motion-conversation-enter')}>
                  <MessageScrollerViewport className="scroll-fade-y">
                    <MessageScrollerContent className={cn('w-full pt-(--header-height) pb-4', view === 'transcript' ? 'gap-6' : 'gap-2', mini ? 'px-3' : 'mx-auto max-w-3xl px-4')}>
                      {view === 'transcript' ? (
                        <TranscriptView
                          turns={model.turns}
                          pending={state.pending}
                          sessionId={state.selectedId}
                          onInterrupt={onInterrupt}
                          onCancelTask={cancelTask}
                        />
                      ) : (
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
                      )}
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
        </div>
        <SessionSearch
          open={searchOpen}
          onOpenChange={setSearchOpen}
          sessions={state.sessions}
          onSelect={(sessionId) => { void selectSession(sessionId).catch(() => undefined); }}
        />
      </SessionUsageProvider>
    </Page>
  );
}
