/**
 * Session usage context: a React context owned by the session page that carries
 * the loaded session projection and the composer selection to sibling session
 * components (composer, context meter, inspector). Draft text is persisted
 * through the per-session drafts module; there is no module-level state and no
 * effect-based publishing.
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
import type { DraftAttachment, LedgerEvent, ModelEntry, TurnModel } from '../model/types.js';
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

export interface SessionUsageInspection {
  sessionKey: string;
  tab: 'context' | 'ledger';
  seq?: number;
  nonce: number;
}

export interface InspectionRequest {
  sessionKey: string;
  tab: 'context' | 'ledger';
  seq?: number;
}

export interface SessionUsage {
  sessionKey: string;
  models: readonly ModelEntry[];
  events: readonly LedgerEvent[];
  turns: readonly TurnModel[];
  seq: number;
  modelId: string;
  effort: string;
  inputText: string;
  inspection?: SessionUsageInspection;
  requestModel(modelId: string): void;
  requestInspection(options?: { tab?: 'context' | 'ledger'; seq?: number }): void;
}

export interface ComposerSelection {
  modelId: string;
  setModelId(modelId: string): void;
  effort: string;
  setEffort: Dispatch<SetStateAction<string>>;
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
  onInspect(request: InspectionRequest): void;
  children: ReactNode;
}

/** Owns the session projection and composer selection for the active session. */
export function SessionUsageProvider({ sessionKey, models, events, turns, onInspect, children }: SessionUsageProviderProps) {
  // The composer selection is keyed by the active session: switching sessions
  // resets the model/effort and reloads the destination draft during render.
  const [selectionKey, setSelectionKey] = useState(sessionKey);
  const [modelId, setModelId] = useState('');
  const [effort, setEffort] = useState('');
  const [text, setTextState] = useState(() => readDraft(sessionKey));
  const [attachments, setAttachmentsState] = useState<DraftAttachment[]>(() => readDraftAttachments(sessionKey));
  const [inspections, setInspections] = useState<Record<string, SessionUsageInspection>>({});
  const nonce = useRef(0);

  if (selectionKey !== sessionKey) {
    setSelectionKey(sessionKey);
    setModelId('');
    setEffort('');
    setTextState(readDraft(sessionKey));
    setAttachmentsState(readDraftAttachments(sessionKey));
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

  // Keep the reasoning effort only when the target model still supports it
  // (same rule as `supportedEffort` in Composer.tsx).
  const requestModel = useCallback((nextModelId: string) => {
    const target = models.find((entry) => entry.publicId === nextModelId);
    setModelId(nextModelId);
    setEffort((current) => (current === '' || (target?.thinkingLevels ?? []).includes(current) ? current : ''));
  }, [models]);

  const requestInspection = useCallback((options?: { tab?: 'context' | 'ledger'; seq?: number }) => {
    nonce.current += 1;
    const request: SessionUsageInspection = {
      sessionKey,
      tab: options?.tab ?? 'context',
      nonce: nonce.current,
      ...(options?.seq === undefined ? {} : { seq: options.seq }),
    };
    setInspections((current) => ({ ...current, [sessionKey]: request }));
    onInspect({
      sessionKey,
      tab: request.tab,
      ...(request.seq === undefined ? {} : { seq: request.seq }),
    });
  }, [sessionKey, onInspect]);

  const value = useMemo<SessionUsageContextValue>(() => ({
    sessionKey,
    models,
    events,
    turns,
    seq,
    modelId,
    effort,
    inputText: text,
    inspection: inspections[sessionKey],
    requestModel,
    requestInspection,
    setModelId,
    setEffort,
    text,
    setText,
    clearText,
    attachments,
    setAttachments,
    clearAttachments,
  }), [
    sessionKey, models, events, turns, seq, modelId, effort, text, attachments,
    inspections, requestModel, requestInspection, setText, clearText, setAttachments, clearAttachments,
  ]);

  return <SessionUsageContext.Provider value={value}>{children}</SessionUsageContext.Provider>;
}

function useSessionUsageContext(): SessionUsageContextValue {
  const value = useContext(SessionUsageContext);
  if (value === null) throw new Error('Session usage hooks must be used within a SessionUsageProvider');
  return value;
}

/** Read the loaded session projection and request model/inspection changes. */
export function useSessionUsage(): SessionUsage {
  const {
    sessionKey, models, events, turns, seq, modelId, effort, inputText,
    inspection, requestModel, requestInspection,
  } = useSessionUsageContext();
  return { sessionKey, models, events, turns, seq, modelId, effort, inputText, inspection, requestModel, requestInspection };
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
