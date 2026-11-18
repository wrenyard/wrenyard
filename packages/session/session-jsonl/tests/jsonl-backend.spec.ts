import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LedgerEvent } from '@wrenyard/protocol/session';
import { SessionCorruptedError, SessionNotFoundError } from '@wrenyard/session';

import {
  JsonlSessionPersistence,
  createJsonlPersistence,
  normalizeStoredEvent,
} from '../src/index.ts';
import { runSessionPersistenceContract } from '../../session/tests/persistence-contract.ts';

// Source: 2026-11-18-session-module-architecture.md
function makeTempRoots(): { stateRoot: string; workspaceRoot: string; cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-session-jsonl-'));
  return {
    stateRoot: join(dir, 'state'),
    workspaceRoot: join(dir, 'workspace'),
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

runSessionPersistenceContract('JsonlSessionPersistence', (options) => {
  const roots = makeTempRoots();
  return {
    persistence: createJsonlPersistence({
      stateRoot: roots.stateRoot,
      workspaceRoot: roots.workspaceRoot,
      now: options?.now,
    }),
    cleanup: roots.cleanup,
  };
});

describe('JsonlSessionPersistence durability and recovery semantics', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function openRoots(): { stateRoot: string; workspaceRoot: string } {
    const roots = makeTempRoots();
    cleanups.push(roots.cleanup);
    return roots;
  }

  it('truncates a torn trailing fragment before the next append and rejects corrupt complete lines', async () => {
    const { stateRoot, workspaceRoot } = openRoots();
    const p1 = createJsonlPersistence({ stateRoot, workspaceRoot });
    const h1 = await p1.create('s-torn');
    await h1.append({ type: 'session.titled', text: 'Clean Title' });
    await h1.close();
    await p1.close();

    const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
    const jsonlFile = join(stateRoot, 'session', digest, 'sessions', 's-torn.jsonl');
    appendFileSync(jsonlFile, '{"seq":2,"type":"torn', 'utf8');

    const p2 = createJsonlPersistence({ stateRoot, workspaceRoot });
    const h2 = await p2.open('s-torn', 'write');
    const next = await h2.append({
      type: 'turn.started',
      turn: 1,
      id: 't1',
      text: 'after torn',
      model: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(next.seq).toBe(2);
    expect(h2.read().map((event) => event.seq)).toEqual([1, 2]);
    await h2.close();
    await p2.close();

    // A complete malformed line is corruption and throws instead of truncating.
    appendFileSync(jsonlFile, '{corrupt-json}\n', 'utf8');
    const p3 = createJsonlPersistence({ stateRoot, workspaceRoot });
    expect(() => p3.read('s-torn')).toThrow(SessionCorruptedError);
    await p3.close();
  });

  it('detects cold index.json byte mismatches at startup and rebuilds summaries on first touch', async () => {
    const { stateRoot, workspaceRoot } = openRoots();
    const p1 = createJsonlPersistence({ stateRoot, workspaceRoot });
    const h1 = await p1.create('s-stale');
    await h1.append({ type: 'session.titled', text: 'Original Title' });
    await h1.close();
    await p1.close();

    const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
    const rootDir = join(stateRoot, 'session', digest);
    const jsonlFile = join(rootDir, 'sessions', 's-stale.jsonl');
    const indexFile = join(rootDir, 'index.json');

    // Append directly behind the index's back so bytes mismatch at next startup.
    const extraLine: LedgerEvent = {
      seq: 2,
      at: '2026-11-18T12:00:00.000Z',
      type: 'session.titled',
      text: 'Rebuilt Title',
      manual: true,
    };
    appendFileSync(jsonlFile, `${JSON.stringify(extraLine)}\n`, 'utf8');
    const savedIndex = JSON.parse(readFileSync(indexFile, 'utf8')) as {
      sessions: Array<{ lastSeq?: number }>;
    };
    expect(savedIndex.sessions[0]!.lastSeq).toBe(1);

    const p2 = createJsonlPersistence({ stateRoot, workspaceRoot });
    // Startup cleared stale tail metadata without reading the body yet.
    const preRead = p2.stat('s-stale');
    expect(preRead?.lastSeq).toBeUndefined();
    expect(preRead?.pendingTurns).toBeUndefined();

    // First touch rebuilds the full summary from the JSONL body.
    const events = p2.read('s-stale');
    expect(events).toHaveLength(2);
    const rebuilt = p2.stat('s-stale');
    expect(rebuilt?.title).toBe('Rebuilt Title');
    expect(rebuilt?.manualTitle).toBe(true);
    expect(rebuilt?.lastSeq).toBe(2);
    expect(rebuilt?.pendingTurns).toEqual([]);
    await p2.close();
  });

  it('supports beforeAppend hook returning an existing snapshot without duplicating lines', async () => {
    const { stateRoot, workspaceRoot } = openRoots();
    const persistence = new JsonlSessionPersistence({ stateRoot, workspaceRoot });
    const handle = await persistence.create('s-hook');
    const first = await handle.append({ type: 'session.titled', text: 'Hooked' });

    let hookCalls = 0;
    persistence.setBeforeAppendHook(({ events, draft }) => {
      hookCalls += 1;
      if (draft.type === 'session.titled' && draft.text === 'Hooked') {
        return { action: 'return-existing', event: events[0]! };
      }
      return { action: 'append', draft };
    });

    const deduped = await handle.append({ type: 'session.titled', text: 'Hooked' });
    expect(hookCalls).toBe(1);
    expect(deduped).toBe(first);
    expect(handle.read()).toHaveLength(1);

    await handle.close();
    await persistence.close();
  });

  it('preserves SessionSummary fields (lastTurn, manualTitle, archived, pinned) across restarts', async () => {
    const { stateRoot, workspaceRoot } = openRoots();
    let epoch = 1_700_000_000_000;
    const now = (): Date => new Date((epoch += 1_000));

    const p1 = createJsonlPersistence({ stateRoot, workspaceRoot, now });
    const h1 = await p1.create('s-summary');
    await h1.append({ type: 'session.titled', text: 'Pinned Task', manual: true });
    await h1.append({ type: 'session.titled', text: 'Auto Title Should Not Overwrite' });
    await h1.append({ type: 'session.metadata', archived: true, pinned: true });
    await h1.append({
      type: 'turn.started',
      turn: 1,
      id: 't1',
      text: 'run',
      model: { provider: 'openai', model: 'gpt-4o' },
    });
    await h1.append({
      type: 'span.finished',
      turn: 1,
      step: 1,
      id: 's1.1',
      kind: 'reasoning',
      status: 'failed',
      error: { kind: 'rate_limited', message: 'slow down', retryAt: '2026-11-18T12:05:00.000Z' },
    });
    await h1.append({ type: 'turn.finished', turn: 1, id: 't1', status: 'failed' });
    await h1.close();
    await p1.close();

    // Corrupt index.json so restart rebuilds summary from body too.
    const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
    writeFileSync(join(stateRoot, 'session', digest, 'index.json'), 'not-json', 'utf8');

    const p2 = createJsonlPersistence({ stateRoot, workspaceRoot });
    expect(p2.read('s-summary')).toHaveLength(6);
    const summary = p2.stat('s-summary');
    expect(summary?.title).toBe('Pinned Task');
    expect(summary?.manualTitle).toBe(true);
    expect(summary?.archived).toBe(true);
    expect(summary?.pinned).toBe(true);
    expect(summary?.lastTurn).toMatchObject({
      status: 'failed',
      turn: 1,
      errorKind: 'rate_limited',
      errorMessage: 'slow down',
      retryAt: '2026-11-18T12:05:00.000Z',
    });
    await p2.close();
  });

  it('normalizes legacy stored event shapes via compat.ts', () => {
    const normalized = normalizeStoredEvent({
      type: 'call.started',
      seq: 3,
      at: '2026-11-18T00:00:00.000Z',
      turn: 2,
      cycle: 1,
      callId: 'c1',
      role: 'doc-search',
      model: 'openai/gpt-4o-mini',
    });
    expect(normalized).toEqual({
      type: 'span.started',
      seq: 3,
      at: '2026-11-18T00:00:00.000Z',
      turn: 2,
      step: 1,
      id: 'c1',
      parent: 't2.1',
      kind: 'auxiliary',
      request: {
        role: 'search',
        model: 'openai/gpt-4o-mini',
        inputEstimate: 0,
        layers: {},
      },
    });
  });

  it('does not cache an empty summary or page when reading a non-existent session', async () => {
    const { stateRoot, workspaceRoot } = openRoots();
    const persistence = createJsonlPersistence({ stateRoot, workspaceRoot });

    expect(persistence.read('missing-session')).toEqual([]);
    expect(persistence.stat('missing-session')).toBeUndefined();
    expect(persistence.list()).toEqual([]);
    expect(() => persistence.readPage('missing-session', 0, 10)).toThrow(SessionNotFoundError);

    await persistence.close();
  });

  it('passes isSeed into beforeAppend only for seed drafts on create', async () => {
    const { stateRoot, workspaceRoot } = openRoots();
    const persistence = createJsonlPersistence({
      stateRoot,
      workspaceRoot,
      beforeAppend: ({ draft, fromExclusive, isSeed }) => {
        if (isSeed === true) {
          return { action: 'append', draft };
        }
        if (draft.type === 'workspace.changed' && draft.scope === 'document' && fromExclusive !== true) {
          throw new Error('Document changes must use commitDocument');
        }
        if (draft.type === 'document.content' && draft.source === 'write' && fromExclusive !== true) {
          throw new Error('Document writes must use commitDocument');
        }
        return { action: 'append', draft };
      },
    });

    const handle = await persistence.create(
      'forked-session',
      [
        {
          type: 'document.content',
          path: 'docs/spec.md',
          title: 'Spec',
          updated: '2026-11-18T00:00:00.000Z',
          version: 'v2',
          tokens: 10,
          source: 'write',
          format: 'diff',
          base: 'v1',
          content: '@@ -1 +1 @@\n-old\n+new\n',
        },
        {
          type: 'workspace.changed',
          parent: 'a1',
          scope: 'document',
          target: 'docs/spec.md',
          change: 'updated',
        },
      ],
      { isSeed: true },
    );

    expect(handle.read().map((event) => event.type)).toEqual([
      'document.content',
      'workspace.changed',
    ]);

    await expect(handle.append({
      type: 'workspace.changed',
      parent: 'a1',
      scope: 'document',
      target: 'docs/spec.md',
      change: 'updated',
    })).rejects.toThrow('Document changes must use commitDocument');

    await handle.close();
    await persistence.close();
  });
});
