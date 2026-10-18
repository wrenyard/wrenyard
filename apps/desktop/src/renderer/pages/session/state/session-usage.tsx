/**
 * Session usage context: a React context owned by the session page that carries
 * the loaded session projection and the composer selection to sibling session
 * components (the composer, the status bar ctx item). Draft text is
 * persisted through the per-session drafts module; there is no module-level
 * state and no effect-based publishing.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ContextInspection } from '@/shell-contract';
import type { SessionRoutesPreviewResult } from '@wrenyard/protocol';
import type { DraftAttachment, LedgerEvent, ModelEntry, TurnModel } from '../model/types.js';
import { contextInspectSessionId, contextQuery, routesPreviewQuery } from '../queries.js';
import { promptCancel, promptSuggest } from '../api.js';
import { readModelEfforts, type ReasoningEffort } from './reasoning-effort.js';
import { defaultModelEffort, resolveModelEffort } from './reasoning-effort-memory.js';
import { setQuotaFocus } from '@/renderer/lib/statusbar';
import {
  clearDraft,
  clearDraftAttachments,
  flushDraft,
  flushDraftAttachments,
  readDraft,
  readDraftAttachments,
  subscribeDraft,
  writeDraft,
  writeDraftAttachments,
} from './drafts.js';

export interface SessionUsage {
  sessionKey: string;
  models: readonly ModelEntry[];
  events: readonly LedgerEvent[];
  turns: readonly TurnModel[];
  seq: number;
  contextInspection: ContextInspection | undefined;
  contextRoutesPreview: SessionRoutesPreviewResult | undefined;
  modelId: string;
  effort: ReasoningEffort;
  inputText: string;
  /** Debounced composer input token count, shared with the status-bar ctx item. */
  inputTokens: number;
  requestModel(modelId: string): void;
  /** Refresh the shared context inspection and route preview for the active session. */
  refreshContext(): void;
  /** Publish the composer's debounced input token count (or 0 when empty). */
  setInputTokens(tokens: number): void;
}

export interface ComposerSelection {
  modelId: string;
  setModelId(modelId: string): void;
  effort: ReasoningEffort;
  setEffort: Dispatch<SetStateAction<ReasoningEffort>>;
  text: string;
  setText(text: string): void;
  clearText(): void;
  attachments: DraftAttachment[];
  setAttachments(attachments: DraftAttachment[]): void;
  clearAttachments(): void;
  /** Ghost next-input suggestion for the active session; `''` when there is none. */
  suggestion: string;
  /**
   * Record whether the composer may receive a suggestion right now. Called while
   * the composer renders, so a turn completing in the same commit is judged on
   * the current value. Eligibility only gates *new* requests; a shown suggestion
   * is dropped only on an explicit invalidation.
   */
  setSuggestionEligible(eligible: boolean): void;
  /** Accept the suggestion into the draft (never sends it). */
  acceptSuggestion(): void;
  /** Drop the suggestion and cancel any in-flight request. */
  dismissSuggestion(): void;
}

/**
 * A request id that is unique across renderer processes. The standard window and
 * a mini window run in separate processes, so a per-process counter can mint the
 * same id twice and let one surface cancel the other's request.
 */
function newSuggestionRequestId(): string {
  return crypto.randomUUID();
}

interface SessionUsageContextValue extends SessionUsage, ComposerSelection {}

const SessionUsageContext = createContext<SessionUsageContextValue | null>(null);

export interface SessionUsageProviderProps {
  sessionKey: string;
  models: readonly ModelEntry[];
  events: readonly LedgerEvent[];
  turns: readonly TurnModel[];
  ledgerReady: boolean;
  children: ReactNode;
}

/** Owns the session projection and composer selection for the active session. */
export function SessionUsageProvider({ sessionKey, models, events, turns, ledgerReady, children }: SessionUsageProviderProps) {
  // The composer selection is keyed by the active session: switching sessions
  // resets the model (the composer then seeds the destination model's own
  // remembered or default level) and reloads the destination draft during render.
  const [selectionKey, setSelectionKey] = useState(sessionKey);
  const [modelId, setModelId] = useState('');
  // A valid placeholder until the composer seeds the active session's own model
  // and that model's resolved (remembered or default) level.
  const [effort, setEffort] = useState<ReasoningEffort>('medium');
  const [text, setTextState] = useState(() => readDraft(sessionKey));
  const [attachments, setAttachmentsState] = useState<DraftAttachment[]>(() => readDraftAttachments(sessionKey));
  const [inputTokens, setInputTokensState] = useState(0);
  // Ghost next-input suggestion: only the active session's latest completed
  // turn triggers a request, and only while the composer is empty and idle.
  // Keyed by its session so a switch masks the previous session's text during
  // render, before paint.
  const [suggestion, setSuggestionState] = useState<{ sessionKey: string; text: string }>({ sessionKey: '', text: '' });
  const activeSuggestion = suggestion.sessionKey === sessionKey ? suggestion.text : '';
  // The composer's current-render eligibility; a ref, not state, so a completion
  // read in the same commit sees the current value instead of one render behind.
  const suggestionEligibleRef = useRef(false);
  // The request id + draft session key currently awaiting a result. Both are
  // re-checked before a result is shown, so a stale response can never leak into
  // another draft or revive a dismissed suggestion.
  const suggestionPendingRef = useRef<{ id: string; sessionKey: string }>({ id: '', sessionKey: '' });
  // The session + completed-turn marker already requested for; a new session
  // baseline absorbs loaded history so a switch never requests a suggestion.
  const suggestionRequestedRef = useRef<{ identity: string; marker: number }>({ identity: '', marker: 0 });

  if (selectionKey !== sessionKey) {
    setSelectionKey(sessionKey);
    setModelId('');
    setTextState(readDraft(sessionKey));
    setAttachmentsState(readDraftAttachments(sessionKey));
    setInputTokensState(0);
  }

  // Flush the outgoing session's pending draft on switch and on unmount.
  useEffect(() => () => {
    flushDraft(sessionKey);
    flushDraftAttachments(sessionKey);
  }, [sessionKey]);

  // A native close never runs the unmount cleanup, so the last debounce window
  // of typing would be lost; the live session is flushed synchronously here.
  // Hiding the window (switching to another session window) must also flush the
  // pending debounced draft so the destination window reads the latest text.
  useEffect(() => {
    const onBeforeUnload = (): void => {
      flushDraft(sessionKey);
      flushDraftAttachments(sessionKey);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'hidden') return;
      flushDraft(sessionKey);
      flushDraftAttachments(sessionKey);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sessionKey]);

  // The other window of the same session (shell and card are separate
  // renderers) writes the draft to storage; re-read so the newer text and
  // attachments replace this renderer's copy. The subscription already dropped
  // the stale caches and pending timers, so these reads see the stored values
  // and nothing is written back from here.
  useEffect(() => subscribeDraft(sessionKey, () => {
    setTextState(readDraft(sessionKey));
    setAttachmentsState(readDraftAttachments(sessionKey));
  }), [sessionKey]);

  // Publish the quota provider of the composer's currently selected model so
  // the status-bar quota item focuses it. Cleared when the page hides (effect
  // cleanup) or when the selection carries no quota provider.
  useEffect(() => {
    setQuotaFocus(models.find((entry) => entry.publicId === modelId)?.quotaProvider ?? null);
    return () => setQuotaFocus(null);
  }, [models, modelId]);

  const seq = useMemo(() => {
    let latest = 0;
    for (const event of events) if (event.seq > latest) latest = event.seq;
    return latest;
  }, [events]);

  const contextQueryObserver = useQuery(contextQuery(sessionKey, modelId));
  const routesQueryObserver = useQuery(routesPreviewQuery(sessionKey));
  const identity = `${sessionKey}\u0000${modelId}`;
  const contextInspection = contextQueryObserver.data?.model.publicId === modelId ? contextQueryObserver.data : undefined;
  const contextRoutesPreview = routesQueryObserver.data;
  const completionMarker = useMemo(() => events.reduce((latest, event) =>
    (event.type === 'reasoning.completed' || event.type === 'turn.finished')
      ? Math.max(latest, event.seq)
      : latest, 0), [events]);
  // The newest durable completion of a completed turn; a suggestion is requested
  // once per new value of this marker.
  const completedTurnMarker = useMemo(() => events.reduce((latest, event) =>
    (event.type === 'turn.finished' && event.status === 'completed')
      ? Math.max(latest, event.seq)
      : latest, 0), [events]);
  // A draft has no persisted ledger, so it can never receive a suggestion.
  const suggestionSessionId = contextInspectSessionId(sessionKey);
  const latestCompletionMarker = useRef(completionMarker);
  latestCompletionMarker.current = completionMarker;
  const coordinator = useRef({ identity: '', active: false, busy: false, pending: false, marker: 0 });
  const runRefresh = useCallback(async (): Promise<void> => {
    const gate = coordinator.current;
    if (!gate.active) return;
    if (gate.busy) {
      gate.pending = true;
      return;
    }
    gate.busy = true;
    try {
      do {
        gate.pending = false;
        await Promise.allSettled([
          Promise.resolve().then(() => contextQueryObserver.refetch({ cancelRefetch: false })),
          Promise.resolve().then(() => routesQueryObserver.refetch({ cancelRefetch: false })),
        ]);
      } while (coordinator.current === gate && gate.active && gate.pending);
    } finally {
      gate.busy = false;
    }
  }, [contextQueryObserver.refetch, routesQueryObserver.refetch]);
  const refreshContext = useCallback(() => {
    void runRefresh();
  }, [runRefresh]);
  // Only session/model activation owns the lifetime of a refresh gate.
  useEffect(() => {
    const gate = {
      identity,
      active: ledgerReady && modelId !== '',
      busy: false,
      pending: false,
      marker: latestCompletionMarker.current,
    };
    coordinator.current = gate;
    if (gate.active) void runRefresh();
    return () => {
      gate.active = false;
      gate.pending = false;
    };
  }, [identity, ledgerReady, modelId, runRefresh]);

  // Completed reasoning/turn markers refresh without tearing down the gate.
  useEffect(() => {
    const gate = coordinator.current;
    if (!gate.active || gate.identity !== identity || completionMarker <= gate.marker) return;
    gate.marker = completionMarker;
    void runRefresh();
  }, [completionMarker, identity, runRefresh]);

  const setText = useCallback((next: string) => {
    setTextState(next);
    writeDraft(sessionKey, next);
  }, [sessionKey]);

  const clearText = useCallback(() => {
    setTextState('');
    clearDraft(sessionKey);
  }, [sessionKey]);

  const setAttachments = useCallback((next: DraftAttachment[]) => {
    setAttachmentsState(next);
    writeDraftAttachments(sessionKey, next);
  }, [sessionKey]);

  const clearAttachments = useCallback(() => {
    setAttachmentsState([]);
    clearDraftAttachments(sessionKey);
  }, [sessionKey]);

  // The composer publishes its debounced input count so the status-bar context
  // item can include the draft input in the same budget the composer blocks on.
  const setInputTokens = useCallback((next: number) => {
    setInputTokensState(next);
  }, []);

  // ── ghost next-input suggestion ─────────────────────────────────────────
  /** Drop the current suggestion and cancel its in-flight request, if any. */
  const dismissSuggestion = useCallback((): void => {
    const pending = suggestionPendingRef.current;
    suggestionPendingRef.current = { id: '', sessionKey: '' };
    setSuggestionState({ sessionKey: '', text: '' });
    if (pending.id !== '' && pending.sessionKey !== '') {
      void promptCancel({ sessionId: pending.sessionKey, requestId: pending.id }).catch(() => undefined);
    }
  }, []);

  /**
   * Hiding this surface (the standard window sitting behind a mini card) only
   * suppresses *new* generation: it marks the current render ineligible
   * synchronously so no request is issued while hidden (the composer's next
   * render also republishes eligibility). An already generated suggestion, and
   * any in-flight request that can still resolve, are deliberately left intact —
   * only genuine invalidation clears them. Completed-turn markers observed while
   * hidden are still consumed by the request effect below, so showing the
   * surface again never asks for a past turn.
   */
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') return;
      suggestionEligibleRef.current = false;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  /** Ask the daemon for one suggestion; the result is validated before it shows. */
  const requestSuggestion = useCallback((targetSessionKey: string): void => {
    const requestId = newSuggestionRequestId();
    suggestionPendingRef.current = { id: requestId, sessionKey: targetSessionKey };
    // Starting a request must not blank a valid suggestion for the same session;
    // only a suggestion owned by a different session key is cleared here.
    setSuggestionState((current) =>
      current.sessionKey === targetSessionKey ? current : { sessionKey: targetSessionKey, text: '' });
    void promptSuggest({ sessionId: targetSessionKey, requestId })
      .then((result) => {
        const pending = suggestionPendingRef.current;
        // A cancelled, replaced or differently-keyed result must never revive a
        // suggestion or leak into another draft.
        if (pending.id !== requestId || pending.sessionKey !== targetSessionKey) return;
        // The request settled; drop the pending marker so it can no longer be
        // cancelled as in-flight.
        suggestionPendingRef.current = { id: '', sessionKey: '' };
        // An empty refresh result never erases an already shown suggestion.
        const next = result.suggestion;
        if (next !== undefined && next !== '') {
          setSuggestionState({ sessionKey: targetSessionKey, text: next });
        }
      })
      .catch(() => {
        const pending = suggestionPendingRef.current;
        if (pending.id === requestId) suggestionPendingRef.current = { id: '', sessionKey: '' };
      });
  }, []);

  // Record the composer's eligibility only; the composer drops the suggestion
  // itself, so this stays a pure ref write safe to call during render.
  const setSuggestionEligible = useCallback((eligible: boolean): void => {
    suggestionEligibleRef.current = eligible;
  }, []);

  const acceptSuggestion = useCallback((): void => {
    const next = activeSuggestion;
    if (next === '') return;
    // Cancel any in-flight request first, so a late response cannot revive the
    // suggestion after it has been accepted into the draft.
    dismissSuggestion();
    // Accepting writes an editable draft; it is never sent automatically.
    setTextState(next);
    writeDraft(sessionKey, next);
  }, [activeSuggestion, sessionKey, dismissSuggestion]);

  // Request at most once per new completed turn of the active session, and only
  // when the composer reported eligibility during the completing render. The
  // marker is consumed whether or not a request is issued, so clearing a draft or
  // re-enabling the setting can never summon a suggestion for a past turn. The
  // first ready render of a session absorbs its loaded history as the baseline,
  // so history and session switches never request.
  useEffect(() => {
    if (!ledgerReady) return;
    const previous = suggestionRequestedRef.current;
    if (previous.identity !== sessionKey) {
      suggestionRequestedRef.current = { identity: sessionKey, marker: completedTurnMarker };
      return;
    }
    if (completedTurnMarker <= previous.marker) return;
    suggestionRequestedRef.current = { identity: sessionKey, marker: completedTurnMarker };
    if (!suggestionEligibleRef.current || suggestionSessionId === undefined) return;
    requestSuggestion(sessionKey);
  }, [ledgerReady, completedTurnMarker, sessionKey, suggestionSessionId, requestSuggestion]);

  // Cancel the outgoing session's in-flight request before paint (and on
  // unmount), so a result from a session we just left can never surface.
  useLayoutEffect(() => () => dismissSuggestion(), [sessionKey, dismissSuggestion]);

  // Resolve the target model's effort from that model's own memory (its last
  // chosen level, nearest-supported), or that model's own default when it has
  // no memory. Switching models never writes any model's memory.
  const requestModel = useCallback((nextModelId: string) => {
    setModelId(nextModelId);
    const target = models.find((entry) => entry.publicId === nextModelId);
    if (target === undefined || target.reasoningEfforts.length === 0) return;
    const remembered = resolveModelEffort(readModelEfforts(), target.publicId, target.reasoningEfforts);
    setEffort(remembered ?? defaultModelEffort(target.reasoningEfforts));
  }, [models]);

  const value = useMemo<SessionUsageContextValue>(() => ({
    sessionKey,
    models,
    events,
    turns,
    seq,
    contextInspection,
    contextRoutesPreview,
    modelId,
    effort,
    inputText: text,
    inputTokens,
    requestModel,
    refreshContext,
    setInputTokens,
    setModelId,
    setEffort,
    text,
    setText,
    clearText,
    attachments,
    setAttachments,
    clearAttachments,
    suggestion: activeSuggestion,
    setSuggestionEligible,
    acceptSuggestion,
    dismissSuggestion,
  }), [
    sessionKey, models, events, turns, seq, contextInspection, contextRoutesPreview, modelId, effort, text, inputTokens, attachments,
    activeSuggestion,
    requestModel, refreshContext, setInputTokens, setText, clearText, setAttachments, clearAttachments,
    setSuggestionEligible, acceptSuggestion, dismissSuggestion,
  ]);

  return <SessionUsageContext.Provider value={value}>{children}</SessionUsageContext.Provider>;
}

function useSessionUsageContext(): SessionUsageContextValue {
  const value = useContext(SessionUsageContext);
  if (value === null) throw new Error('Session usage hooks must be used within a SessionUsageProvider');
  return value;
}

/** Read the loaded session projection and request model changes. */
export function useSessionUsage(): SessionUsage {
  const {
    sessionKey, models, events, turns, seq, contextInspection, contextRoutesPreview, modelId, effort, inputText, inputTokens,
    requestModel, refreshContext, setInputTokens,
  } = useSessionUsageContext();
  return { sessionKey, models, events, turns, seq, contextInspection, contextRoutesPreview, modelId, effort, inputText, inputTokens, requestModel, refreshContext, setInputTokens };
}

/** Read and update the composer selection for the active session. */
export function useComposerSelection(): ComposerSelection {
  const {
    modelId, setModelId, effort, setEffort, text, setText, clearText,
    attachments, setAttachments, clearAttachments,
    suggestion, setSuggestionEligible, acceptSuggestion, dismissSuggestion,
  } = useSessionUsageContext();
  return {
    modelId, setModelId, effort, setEffort, text, setText, clearText,
    attachments, setAttachments, clearAttachments,
    suggestion, setSuggestionEligible, acceptSuggestion, dismissSuggestion,
  };
}
