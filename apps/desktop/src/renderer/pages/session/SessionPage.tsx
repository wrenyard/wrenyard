import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from 'cn';
import { useQueryClient } from '@tanstack/react-query';
import type { LedgerEvent } from '@wrenyard/session';
import { Alert, AlertAction, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/renderer/components/ui/message-scroller';
import { Page, PageHeader, PageTitle } from '@/renderer/components/page';
import { useShellPage } from '@/renderer/lib/desktop';
import { registerPageCommands } from '@/renderer/lib/commands';
import { openMiniCard, restoreMain, setCurrentSession, useMiniMode } from '@/renderer/lib/mini';
import { markSessionSeen } from '@/renderer/lib/session-seen';
import { setActiveSession, useNavLocation } from '@/renderer/lib/navigation';
import { sessionListQueryKey } from '@/renderer/lib/queries';
import { useAgentsQuery } from '../agents/queries.js';
import { getSessionApi } from './api.js';
import { Composer } from './components/Composer.js';
import { EmptySession } from './components/EmptySession.js';
import { SessionSearch } from './components/SessionSearch.js';
import { SessionTitle } from './components/SessionTitle.js';
import { TranscriptView } from './components/transcript/TranscriptView.js';
import { buildMessageTimeline } from './components/conversation/MessageTimeline.js';
import { fold } from './model/fold.js';
import type { TurnWaitingState } from './model/describe.js';
import type { ActionModel, DraftAttachment, SessionBridgeTaskBrief } from './model/types.js';
import { SessionInspector, SessionInspectorToggle } from './components/usage/SessionInspector.js';
import { SessionUsageProvider } from './state/session-usage.js';
import { useSessionController } from './state/use-session-controller.js';
import { useTaskStatus } from './state/use-task-status.js';

/** Accept the `{ sessionId }` object form or a bare id from a routed command. */
function sessionIdFromArgs(args: unknown): string | undefined {
  if (typeof args === 'string') return args;
  if (args !== null && typeof args === 'object' && typeof (args as { sessionId?: unknown }).sessionId === 'string') {
    return (args as { sessionId: string }).sessionId;
  }
  return undefined;
}

/**
 * The active turn's live bounded-recovery waiting state, derived from the
 * session feed: the newest `turn.waiting` event of a turn. A pending wait is
 * cleared only by the same turn's explicit `turn.waiting.cleared` event or its
 * terminal event (`turn.finished` / `turn.interrupted`); any other same-turn
 * event is ignored, and events of other turns are skipped. No local timer is
 * involved.
 */
function waitingStateOf(turn: number, events: readonly LedgerEvent[]): TurnWaitingState | undefined {
  let waiting: Extract<LedgerEvent, { type: 'turn.waiting' }> | undefined;
  for (const event of events) {
    if (event.turn !== turn) continue;
    if (event.type === 'turn.waiting') waiting = event;
    else if (
      event.type === 'turn.waiting.cleared'
      || event.type === 'turn.finished'
      || event.type === 'turn.interrupted'
    ) waiting = undefined;
  }
  return waiting === undefined ? undefined : { reason: waiting.reason, retryAt: waiting.retryAt };
}

/** Sending a message resumes bottom following even while reading history. */
function FollowSentMessage({ pendingId }: { pendingId: string | undefined }) {
  const { scrollToEnd } = useMessageScroller();
  useLayoutEffect(() => {
    if (pendingId !== undefined) scrollToEnd({ behavior: 'auto' });
  }, [pendingId, scrollToEnd]);
  return null;
}

function RunningDispatchTasks({ api, turns, tasks, setTasks }: {
  api: ReturnType<typeof getSessionApi>;
  turns: ReturnType<typeof fold>['turns'];
  tasks: Record<string, SessionBridgeTaskBrief>;
  setTasks: (tasks: Record<string, SessionBridgeTaskBrief>) => void;
}) {
  // Every dispatch that opened a task run needs its brief once — finished and
  // older turns included — while the hook polls only the still-running runs.
  const actions = useMemo(
    () => turns.flatMap((turn) => turn.actions.filter(
      (action): action is ActionModel & { taskRunId: string } => action.kind === 'dispatch' && action.taskRunId !== undefined,
    )),
    [turns],
  );
  useTaskStatus(api, actions, tasks, setTasks);
  return null;
}

/** The session page: the agent transcript of the session ledger. */
export function SessionPage() {
  const agents = useAgentsQuery();
  const botNames = useMemo(
    () => new Map((agents.data?.bots ?? []).map((bot) => [bot.id, bot.name])),
    [agents.data],
  );
  const api = getSessionApi();
  const mini = useMiniMode();
  const page = useShellPage();
  const queryClient = useQueryClient();
  const { state, selectSession, newDraft, sendMessage, deleteSession, renameSession, removePending, setTasks, clearError, interruptTurn, cancelTask } = useSessionController(api);
  const [searchOpen, setSearchOpen] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [retry, setRetry] = useState<{ text: string; attachments: DraftAttachment[]; nonce: number } | undefined>(undefined);

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

  // Retry a ledger load that never produced a snapshot; reselecting the same
  // session keeps whatever is already shown and only refetches.
  const retryLedger = useCallback((): void => {
    void selectSession(state.selectedId).catch(() => undefined);
  }, [selectSession, state.selectedId]);

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
    if (!mini && page !== 'session') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== 'm') return;
      event.preventDefault();
      if (mini) restoreMain(state.selectedId);
      else openMiniCard(state.selectedId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mini, page, state.selectedId]);

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
  const draft = state.selectedId === '';
  // A session id that is known but not yet titled by the list or a pushed
  // `session.titled` is not a new session, so it keeps a neutral label.
  const selectedTitle = selectedSession?.title ?? (draft ? '新会话' : '当前会话');
  // An existing session counts as empty only once its snapshot has confirmed it;
  // until then it is loading, and a load that settled without a snapshot failed.
  const empty = draft || (state.ledgerLoaded && model.turns.length === 0 && state.pending.length === 0);
  const hydrating = !draft && !state.ledgerLoaded && state.loadingLedger;
  const loadFailed = !draft && !state.ledgerLoaded && !state.loadingLedger;
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

  // Page commands: session.open (routed here by the command table), and the
  // shell sidebar's search and delete rows, which reuse this page's search
  // state and delete workflow.
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

  // Idle-notice inputs come from the shown timeline only, never from session
  // list activity: the newest row is any message, while only a user or pending
  // send may mark a dismissal as stale.
  const timeline = useMemo(
    () => buildMessageTimeline(model.turns, state.pending),
    [model.turns, state.pending],
  );
  const newestMessageAt = timeline.at(-1)?.at;
  const latestUserMessageAt = timeline
    .filter((entry) => entry.kind === 'user' || entry.kind === 'pending')
    .at(-1)?.at;

  const composer = (
    <Composer
      models={state.models}
      turns={model.turns}
      sessionKey={sessionKey}
      disabled={!draft && !state.ledgerLoaded}
      latestMessageAt={newestMessageAt}
      latestUserMessageAt={latestUserMessageAt}
      onSend={async (text, entry, effort, fast, attachments) => {
        await sendMessage(text, entry, effort, fast, attachments);
      }}
      injectedText={retry}
      focusRequest={composerFocusRequest}
      onFocusRequestHandled={() => setComposerFocusRequest(0)}
      onInterrupt={onInterrupt}
    />
  );

  const errorAlert = state.error !== '' ? (
    <Alert variant="destructive" className="mb-2">
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
            onRegenerate={selectedSession === undefined
              ? undefined
              : async () => {
                const regenerated = await api.regenerateTitle(selectedSession.sessionId);
                await queryClient.invalidateQueries({ queryKey: sessionListQueryKey });
                return regenerated;
              }}
          />
        </PageTitle>
      </PageHeader>
      <SessionUsageProvider
        sessionKey={sessionKey}
        models={state.models}
        events={state.events}
        turns={model.turns}
        ledgerReady={draft || state.ledgerLoaded}
      >
        <RunningDispatchTasks
          key={sessionKey}
          api={api}
          turns={model.turns}
          tasks={state.tasks}
          setTasks={setTasks}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {/* min-w-0: a flex item defaults to min-width:auto, so wide inline
              content would otherwise push the fixed-width inspector past the
              viewport edge instead of narrowing the transcript. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {empty ? (
              <EmptySession>
                {errorAlert}
                {composer}
              </EmptySession>
            ) : (
              <>
                <MessageScrollerProvider key={sessionKey} autoScroll>
                  <MessageScroller className={cn('min-h-0 flex-1', conversationEnter && 'motion-conversation-enter')}>
                    {/* The scroller owns follow-bottom, so browser scroll anchoring must not compete during streaming. */}
                    <MessageScrollerViewport className="scroll-fade-y [overflow-anchor:none] overflow-x-hidden">
                      <MessageScrollerContent className={cn('w-full pt-(--header-height) pb-4 gap-8', mini ? 'px-3' : 'mx-auto max-w-3xl px-4')}>
                        {hydrating && (
                          <div role="status" className="py-8 text-center text-sm text-muted-foreground">
                            正在载入对话…
                          </div>
                        )}
                        {loadFailed && (
                          <div role="status" className="flex flex-col items-center gap-3 py-8 text-center">
                            <p className="text-sm text-muted-foreground">对话载入失败，请重试。</p>
                            <Button variant="outline" size="sm" onClick={retryLedger}>重试</Button>
                          </div>
                        )}
                        <TranscriptView
                          turns={model.turns}
                          pending={state.pending}
                          botNames={botNames}
                          sessionId={state.selectedId}
                          models={state.models}
                          onCancelTask={cancelTask}
                          onRetry={(text, attachments) => setRetry({ text, attachments, nonce: Date.now() })}
                          onRemove={removePending}
                          waiting={new Map(model.turns.flatMap((turn) => {
                            const waiting = waitingStateOf(turn.id, state.events);
                            return waiting === undefined ? [] : [[turn.id, waiting] as const];
                          }))}
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
          </div>
          {!mini && <SessionInspector draft={draft} usageHydrating={hydrating} />}
        </div>
        {!mini && <SessionInspectorToggle />}
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
