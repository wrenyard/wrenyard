import { describe, it, expect } from 'vitest';
import { SiteModel } from '../src/main/site-model';
import type { SiteSnapshot, WorkerSnapshot } from '../src/shared/snapshot';
import { buildInfoCard } from '../src/main/hover-controller';
import type { SessionMetaData } from '../src/main/forge-types';

function makeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
    get: () => t,
  };
}

function findWorker(snap: SiteSnapshot, workerIdentityKey: string): WorkerSnapshot | undefined {
  return snap.workers.find(w => w.workerIdentityKey === workerIdentityKey);
}

function makeMeta(overrides: Partial<SessionMetaData> = {}): SessionMetaData {
  return {
    workerIdentityKey: 's1',
    profile: 'codex',
    workDir: '/tmp/test',
    isWorktree: false,
    status: 'running',
    project: 'test',
    ...overrides,
  };
}

// ─── Normalized Foreman event signals ───────────────────────────────

describe('SiteModel — normalized Foreman event signals', () => {
  it('message sets first bubble source text and updates last text', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    const meta = makeMeta({ workerIdentityKey: 'fg_msg', profile: 'codex' });

    m.ingest({ kind: 'message', role: 'assistant', text: 'Opening sentence.', ts: 2000 }, meta);
    let w = findWorker(m.snapshot(), 'fg_msg')!;
    expect(w.phase).toBe('working');
    expect(w.firstSentence).toBe('Opening sentence.');
    expect(w.lastText).toBe('Opening sentence.');

    m.ingest({ kind: 'message', role: 'assistant', text: 'Second update.', ts: 3000 }, meta);
    w = findWorker(m.snapshot(), 'fg_msg')!;
    expect(w.firstSentence).toBe('Opening sentence.');
    expect(w.lastText).toBe('Second update.');
  });

  it('tool_call increments toolCount and records the latest tool name for wrench flashing', () => {
    const m = new SiteModel({ now: () => 1000 });
    const meta = makeMeta({ workerIdentityKey: 'fg_tool' });

    m.ingest({ kind: 'spawn', ts: 1000 }, meta);
    m.ingest({ kind: 'tool_call', name: 'Read', callId: 'c1', inputSummary: 'src', ts: 2000 }, meta);
    m.ingest({ kind: 'tool_call', name: 'Bash', callId: 'c2', inputSummary: 'npm test', ts: 3000 }, meta);

    const w = findWorker(m.snapshot(), 'fg_tool')!;
    expect(w.toolCount).toBe(2);
    expect(w.lastToolName).toBe('Bash');
  });

  it('tool_result and turn_usage populate hover card data', () => {
    const m = new SiteModel({ now: () => 1000 });
    const meta = makeMeta({ workerIdentityKey: 'fg_hover' });

    m.ingest({ kind: 'spawn', ts: 1000 }, meta);
    m.ingest({
      kind: 'tool_result',
      callId: 'c1',
      status: 'error',
      outputTail: 'TS2345: type mismatch',
      ts: 2000,
    }, meta);
    m.ingest({
      kind: 'turn_usage',
      inputTokens: 1200,
      outputTokens: 340,
      durationMs: 4500,
      ts: 3000,
    }, meta);

    const w = findWorker(m.snapshot(), 'fg_hover')!;
    expect(w.lastToolStatus).toBe('error');
    expect(w.lastToolOutputTail).toBe('TS2345: type mismatch');
    expect(w.inputTokens).toBe(1200);
    expect(w.outputTokens).toBe(340);
    expect(w.durationMs).toBe(4500);

    const card = buildInfoCard(w, 10_000);
    expect(card.status).toBe('error');
    expect(card.tail).toBe('TS2345: type mismatch');
    expect(card.inputTokens).toBe(1200);
    expect(card.outputTokens).toBe(340);
    expect(card.durationMs).toBe(4500);
  });

  it('terminal normalized events enter farewell phases before departure', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    const meta = makeMeta({ workerIdentityKey: 'fg_term' });

    m.ingest({ kind: 'spawn', ts: 1000 }, meta);
    m.ingest({ kind: 'done', ts: 2000 }, meta);
    expect(findWorker(m.snapshot(), 'fg_term')!.phase).toBe('celebrating');

    c.set(2000 + CELEBRATE_MS - 100);
    m.tick();
    expect(findWorker(m.snapshot(), 'fg_term')!.phase).toBe('celebrating');

    c.set(2000 + CELEBRATE_MS + 100);
    m.tick();
    expect(findWorker(m.snapshot(), 'fg_term')).toBeUndefined();
  });

  it('uses terminal summary as the farewell bubble text', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    const meta = makeMeta({ workerIdentityKey: 'fg_summary', profile: 'codex' });

    m.ingest({ kind: 'spawn', ts: 1000 }, meta);
    m.ingest({
      kind: 'message',
      role: 'assistant',
      text: '<foreman-task-output><summary>Raw model delivery text stays raw.</summary><result>{"ok":true}</result></foreman-task-output>',
      ts: 2000,
    }, meta);

    let w = findWorker(m.snapshot(), 'fg_summary')!;
    expect(w.lastText).toContain('<foreman-task-output>');

    c.set(3000);
    m.ingest({ kind: 'done', ts: 3000, summary: 'Implemented summary bubbles.' }, meta);
    w = findWorker(m.snapshot(), 'fg_summary')!;
    expect(w.phase).toBe('celebrating');
    expect(w.lastText).toBe('Implemented summary bubbles.');
    expect(w.bubbleUntilMs).toBe(7000);
  });

  it('does not parse raw JSON messages as farewell summaries', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    const meta = makeMeta({ workerIdentityKey: 'fg_json', profile: 'cb-dsf' });

    m.ingest({ kind: 'spawn', ts: 1000 }, meta);
    m.ingest({
      kind: 'message',
      role: 'assistant',
      text: '```json\n{"status":"done","summary":"Removed legacy cleanup tests."}\n```',
      ts: 2000,
    }, meta);

    c.set(3000);
    m.ingest({ kind: 'done', ts: 3000 }, meta);

    const w = findWorker(m.snapshot(), 'fg_json')!;
    expect(w.lastText).toContain('```json');
  });

  it('codex regression: normalized message works without a family parser', () => {
    const m = new SiteModel({ now: () => 1000 });
    const meta = makeMeta({ workerIdentityKey: 'fg_codex', profile: 'codex-high' });

    m.ingest({ kind: 'spawn', ts: 1000 }, meta);
    m.ingest({ kind: 'message', role: 'assistant', text: 'Codex normalized text.', ts: 2000 }, meta);

    const w = findWorker(m.snapshot(), 'fg_codex')!;
    expect(w.profile).toBe('codex-high');
    expect(w.firstSentence).toBe('Codex normalized text.');
    expect(w.lastText).toBe('Codex normalized text.');
  });
});

// ─── Spawn on LifecycleSignal (Task 9) ──────────────────────────────

describe('SiteModel — spawn on LifecycleSignal', () => {
  it('{kind:queued} increments queuedCount without creating a worker', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    const meta = makeMeta({ workerIdentityKey: 'queued-1', profile: 'cb-ds' });

    m.ingest({ kind: 'queued', ts: 1000 }, meta);
    const snap = m.snapshot();

    expect(snap.queuedCount).toBe(1);
    expect(findWorker(snap, 'queued-1')).toBeUndefined();
  });

  it('active or terminal events clear queuedCount for that task', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    const meta = makeMeta({ workerIdentityKey: 'queued-2', profile: 'cb-ds' });

    m.ingest({ kind: 'queued', ts: 1000 }, meta);
    expect(m.snapshot().queuedCount).toBe(1);

    m.ingest({ kind: 'working', ts: 2000 }, meta);
    let snap = m.snapshot();
    expect(snap.queuedCount).toBe(0);
    expect(findWorker(snap, 'queued-2')).toBeDefined();

    m.ingest({ kind: 'queued', ts: 3000 }, meta);
    expect(m.snapshot().queuedCount).toBe(1);

    m.ingest({ kind: 'done', ts: 4000 }, meta);
    snap = m.snapshot();
    expect(snap.queuedCount).toBe(0);
    expect(findWorker(snap, 'queued-2')).toBeUndefined();
  });

  it('spawns worker in working phase on {kind:spawn}', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp/test', isWorktree: false, status: 'running' });
    const w = findWorker(m.snapshot(), 's1')!;
    expect(w).toBeDefined();
    expect(w.phase).toBe('working');
    expect(w.workerIdentityKey).toBe('s1');
    expect(w.profile).toBe('cb-dsf');
    expect(w.toolCount).toBe(0);
    expect(w.startedAt).toBe(1000);
  });

  it('{kind:working} signal keeps worker in working phase', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp/test', isWorktree: false, status: 'running' });
    c.advance(5000);
    m.ingest({ kind: 'working', ts: 6000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp/test', isWorktree: false, status: 'running' });
    const w = findWorker(m.snapshot(), 's1')!;
    expect(w.phase).toBe('working');
  });
});

// ─── Sleeping phase (Task 10) ───────────────────────────────────────

describe('SiteModel — sleeping phase', () => {
  it('{kind:sleeping} transitions working -> sleeping', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-ds', workDir: '/tmp', isWorktree: false, status: 'running' });
    c.advance(3000);
    m.ingest({ kind: 'sleeping', ts: 4000 }, { workerIdentityKey: 's1', profile: 'cb-ds', workDir: '/tmp', isWorktree: false, status: 'running' });
    const w = findWorker(m.snapshot(), 's1')!;
    expect(w.phase).toBe('sleeping');
  });

  it('{kind:working} from sleeping returns to working', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-ds', workDir: '/tmp', isWorktree: false, status: 'running' });
    m.ingest({ kind: 'sleeping', ts: 2000 }, { workerIdentityKey: 's1', profile: 'cb-ds', workDir: '/tmp', isWorktree: false, status: 'running' });
    expect(findWorker(m.snapshot(), 's1')!.phase).toBe('sleeping');
    m.ingest({ kind: 'working', ts: 3000 }, { workerIdentityKey: 's1', profile: 'cb-ds', workDir: '/tmp', isWorktree: false, status: 'running' });
    expect(findWorker(m.snapshot(), 's1')!.phase).toBe('working');
  });

  it('no silent dozing: ticking without activity does NOT auto-transition to sleeping', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-ds', workDir: '/tmp', isWorktree: false, status: 'running' });
    // Advance a large amount of time with no signals
    c.advance(30 * 60 * 1000); // 30 min
    m.tick();
    // Worker must NOT auto-doze — sleeping only via explicit signal
    expect(findWorker(m.snapshot(), 's1')!.phase).toBe('working');
  });
});

// ─── Terminal phases and departure (Task 11) ─────────────────────────

const CELEBRATE_MS = 4000;
const DEJECTED_MS = 4000;

describe('SiteModel — terminal phases and departure', () => {
  it('{kind:done} transitions to celebrating, exits after 4s', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    c.set(2000);
    m.ingest({ kind: 'done', ts: 2000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    let w = findWorker(m.snapshot(), 's1')!;
    expect(w.phase).toBe('celebrating');

    // Still celebrating at 3.9s
    c.advance(CELEBRATE_MS - 100);
    m.tick();
    w = findWorker(m.snapshot(), 's1')!;
    expect(w.phase).toBe('celebrating');

    // Departed after 4s
    c.advance(200);
    m.tick();
    expect(findWorker(m.snapshot(), 's1')).toBeUndefined();
  });

  it('{kind:failed} transitions to dejected, exits after 4s', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    c.set(2000);
    m.ingest({ kind: 'failed', ts: 2000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    let w = findWorker(m.snapshot(), 's1')!;
    expect(w.phase).toBe('dejected');

    c.advance(DEJECTED_MS - 100);
    m.tick();
    w = findWorker(m.snapshot(), 's1')!;
    expect(w.phase).toBe('dejected');

    c.advance(200);
    m.tick();
    expect(findWorker(m.snapshot(), 's1')).toBeUndefined();
  });

  it('{kind:terminate} removes worker immediately with no linger', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    expect(findWorker(m.snapshot(), 's1')).toBeDefined();
    m.ingest({ kind: 'terminate' }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    expect(findWorker(m.snapshot(), 's1')).toBeUndefined();
  });
});

// ─── ToolUseSignal and TextSignal tracking (Task 12) ─────────────────

describe('SiteModel — ToolUseSignal and TextSignal tracking', () => {
  it('tool_use increments toolCount', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    m.ingestToolUse({ name: 'read_file', ts: 2000 }, 's1');
    m.ingestToolUse({ name: 'write_file', ts: 3000 }, 's1');
    m.ingestToolUse({ name: 'bash', ts: 4000 }, 's1');
    const w = findWorker(m.snapshot(), 's1')!;
    expect(w.toolCount).toBe(3);
  });

  it('text_signal sets firstSentence on first text, lastText on every text', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    m.ingestText({ text: 'Let me check the codebase.', ts: 2000 }, 's1');
    let w = findWorker(m.snapshot(), 's1')!;
    expect(w.firstSentence).toBe('Let me check the codebase.');
    expect(w.lastText).toBe('Let me check the codebase.');

    m.ingestText({ text: 'I found the bug.', ts: 3000 }, 's1');
    w = findWorker(m.snapshot(), 's1')!;
    expect(w.firstSentence).toBe('Let me check the codebase.'); // unchanged
    expect(w.lastText).toBe('I found the bug.');
  });

  it('tool_use for unknown workerIdentityKey is a no-op (no crash)', () => {
    const m = new SiteModel({ now: () => 1000 });
    expect(() => m.ingestToolUse({ name: 'bash', ts: 1000 }, 'unknown')).not.toThrow();
    expect(m.snapshot().workers).toHaveLength(0);
  });

  it('text_signal for unknown workerIdentityKey is a no-op (no crash)', () => {
    const m = new SiteModel({ now: () => 1000 });
    expect(() => m.ingestText({ text: 'hello', ts: 1000 }, 'unknown')).not.toThrow();
    expect(m.snapshot().workers).toHaveLength(0);
  });
});

// ─── Broadcast and onChange (Task 13) ────────────────────────────────

describe('SiteModel — broadcast and onChange', () => {
  it('setBroadcast emits broadcast on snapshot', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.setBroadcast({ text: 'All tasks complete!', untilMs: 5000 });
    const snap = m.snapshot();
    expect(snap.broadcast).toBeDefined();
    expect(snap.broadcast!.text).toBe('All tasks complete!');
    expect(snap.broadcast!.intensity).toBe('sticky');
    expect(snap.broadcast!.untilMs).toBe(5000);
  });

  it('default broadcast is sticky and does not expire at untilMs', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.setBroadcast({ text: 'Hello', untilMs: 3000 });
    expect(m.snapshot().broadcast).toBeDefined();

    c.advance(2500);
    m.tick();
    expect(m.snapshot().broadcast).toBeDefined();
  });

  it('transient broadcast expires after untilMs', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.setBroadcast({ text: 'Hello', intensity: 'transient', untilMs: 3000 });
    expect(m.snapshot().broadcast).toBeDefined();

    c.advance(2500);
    m.tick();
    expect(m.snapshot().broadcast).toBeUndefined();
  });

  it('clearBroadcast dismisses the current broadcast', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.setBroadcast({ id: 'notice-1', text: 'Hello' });
    m.clearBroadcast('notice-1');
    expect(m.snapshot().broadcast).toBeUndefined();
  });

  it('onChange fires on every state-affecting operation', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    const snaps: SiteSnapshot[] = [];
    m.onChange(s => snaps.push(s));

    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].workers).toHaveLength(1);

    m.ingestToolUse({ name: 'bash', ts: 2000 }, 's1');
    expect(snaps).toHaveLength(2);
    expect(snaps[1].workers[0].toolCount).toBe(1);

    m.ingestText({ text: 'hello', ts: 3000 }, 's1');
    expect(snaps).toHaveLength(3);
    expect(snaps[2].workers[0].lastText).toBe('hello');
  });

  it('multiple workers do not interfere', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    m.ingest({ kind: 'spawn', ts: 1000 }, { workerIdentityKey: 's1', profile: 'cb-dsf', workDir: '/tmp', isWorktree: false, status: 'running' });
    m.ingest({ kind: 'spawn', ts: 2000 }, { workerIdentityKey: 's2', profile: 'codex', workDir: '/tmp2', isWorktree: false, status: 'running' });
    m.ingestToolUse({ name: 'bash', ts: 3000 }, 's1');
    const snap = m.snapshot();
    expect(snap.workers).toHaveLength(2);
    const w1 = findWorker(snap, 's1')!;
    const w2 = findWorker(snap, 's2')!;
    expect(w1.toolCount).toBe(1);
    expect(w2.toolCount).toBe(0);
  });
});

// ─── Meta merge regression (Task 8) ──────────────────────────────────

describe('SiteModel — meta merge preserves taskLabel', () => {
  it('taskLabel from spawn meta survives later tool_call meta that omits taskName and taskLabel', () => {
    const c = makeClock(1000);
    const m = new SiteModel({ now: c.now });
    // Spawn with full task metadata
    const spawnMeta = {
      workerIdentityKey: 'fg_merge',
      profile: 'codex',
      workDir: '/tmp/test',
      isWorktree: false,
      status: 'running' as const,
      taskId: 'task-42',
      taskName: 'refactor-auth',
      taskLabel: 'refactor-auth',
    };
    m.ingest({ kind: 'spawn', ts: 1000 }, spawnMeta);
    let w = findWorker(m.snapshot(), 'fg_merge')!;
    expect(w.meta.taskLabel).toBe('refactor-auth');
    expect(w.meta.taskName).toBe('refactor-auth');
    expect(w.meta.taskId).toBe('task-42');

    // tool_call with minimal meta (no taskName or taskLabel)
    const minimalMeta = {
      workerIdentityKey: 'fg_merge',
      profile: 'codex',
      workDir: '/tmp/test',
      isWorktree: false,
      status: 'running' as const,
    };
    m.ingest({ kind: 'tool_call', name: 'Read', callId: 'c1', ts: 2000 }, minimalMeta);
    w = findWorker(m.snapshot(), 'fg_merge')!;
    // taskLabel must survive the merge
    expect(w.meta.taskLabel).toBe('refactor-auth');
    expect(w.meta.taskName).toBe('refactor-auth');
    expect(w.meta.taskId).toBe('task-42');
  });
});
