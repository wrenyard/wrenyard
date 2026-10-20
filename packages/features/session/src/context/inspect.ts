/**
 * read-only context inspection (`session.context.inspect`).
 *
 * The instrument is forward-looking: it reports how large the *next* main
 * reasoning view will be, assembled with the same `buildReason` the engine
 * uses, with `userText` empty. The estimator is `o200k_base`, exactly the
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

import { estimateTokens, IMAGE_INPUT_TOKEN_ESTIMATE, resolveModelMetadata } from '../model/request.ts';
import {
  type LedgerEvent,
  type SessionCreatedEvent,
  type WorkspaceSnapshot,
} from '../ledger/store.ts';
import { renderEventText } from './render.ts';
import { buildReason } from '../reasoning/prompt.ts';
import type { LedgerPort, SessionHost, SessionViewInfo } from '../ports.ts';
import type {
  ContextInspectCalibration,
  ContextInspectFiles,
  ContextInspectModel,
  ContextItemKind,
  ContextLayerId,
  ContextLayerTokens,
  SessionContextInspectParams,
} from '@wrenyard/protocol/session';

export type {
  ContextInspectCalibration,
  ContextInspectFiles,
  ContextInspectModel,
  ContextItemKind,
  ContextLayerId,
  ContextLayerTokens,
} from '@wrenyard/protocol/session';

export type ContextInspectRequest = SessionContextInspectParams;

/** `step` is feature-local; the protocol DTO carries `cycle`. */
export interface ContextItem {
  seq: number;
  turn: number;
  step?: number;
  kind: ContextItemKind;
  /** Document/memory path, search intent, file list, or the first line of a message. */
  label: string;
  tokens: number;
}

export interface ContextInspection {
  /** Latest ledger `seq` at compute time. */
  computedAtSeq: number;
  estimator: 'o200k_base';
  model: ContextInspectModel;
  layers: ContextLayerTokens[];
  items: ContextItem[];
  /** Sum of the reported layers; never includes `wy-user`. */
  totalTokens: number;
  /** The most recent main-reasoning call that reported usage. */
  calibration?: ContextInspectCalibration;
  /** Persisted session-file image counts, when the timeline carries any. */
  files?: ContextInspectFiles;
}

/** Dependencies the inspector reads; wired by the engine. */
export interface ContextInspectHost {
  workspaceRoot: string;
  deviceName: string;
  ledger: LedgerPort;
  resolveInferenceProvider: SessionHost['resolveInferenceProvider'];
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

/** First `session.created` event, using a real type guard. */
export function findCreated(events: readonly LedgerEvent[]): SessionCreatedEvent | undefined {
  for (const event of events) if (event.type === 'session.created') return event;
  return undefined;
}

/** The context-item kind of a rendered event, or undefined when it is not one. */
function itemKind(event: LedgerEvent): ContextItemKind | undefined {
  switch (event.type) {
    case 'turn.started':
    case 'turn.steered':
      return 'user';
    case 'reasoning.completed':
      return 'assistant';
    case 'reasoning.thinking':
      return 'thinking';
    case 'document.content':
      return 'doc';
    case 'document.found':
      return 'search';
    case 'memory.recalled':
      return 'memory';
    case 'files.attached':
      return 'files';
    case 'action.finished':
      return 'action-result';
    case 'reply.sent':
      return 'reply';
    case 'workspace.changed':
      return 'ws-update';
    case 'turn.interrupted':
      return 'interrupt';
    case 'system.error':
      return 'error';
    default:
      return undefined;
  }
}

function itemLabel(event: LedgerEvent): string {
  switch (event.type) {
    case 'turn.started':
    case 'turn.steered':
    case 'reasoning.completed':
    case 'reasoning.thinking':
      return firstLine(event.text);
    case 'document.content':
    case 'memory.recalled':
      return event.path;
    case 'workspace.changed':
      return event.target;
    case 'document.found':
      return firstLine(event.understanding);
    case 'files.attached':
      return event.files.map((file) => file.path).join(', ');
    case 'turn.interrupted':
      return event.reason;
    case 'action.finished': {
      const result = firstLine(event.result);
      return result === '' ? event.action.type : result;
    }
    case 'reply.sent':
      return firstLine(event.text);
    case 'system.error':
      return firstLine(event.message);
    default:
      return '';
  }
}

/** The most recent reasoning span that reported input usage. */
function calibrationOf(events: readonly LedgerEvent[]): ContextInspectCalibration | undefined {
  const starts = new Map<string, { model: string; estimated: number }>();
  for (const event of events) {
    if (event.type === 'span.started' && event.kind === 'reasoning') {
      starts.set(event.id, { model: event.request.model, estimated: event.request.inputEstimate });
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'span.finished' || event.kind !== 'reasoning') continue;
    const input = event.metrics?.usage?.inputTokens;
    if (input === undefined) continue;
    const start = starts.get(event.id);
    return { spanId: event.id, model: start?.model ?? '', estimated: start?.estimated ?? 0, actual: input };
  }
  return undefined;
}

/**
 * Persisted image counts: every image occurrence at every `files.attached`
 * event position is carried when the inspected model accepts images and the
 * occurrence has a prepared preview. Every other occurrence is reported as
 * omitted.
 */
function fileCountsOf(
  events: readonly LedgerEvent[],
  allowImages: boolean,
): { images: number; omitted: number } {
  let images = 0;
  let omitted = 0;
  for (const event of events) {
    if (event.type !== 'files.attached') continue;
    for (const file of event.files) {
      if (file.kind !== 'image') continue;
      if (allowImages && file.processedPath !== undefined) images += 1;
      else omitted += 1;
    }
  }
  return { images, omitted };
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

    const metadata = resolveModelMetadata(request.model, (id) => this.host.resolveInferenceProvider(id));
    const allowImages = metadata.imageInput === true;
    const fileCounts = fileCountsOf(events, allowImages);
    const session: SessionViewInfo = {
      now: this.host.now().toISOString(),
      sessionId: sessionId ?? '',
      turn: nextTurn(events),
      step: 1,
      model: request.model,
      deviceName: this.host.deviceName,
      ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
    };

    const view = buildReason({
      deviceName: this.host.deviceName,
      snapshot,
      events,
      userText: '',
      session,
      allowImages: false,
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
      // The rendered `wy-ctx` layer is text only; each eligible image adds its
      // real processed-image estimate instead of its base64 payload length.
      const tokens = estimateTokens(text) + (id === 'wy-ctx' ? fileCounts.images * IMAGE_INPUT_TOKEN_ESTIMATE : 0);
      if (cacheable && RESIDENT_LAYER_IDS.includes(id)) {
        resident ??= new Map();
        resident.set(id, tokens);
        this.residentTokens.set(sessionId!, resident);
      }
      return { id, tokens };
    });
    const totalTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0);

    const items: ContextItem[] = [];
    for (const event of events) {
      const kind = itemKind(event);
      if (kind === undefined) continue;
      const key = `${sessionId ?? ''}:${event.seq}`;
      let tokens = this.itemTokens.get(key);
      if (tokens === undefined) {
        tokens = estimateTokens(renderEventText(event) ?? '');
        this.itemTokens.set(key, tokens);
      }
      items.push({
        seq: event.seq,
        turn: event.turn ?? 0,
        ...(event.step === undefined ? {} : { step: event.step }),
        kind,
        label: itemLabel(event),
        tokens,
      });
    }

    const calibration = calibrationOf(events);
    const hasFiles = fileCounts.images > 0 || fileCounts.omitted > 0;
    return {
      computedAtSeq: events.at(-1)?.seq ?? 0,
      estimator: 'o200k_base',
      model: {
        publicId: request.model,
        ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
        ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
      },
      layers,
      items,
      totalTokens,
      ...(calibration === undefined ? {} : { calibration }),
      ...(hasFiles ? { files: fileCounts } : {}),
    };
  }

  private readEvents(sessionId: string): LedgerEvent[] {
    const events = this.host.ledger.read(sessionId);
    const created = findCreated(events);
    if (!created) throw new Error(`Unknown session: ${sessionId}`);
    return events;
  }

  private snapshotOf(sessionId: string, events: readonly LedgerEvent[]): WorkspaceSnapshot {
    const created = findCreated(events);
    if (!created) throw new Error(`Unknown session: ${sessionId}`);
    return created.snapshot;
  }
}
