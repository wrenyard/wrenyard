import { describe, expect, it, vi } from 'vitest';

import {
  ProjectionCache,
  Timeline,
  type Projector,
  type SessionEventBase,
} from '../src/index.ts';

// Source: 2026-11-18-session-module-architecture.md
interface ProjectionTestEvent extends SessionEventBase {
  text?: string;
}

describe('ProjectionCache', () => {
  it('memoizes fold results until lastSeq or replaceGeneration changes', () => {
    const timeline = new Timeline<ProjectionTestEvent>([
      { seq: 1, at: '2026-11-18T00:00:00Z', type: 'note', text: 'one' },
      { seq: 2, at: '2026-11-18T00:00:01Z', type: 'note', text: 'two' },
    ]);
    const cache = new ProjectionCache(timeline);

    const fold = vi.fn((active: readonly ProjectionTestEvent[], all: readonly ProjectionTestEvent[]) => ({
      activeTexts: active.map((e) => e.text ?? ''),
      total: all.length,
    }));
    const projector: Projector<ProjectionTestEvent, { activeTexts: string[]; total: number }> = {
      id: 'summary-view',
      fold,
    };

    const first = cache.get(projector);
    const second = cache.get(projector);
    expect(first).toBe(second);
    expect(fold).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ activeTexts: ['one', 'two'], total: 2 });

    timeline.commitDraft(
      {
        type: 'summary',
        text: 'compacted',
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      },
      '2026-11-18T00:00:02Z',
    );
    const third = cache.get(projector);
    expect(fold).toHaveBeenCalledTimes(2);
    expect(third).toEqual({ activeTexts: ['compacted'], total: 3 });

    // Replacing timeline with the same lastSeq still invalidates via replaceGeneration.
    timeline.reset([
      { seq: 1, at: '2026-11-18T00:00:00Z', type: 'note', text: 'rewritten-1' },
      { seq: 2, at: '2026-11-18T00:00:01Z', type: 'note', text: 'rewritten-2' },
      { seq: 3, at: '2026-11-18T00:00:02Z', type: 'note', text: 'rewritten-3' },
    ]);
    const fourth = cache.get(projector);
    expect(fold).toHaveBeenCalledTimes(3);
    expect(fourth).toEqual({
      activeTexts: ['rewritten-1', 'rewritten-2', 'rewritten-3'],
      total: 3,
    });
  });
});
