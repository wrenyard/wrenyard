import type { Projector } from './ports.ts';
import type { Timeline } from './timeline.ts';
import type { SessionEventBase } from './types.ts';

interface CachedEntry<TView> {
  lastSeq: number;
  replaceGeneration: number;
  view: TView;
}

/**
 * Memoizes per-projector fold outputs over a {@link Timeline}, invalidating on
 * sequence advance or surface replacement.
 */
export class ProjectionCache<E extends SessionEventBase> {
  private readonly cache = new Map<string, CachedEntry<unknown>>();

  constructor(private readonly timeline: Timeline<E>) {}

  get<TView>(projector: Projector<E, TView>): TView {
    const lastSeq = this.timeline.lastSeq;
    const replaceGeneration = this.timeline.replaceGeneration;
    const cached = this.cache.get(projector.id);
    if (
      cached !== undefined
      && cached.lastSeq === lastSeq
      && cached.replaceGeneration === replaceGeneration
    ) {
      return cached.view as TView;
    }
    const allEvents = this.timeline.read();
    const activeEvents = this.timeline.activeSurfaceEvents({
      isSurfaceEvent: projector.isSurfaceEvent,
      replaceRange: projector.replaceRange,
    });
    const view = projector.fold(activeEvents, allEvents);
    this.cache.set(projector.id, { lastSeq, replaceGeneration, view });
    return view;
  }

  invalidate(projectorId?: string): void {
    if (projectorId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(projectorId);
    }
  }
}
