import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LedgerEvent, SessionFile } from '@wrenyard/session';
import type { DraftAttachment } from '../src/renderer/pages/session/model/types.js';
import {
  fold,
  isFormat2,
  projectSessionFile,
  projectSessionFileList,
} from '../src/renderer/pages/session/model/fold.js';
import {
  initialSessionPageState,
  sessionReducer,
} from '../src/renderer/pages/session/state/session-reducer.js';
import {
  clearDraft,
  clearDraftAttachments,
  isStagedPathRetained,
  readDraft,
  readDraftAttachments,
  reconcileSentDraft,
  writeDraft,
  writeDraftAttachments,
} from '../src/renderer/pages/session/state/drafts.js';

/**
 * Focused current-only model tests for the session file flow: draft
 * persistence and session switching, optimistic pending attachments, and the
 * ledger -> view session-file projection (metadata only, path + hash identity).
 */

function event(partial: Record<string, unknown>): LedgerEvent {
  return { seq: 0, at: '2026-01-01T00:00:00.000Z', ...partial } as unknown as LedgerEvent;
}

/**
 * Current format-2 `session.created` header with an empty valid snapshot,
 * prepended to fold fixtures whose events are otherwise headerless fragments.
 * This is a test fixture constructor, not a production adapter.
 */
function sessionHeader(seq = 0): LedgerEvent {
  return event({
    type: 'session.created',
    seq,
    format: 2,
    snapshot: { takenAt: '2026-01-01T00:00:00.000Z', deviceName: 'test-device', projects: [] },
  });
}

function file(overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    path: '/state/sessions/s1/files/01-photo.png',
    name: '01-photo.png',
    kind: 'image',
    mime: 'image/png',
    bytes: 1234,
    hash: 'deadbeef',
    source: 'user',
    description: 'photo.png',
    ...overrides,
  };
}

const DRAFT: DraftAttachment = {
  id: 'd-1',
  path: '/tmp/clipboard.png',
  name: 'clipboard.png',
  bytes: 42,
  mime: 'image/png',
  preview: 'data:image/png;base64,AAAA',
  staged: true,
};

// ─── Draft attachments ─────────────────────────────────────────────────────

test('attachment drafts are isolated per session and cleared independently', () => {
  writeDraftAttachments('media-a', [DRAFT]);
  assert.equal(readDraftAttachments('media-a').length, 1, 'the written attachment is readable for its session');
  assert.equal(readDraftAttachments('media-a')[0]!.staged, true, 'the staged flag survives the in-memory copy');
  assert.equal(readDraftAttachments('media-b').length, 0, 'a different session never sees the draft');
  clearDraftAttachments('media-a');
  assert.equal(readDraftAttachments('media-a').length, 0, 'clearing removes the session attachment draft');
});

test('text drafts keep their existing behaviour alongside attachment drafts', () => {
  writeDraft('media-text', 'hello');
  writeDraftAttachments('media-text', [DRAFT]);
  assert.equal(readDraft('media-text'), 'hello', 'text drafts are unchanged');
  assert.equal(readDraftAttachments('media-text').length, 1, 'attachment drafts live beside text drafts');
  clearDraft('media-text');
  clearDraftAttachments('media-text');
  assert.equal(readDraft('media-text'), '', 'cleared text reads empty');
  assert.equal(readDraftAttachments('media-text').length, 0, 'cleared attachments read empty');
});

// ─── Optimistic pending turns ──────────────────────────────────────────────

test('a failed optimistic turn retains its attachments for retry', () => {
  let state = sessionReducer(initialSessionPageState, {
    type: 'pending-add',
    pending: { localId: 'l-1', text: '', at: '2026-01-01T00:00:00.000Z', attachments: [DRAFT] },
  });
  state = sessionReducer(state, { type: 'pending-fail', localId: 'l-1', message: 'boom' });
  assert.equal(state.pending[0]!.failed, 'boom', 'the failure is recorded');
  assert.equal(state.pending[0]!.attachments?.length, 1, 'attachments are kept so a retry can resend them');

  const switched = sessionReducer(state, { type: 'select', sessionId: 's-other' });
  assert.equal(switched.pending.length, 0, 'switching sessions clears the optimistic turn');
});

test('the reducer reconciles an accepted turn and clears the optimistic row', () => {
  let state = sessionReducer(initialSessionPageState, {
    type: 'pending-add',
    pending: { localId: 'l-1', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
  });
  state = sessionReducer(state, { type: 'pending-resolve', localId: 'l-1', turn: 1 });
  state = sessionReducer(state, {
    type: 'events',
    sessionId: '',
    snapshot: true,
    events: [event({ type: 'turn.started', seq: 1, turn: 1, text: 'hi', model: { provider: 'p', model: 'm' } })],
  });
  assert.equal(state.pending.length, 0, 'an admitted turn removes the optimistic row');

  let resolved = sessionReducer(initialSessionPageState, {
    type: 'pending-add',
    pending: { localId: 'l-2', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
  });
  resolved = sessionReducer(resolved, { type: 'pending-resolve', localId: 'l-2', turn: 3 });
  assert.equal(resolved.pending[0]!.turn, 3, 'the allocated turn number is reconciled onto the row');
});

// ─── Session file projection ───────────────────────────────────────────────

test('projectSessionFile keeps metadata and drops any encoded payload', () => {
  const projected = projectSessionFile({
    ...file(),
    dataUrl: 'data:image/png;base64,SECRET',
    text: 'hello',
    tokens: 3,
  });
  assert.ok(projected, 'a well-formed file projects');
  assert.equal(projected.path, '/state/sessions/s1/files/01-photo.png');
  assert.equal(projected.kind, 'image');
  assert.equal(projected.description, 'photo.png');
  assert.equal('dataUrl' in projected, false, 'no encoded bytes leak into the projection');
  assert.equal(projected.text, 'hello', 'bounded text survives');
  assert.equal(projected.tokens, 3);

  assert.equal(projectSessionFile({ path: '/p', name: 'n' }), undefined, 'a file without a kind is dropped');
  assert.equal(projectSessionFile({ path: '/p', kind: 'image' }), undefined, 'a file without a name is dropped');

  const coerced = projectSessionFile({ ...file(), source: 'attachment' });
  assert.equal(coerced?.source, 'user', 'only `task` is kept; every other source reads as user');

  assert.equal(projectSessionFileList([file(), { path: '/p' }, null]).length, 1, 'malformed entries are dropped');
});

// ─── Ledger projection ─────────────────────────────────────────────────────

// ─── In-flight draft reconciliation ────────────────────────────────────────

test('a session switch releases only the matching origin draft', () => {
  const base = {
    originKey: 's-a',
    activeKey: 's-b',
    bodyText: 'hi',
    activeText: '',
    submittedIds: ['d-1'],
    activeIds: [] as string[],
    originIds: ['d-1'] as string[],
  };
  assert.deepEqual(
    reconcileSentDraft(base),
    { clearText: false, clearAttachments: false, clearOriginAttachments: true },
    'the matching origin draft is released and the destination is untouched',
  );
  assert.deepEqual(
    reconcileSentDraft({ ...base, originIds: ['d-1', 'd-2'] }),
    { clearText: false, clearAttachments: false, clearOriginAttachments: false },
    'a changed origin draft and its files are preserved',
  );
});

test('staged files are retained while any known draft references them', () => {
  const staged: DraftAttachment = { ...DRAFT, id: 'd-staged', path: '/tmp/stage-unique.png' };
  writeDraftAttachments('retained-session', [staged]);
  assert.equal(isStagedPathRetained(staged.path!), true, 'a live draft keeps its staged file');
  clearDraftAttachments('retained-session');
  assert.equal(isStagedPathRetained(staged.path!), false, 'a released draft no longer retains staged files');
  assert.equal(isStagedPathRetained(''), false, 'an empty path is never retained');
});

// ─── Legacy (non-format-2) history boundary ────────────────────────────────

const EMPTY_MODEL = { turns: [], runningTurns: 0, calls: [] };

/**
 * A raw legacy ledger: a format-1 `session.created` with invalid old snapshot
 * fields plus `action.started` kinds outside the current union (`task`,
 * `write-doc`). None of these records match the current schema.
 */
function legacyEvents(): LedgerEvent[] {
  return [
    event({
      type: 'session.created',
      seq: 1,
      format: 1,
      snapshot: { workspaceRoot: '/old', sessions: 'not-an-array' },
    }),
    event({ type: 'turn.started', seq: 2, turn: 1, text: '旧会话', model: 'legacy-model' }),
    event({ type: 'action.started', seq: 3, turn: 1, cycle: 1, actionId: 'a1', blockId: 'b1', kind: 'task', parsed: { goal: 'x' } }),
    event({ type: 'action.started', seq: 4, turn: 1, cycle: 1, actionId: 'a2', blockId: 'b2', kind: 'write-doc', parsed: { path: '/p' } }),
    event({ type: 'action.finished', seq: 5, turn: 1, cycle: 1, actionId: 'a1', kind: 'task', status: 'ok', result: 'done' }),
    event({ type: 'turn.finished', seq: 6, turn: 1, status: 'completed' }),
  ];
}

test('fold refuses an unsupported legacy ledger without throwing or mutating it', () => {
  const events = legacyEvents();
  const before = JSON.stringify(events);
  let model: ReturnType<typeof fold> | undefined;
  assert.doesNotThrow(() => { model = fold(events, [], {}, { sessionId: 'legacy-1' }); });
  assert.deepEqual(model, EMPTY_MODEL, 'an incompatible history folds to the empty current model');
  assert.equal(JSON.stringify(events), before, 'raw events are never mutated');
});

test('fold also refuses a headerless nonempty fragment', () => {
  const events: LedgerEvent[] = [event({ type: 'action.started', seq: 1, turn: 1, actionId: 'a1', kind: 'task' })];
  const before = JSON.stringify(events);
  assert.doesNotThrow(() => fold(events, [], {}, { sessionId: 'headerless' }));
  assert.deepEqual(fold(events, [], {}, { sessionId: 'headerless' }), EMPTY_MODEL);
  assert.equal(JSON.stringify(events), before, 'the fragment is untouched');
});

test('fold still treats an empty ledger as the ordinary empty draft model', () => {
  assert.deepEqual(fold([], [], {}, { sessionId: 'draft' }), EMPTY_MODEL);
});

test('the observed missing-format history with an unsupported action kind stays raw', () => {
  const header = sessionHeader(1) as unknown as Record<string, unknown>;
  delete header.format;
  const events = [
    header as unknown as LedgerEvent,
    event({ type: 'turn.started', seq: 2, turn: 1, text: 'old', model: { provider: 'p', model: 'm' } }),
    event({ type: 'action.started', seq: 3, turn: 1, cycle: 1, actionId: 'a-old', blockId: 'b-old', kind: 'unsupported', parsed: {} }),
  ];
  const before = JSON.stringify(events);
  assert.equal(isFormat2(events), false);
  assert.doesNotThrow(() => fold(events, [], {}, { sessionId: 'observed-old' }));
  assert.deepEqual(fold(events, [], {}, { sessionId: 'observed-old' }), EMPTY_MODEL);
  assert.equal(JSON.stringify(events), before, 'neither the header nor the unsupported action is adapted');
});
