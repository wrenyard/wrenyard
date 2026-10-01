/**
 * Session usage bridge: a page-local external store shared by the session page,
 * the composer, the context meter and the inspector. It is a pure module with
 * `useSyncExternalStore` subscriptions — no window globals and no UI imports —
 * so sibling session components can exchange model/text selection and context
 * inspection requests without reaching into the page component.
 */
import { useSyncExternalStore } from 'react';
import type { LedgerEvent, ModelEntry, TurnModel } from '../model/types.js';

export interface SessionUsageInspection {
  sessionKey: string;
  tab: 'context' | 'ledger';
  seq?: number;
  nonce: number;
}

export interface SessionUsageState {
  sessionKey: string;
  models: readonly ModelEntry[];
  events: readonly LedgerEvent[];
  turns: readonly TurnModel[];
  modelId: string;
  inputText: string;
  seq: number;
  inspection?: SessionUsageInspection;
}

const initialState: SessionUsageState = {
  sessionKey: 'draft',
  models: [],
  events: [],
  turns: [],
  modelId: '',
  inputText: '',
  seq: 0,
};

let state: SessionUsageState = initialState;
const listeners = new Set<() => void>();
let inspectionNonce = 0;
// Child effects may publish before the parent's context effect on a switch.
const pendingComposer = new Map<string, { modelId: string; inputText: string }>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getState(): SessionUsageState {
  return state;
}

function sameState(a: SessionUsageState, b: SessionUsageState): boolean {
  return a.sessionKey === b.sessionKey
    && a.models === b.models
    && a.events === b.events
    && a.turns === b.turns
    && a.modelId === b.modelId
    && a.inputText === b.inputText
    && a.seq === b.seq
    && a.inspection === b.inspection;
}

/** Replace the snapshot only when a field actually changed. */
function commit(next: SessionUsageState): void {
  if (sameState(state, next)) return;
  state = next;
  emit();
}

function latestSeq(events: readonly LedgerEvent[]): number {
  let seq = 0;
  for (const event of events) if (event.seq > seq) seq = event.seq;
  return seq;
}

/** Shared session usage snapshot; the reference is stable between publishes. */
export function useSessionUsage(): SessionUsageState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** Publish the loaded ledger projection for one session. */
export function publishSessionContext(input: {
  sessionKey: string;
  models: readonly ModelEntry[];
  events: readonly LedgerEvent[];
  turns: readonly TurnModel[];
}): void {
  const sameSession = input.sessionKey === state.sessionKey;
  const pending = pendingComposer.get(input.sessionKey);
  pendingComposer.delete(input.sessionKey);
  commit({
    ...state,
    sessionKey: input.sessionKey,
    models: input.models,
    events: input.events,
    turns: input.turns,
    seq: latestSeq(input.events),
    // A new session starts empty until the composer publishes its selection.
    modelId: pending?.modelId ?? (sameSession ? state.modelId : ''),
    inputText: pending?.inputText ?? (sameSession ? state.inputText : ''),
  });
}

/** Publish the composer's selected model and draft text for the active session. */
export function publishComposerState(input: { sessionKey: string; modelId: string; inputText: string }): void {
  if (input.sessionKey !== state.sessionKey) {
    pendingComposer.set(input.sessionKey, { modelId: input.modelId, inputText: input.inputText });
    return;
  }
  if (state.modelId === input.modelId && state.inputText === input.inputText) return;
  commit({ ...state, modelId: input.modelId, inputText: input.inputText });
}

type SessionModelRequestListener = (request: { sessionKey: string; modelId: string }) => void;
const modelRequestListeners = new Set<SessionModelRequestListener>();

/** Ask the composer to select a model for the active session. */
export function requestSessionModel(modelId: string): void {
  const request = { sessionKey: state.sessionKey, modelId };
  for (const listener of modelRequestListeners) listener(request);
}

export function onSessionModelRequest(listener: SessionModelRequestListener): () => void {
  modelRequestListeners.add(listener);
  return () => {
    modelRequestListeners.delete(listener);
  };
}

type ContextInspectionListener = (request: SessionUsageInspection) => void;
const inspectionListeners = new Set<ContextInspectionListener>();

/**
 * Request that the inspector open on a tab, optionally focused on a ledger
 * sequence. The latest request is preserved on the snapshot so the inspector
 * can focus it even after the active session changes.
 */
export function requestContextInspection(
  sessionKey: string,
  options?: { tab?: 'context' | 'ledger'; seq?: number },
): void {
  inspectionNonce += 1;
  const inspection: SessionUsageInspection = {
    sessionKey,
    tab: options?.tab ?? 'context',
    nonce: inspectionNonce,
    ...(options?.seq === undefined ? {} : { seq: options.seq }),
  };
  state = { ...state, inspection };
  emit();
  for (const listener of inspectionListeners) listener(inspection);
}

export function onContextInspectionRequest(listener: ContextInspectionListener): () => void {
  inspectionListeners.add(listener);
  return () => {
    inspectionListeners.delete(listener);
  };
}
