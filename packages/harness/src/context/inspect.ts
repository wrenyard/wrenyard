/**
 * Read-only context inspection (`session.context.inspect`).
 *
 * Forward-looking: reports how large the next main reasoning view will be,
 * assembled with `buildReason`. This module never calls a model and never
 * mutates the ledger.
 */

import { estimateTokens, IMAGE_INPUT_TOKEN_ESTIMATE } from '@wrenyard/ai';
import { resolveModelMetadata } from '@wrenyard/ai/metadata';
import type { GatewayModel } from '@wrenyard/ai-protocol';
import type {
  ContextInspectCalibration,
  ContextInspectFiles,
  ContextInspectModel,
  ContextItemKind,
  ContextLayerId,
  ContextLayerTokens,
  SessionContextInspectParams,
} from '@wrenyard/protocol/session';
import type { LedgerEvent, SessionCreatedEvent, WorkspaceSnapshot } from '../events.ts';
import type { LedgerPort, SessionViewInfo } from '../ports.ts';
import { renderEventText } from './render.ts';
import { buildReason } from './prompt.ts';

export type {
  ContextInspectCalibration,
  ContextInspectFiles,
  ContextInspectModel,
  ContextItemKind,
  ContextLayerId,
  ContextLayerTokens,
} from '@wrenyard/protocol/session';

export type ContextInspectRequest = SessionContextInspectParams;

/** `step` is harness-local; the protocol DTO carries `cycle`. */
export interface ContextItem {
  seq: number;
  turn: number;
  step?: number;
  kind: ContextItemKind;
  label: string;
  tokens: number;
}

export interface ContextInspection {
  computedAtSeq: number;
  estimator: 'o200k_base';
  model: ContextInspectModel;
  layers: ContextLayerTokens[];
  items: ContextItem[];
  totalTokens: number;
  calibration?: ContextInspectCalibration;
  files?: ContextInspectFiles;
}

export interface ContextInspectHost {
  workspaceRoot: string;
  deviceName: string;
  ledger: LedgerPort;
  models(): Promise<readonly GatewayModel[]>;
  now(): Date;
  createSnapshot(): Promise<WorkspaceSnapshot>;
}

const LAYER_IDS: readonly ContextLayerId[] = ['wy-system', 'wy-global', 'wy-role', 'wy-workspace', 'wy-ctx', 'wy-info'];
const RESIDENT_LAYER_IDS: readonly ContextLayerId[] = ['wy-system', 'wy-global', 'wy-role', 'wy-workspace'];

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

export function findCreated(events: readonly LedgerEvent[]): SessionCreatedEvent | undefined {
  for (const event of events) if (event.type === 'session.created') return event;
  return undefined;
}

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
  private readonly itemTokens = new Map<string, number>();
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

    const metadata = resolveModelMetadata(request.model, await this.host.models());
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

    const cacheable = sessionId !== undefined;
    let resident = cacheable ? this.residentTokens.get(sessionId) : undefined;
    const layers: ContextLayerTokens[] = LAYER_IDS.map((id) => {
      const text = segments[id] ?? '';
      const cached = resident?.get(id);
      if (cached !== undefined) return { id, tokens: cached };
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
