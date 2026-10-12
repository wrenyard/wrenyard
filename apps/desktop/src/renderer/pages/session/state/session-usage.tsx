/**
 * Session usage context: a React context owned by the session page that carries
 * the loaded session projection and the composer selection to sibling session
 * components (the composer, the status bar ctx item, inspector). Draft text is
 * persisted through the per-session drafts module; there is no module-level
 * state and no effect-based publishing.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import { contextQuery, routesPreviewQuery } from '../queries.js';
import { retainReasoningEffort, type ReasoningEffort } from './reasoning-effort.js';
import { setQuotaFocus } from '@/renderer/lib/statusbar';
import {
  clearDraft,
  clearDraftAttachments,
  flushDraft,
  flushDraftAttachments,
  readDraft,
  readDraftAttachments,
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
  // resets the model/effort and reloads the destination draft during render.
  const [selectionKey, setSelectionKey] = useState(sessionKey);
  const [modelId, setModelId] = useState('');
  // A valid level until the composer seeds the real one for the active session.
  const [effort, setEffort] = useState<ReasoningEffort>('medium');
  const [text, setTextState] = useState(() => readDraft(sessionKey));
  const [attachments, setAttachmentsState] = useState<DraftAttachment[]>(() => readDraftAttachments(sessionKey));
  const [inputTokens, setInputTokensState] = useState(0);

  if (selectionKey !== sessionKey) {
    setSelectionKey(sessionKey);
    setModelId('');
    setEffort('medium');
    setTextState(readDraft(sessionKey));
    setAttachmentsState(readDraftAttachments(sessionKey));
    setInputTokensState(0);
  }

  // Flush the outgoing session's pending draft on switch and on unmount.
  useEffect(() => () => {
    flushDraft(sessionKey);
    flushDraftAttachments(sessionKey);
  }, [sessionKey]);

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

  // Retain the reasoning effort when the target route still supports it;
  // otherwise fall back to the nearest-supported rule (shared with Composer).
  const requestModel = useCallback((nextModelId: string) => {
    const target = models.find((entry) => entry.publicId === nextModelId);
    setModelId(nextModelId);
    const supported = target?.reasoningEfforts ?? [];
    if (supported.length === 0) return;
    setEffort((current) => retainReasoningEffort(current, supported));
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
  }), [
    sessionKey, models, events, turns, seq, contextInspection, contextRoutesPreview, modelId, effort, text, inputTokens, attachments,
    requestModel, refreshContext, setInputTokens, setText, clearText, setAttachments, clearAttachments,
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
  } = useSessionUsageContext();
  return {
    modelId, setModelId, effort, setEffort, text, setText, clearText,
    attachments, setAttachments, clearAttachments,
  };
}
