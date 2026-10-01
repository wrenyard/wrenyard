/**
 * read-only context inspection (`session.context.inspect`).
 *
 * The instrument is forward-looking: it reports how large the *next* main
 * reasoning view will be, assembled with the same `buildReason` the engine
 * uses, with `userText` empty. The estimator is `cl100k_base`, exactly the
 * counter the call budget uses, and a model's window/output facts come from the
 * same `resolveModelMetadata` the budget check resolves.
 *
 * Caching exploits the one thing the ledger guarantees: an event already on the
 * timeline renders to the same bytes forever, so its token count is cached by
 * `(sessionId, seq)`. The resident layers and the frozen workspace snapshot are
 * cached per session. `wy-ctx` and `wy-info` are recomputed each call because
 * they grow; the layer totals, not the per-item sums, are authoritative (they
 * differ by tokenization boundaries).
 *
 * This module never calls a model and never mutates the ledger.
 */

import { estimateTokens, resolveModelMetadata } from './calls.ts';
import { renderContextEvent } from './views.ts';
import type { LedgerPort, SessionViewInfo, ViewsPort } from './engine.ts';
import type { LedgerEvent, WorkspaceSnapshot } from './ledger.ts';

/** Every layer of the main reasoning view except the transient `wy-user`. */
export type ContextLayerId = 'wy-system' | 'wy-global' | 'wy-role' | 'wy-workspace' | 'wy-ctx' | 'wy-info';

/** How one context item reads in the breakdown. */
export type ContextItemKind =
  | 'user'
  | 'assistant'
  | 'reply'
  | 'doc'
  | 'memory'
  | 'action-result'
  | 'ws-update'
  | 'interrupt';

export interface ContextInspectRequest {
  /** Omitted means a new session: resident layers plus the workspace snapshot. */
  sessionId?: string;
  /** Gateway public id of the model the input box currently has selected. */
  model: string;
}

export interface ContextLayerTokens {
  id: ContextLayerId;
  tokens: number;
}

export interface ContextItem {
  seq: number;
  turn: number;
  cycle?: number;
  kind: ContextItemKind;
  /** Document/memory path, action kind and target, or the first line of a message. */
  label: string;
  tokens: number;
}

export interface ContextInspectModel {
  publicId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ContextInspectCalibration {
  callId: string;
  model: string;
  /** The call's `estimatedInputTokens`. */
  estimated: number;
  /** The call's `usage.input` (including cached input). */
  actual: number;
}

export interface ContextInspection {
  /** Latest ledger `seq` at compute time. */
  computedAtSeq: number;
  estimator: 'cl100k_base';
  model: ContextInspectModel;
  layers: ContextLayerTokens[];
  items: ContextItem[];
  /** Sum of the reported layers; never includes `wy-user`. */
  totalTokens: number;
  /** The most recent main-reasoning call that reported usage. */
  calibration?: ContextInspectCalibration;
}

/** Dependencies the inspector reads; wired by the engine. */
export interface ContextInspectHost {
  workspaceRoot: string;
  deviceName: string;
  maxCycles: number;
  views: ViewsPort;
  ledger: LedgerPort;
  now(): Date;
  /** Build the workspace snapshot a new session would freeze right now. */
  createSnapshot(): Promise<WorkspaceSnapshot>;
}

/** Fixed layer order, so the renderer can map layers to breakdown groups. */
const LAYER_IDS: readonly ContextLayerId[] = ['wy-system', 'wy-global', 'wy-role', 'wy-workspace', 'wy-ctx', 'wy-info'];

/** Layers that never change for a session with a frozen snapshot. */
const RESIDENT_LAYER_IDS: readonly ContextLayerId[] = ['wy-system', 'wy-global', 'wy-role', 'wy-workspace'];

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

/** Describe a committed action from its parsed payload, when it has one. */
function describeParsedAction(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const action = parsed as {
    kind?: unknown;
    project?: unknown;
    task?: unknown;
    goal?: unknown;
    paths?: unknown;
    docType?: unknown;
    reason?: unknown;
  };
  switch (action.kind) {
    case 'dispatch': {
      const project = typeof action.project === 'string' && action.project !== '' ? ` @${action.project}` : '';
      const goal = typeof action.goal === 'string' ? action.goal : '';
      return `dispatch${project} ${String(action.task ?? '')}${goal === '' ? '' : `: ${goal}`}`.trim();
    }
    case 'read': {
      const paths = Array.isArray(action.paths) ? action.paths.filter((path): path is string => typeof path === 'string') : [];
      return `read ${paths.join(', ')}`.trim();
    }
    case 'write-doc':
      return `write-doc ${String(action.project ?? '')}/${String(action.docType ?? '')}`.trim();
    case 'unsupported':
      return `unsupported ${String(action.reason ?? '')}`.trim();
    default:
      return undefined;
  }
}

/** The context-item kind of a rendered event, or undefined when it is not one. */
function itemKind(event: LedgerEvent): ContextItemKind | undefined {
  switch (event.type) {
    case 'turn.started':
      return 'user';
    case 'reason.completed':
      return 'assistant';
    case 'reply':
      return 'reply';
    case 'doc.read':
      return 'doc';
    case 'memory.recalled':
      return 'memory';
    case 'action.finished':
      return 'action-result';
    case 'ws.updated':
      return 'ws-update';
    case 'turn.interrupted':
      return 'interrupt';
    default:
      return undefined;
  }
}

function itemLabel(event: LedgerEvent, parsedActions: Map<string, unknown>): string {
  switch (event.type) {
    case 'turn.started':
      return firstLine(event.text);
    case 'reason.completed':
      return firstLine(event.text);
    case 'reply':
      return firstLine(event.text);
    case 'doc.read':
    case 'memory.recalled':
      return event.path;
    case 'ws.updated':
      return event.path;
    case 'turn.interrupted':
      return event.reason;
    case 'action.finished': {
      const described = describeParsedAction(parsedActions.get(event.actionId));
      if (described !== undefined && described !== '') return described;
      const result = firstLine(event.result);
      return result === '' ? event.kind : result;
    }
    default:
      return '';
  }
}

/** The most recent main-reasoning call that reported input usage. */
function calibrationOf(events: readonly LedgerEvent[]): ContextInspectCalibration | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'call') continue;
    if (event.role !== 'reason') continue;
    const input = event.usage?.input;
    if (input === undefined) continue;
    return { callId: event.callId, model: event.model, estimated: event.estimatedInputTokens, actual: input };
  }
  return undefined;
}

/** The next turn number: one past the highest turn the timeline mentions. */
function nextTurn(events: readonly LedgerEvent[]): number {
  let highest = 0;
  for (const event of events) {
    if (typeof event.turn === 'number' && event.turn > highest) highest = event.turn;
  }
  return highest + 1;
}

/** Immutable per-event and per-session token caches, scoped to one engine. */
export class ContextInspector {
  private readonly host: ContextInspectHost;
  /** `(sessionId, seq) -> tokens`; a rendered event never changes. */
  private readonly itemTokens = new Map<string, number>();
  /** `sessionId -> token count` of the frozen resident/workspace layers. */
  private readonly residentTokens = new Map<string, Map<ContextLayerId, number>>();

  constructor(host: ContextInspectHost) {
    this.host = host;
  }

  async inspect(request: ContextInspectRequest): Promise<ContextInspection> {
    const sessionId = request.sessionId;
    const events = sessionId === undefined ? [] : this.readEvents(sessionId);
    const snapshot = sessionId === undefined
      ? await this.host.createSnapshot()
      : this.snapshotOf(sessionId, events);

    const metadata = resolveModelMetadata(request.model);
    const session: SessionViewInfo = {
      now: this.host.now().toISOString(),
      sessionId: sessionId ?? '',
      turn: nextTurn(events),
      cycle: 1,
      maxCycles: this.host.maxCycles,
      model: request.model,
      deviceName: this.host.deviceName,
      ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
    };

    const view = this.host.views.reason({
      workspaceRoot: this.host.workspaceRoot,
      deviceName: this.host.deviceName,
      snapshot,
      events,
      userText: '',
      session,
      runningTurns: [],
    });
    const segments = view.segments ?? {};

    // Resident layers are cached per session; a new session's snapshot may be
    // regenerated between calls, so it is never cached.
    const cacheable = sessionId !== undefined;
    let resident = cacheable ? this.residentTokens.get(sessionId) : undefined;
    const layers: ContextLayerTokens[] = LAYER_IDS.map((id) => {
      const text = segments[id] ?? '';
      const cached = resident?.get(id);
      if (cached !== undefined) return { id, tokens: cached };
      const tokens = estimateTokens(text);
      if (cacheable && RESIDENT_LAYER_IDS.includes(id)) {
        resident ??= new Map();
        resident.set(id, tokens);
        this.residentTokens.set(sessionId!, resident);
      }
      return { id, tokens };
    });
    const totalTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0);

    const parsedActions = new Map<string, unknown>();
    for (const event of events) {
      if (event.type === 'action.started') parsedActions.set(event.actionId, event.parsed);
    }
    const items: ContextItem[] = [];
    for (const event of events) {
      const rendered = renderContextEvent(event);
      if (rendered === undefined) continue;
      const kind = itemKind(event);
      if (kind === undefined) continue;
      const key = `${sessionId ?? ''}:${event.seq}`;
      let tokens = this.itemTokens.get(key);
      if (tokens === undefined) {
        tokens = estimateTokens(rendered);
        this.itemTokens.set(key, tokens);
      }
      items.push({
        seq: event.seq,
        turn: event.turn ?? 0,
        ...(event.cycle === undefined ? {} : { cycle: event.cycle }),
        kind,
        label: itemLabel(event, parsedActions),
        tokens,
      });
    }

    const calibration = calibrationOf(events);
    return {
      computedAtSeq: events.at(-1)?.seq ?? 0,
      estimator: 'cl100k_base',
      model: {
        publicId: request.model,
        ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
        ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
      },
      layers,
      items,
      totalTokens,
      ...(calibration === undefined ? {} : { calibration }),
    };
  }

  private readEvents(sessionId: string): LedgerEvent[] {
    const events = this.host.ledger.read(sessionId);
    if (!events.some((event) => event.type === 'session.created')) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return events;
  }

  private snapshotOf(sessionId: string, events: readonly LedgerEvent[]): WorkspaceSnapshot {
    const created = events.find((event) => event.type === 'session.created');
    if (!created) throw new Error(`Unknown session: ${sessionId}`);
    return created.snapshot;
  }
}
