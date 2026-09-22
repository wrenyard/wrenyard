import type { ForemanEvent } from './event-types.mts'
import type { ForemanEventStore, StoredForemanEvent } from './event-store.mts'

export interface EventProjection {
  readonly name: string
  handle(event: ForemanEvent, stored: StoredForemanEvent): void | Promise<void>
}

export class ForemanEventDispatcher {
  private cursor: number

  constructor(
    private readonly store: ForemanEventStore,
    private readonly projections: EventProjection[],
    cursor = 0,
  ) {
    this.cursor = cursor
  }

  getCursor(): number {
    return this.cursor
  }

  async dispatchAvailable(limit = 100): Promise<number> {
    const batch = this.store.listSince(this.cursor, { limit })
    for (const stored of batch) {
      await this.dispatch(stored)
      this.cursor = stored.cursor
    }
    return batch.length
  }

  async run(options: { signal?: AbortSignal; pollIntervalMs?: number; batchSize?: number } = {}): Promise<void> {
    for await (const stored of this.store.listStream(this.cursor, {
      signal: options.signal,
      pollIntervalMs: options.pollIntervalMs,
      limit: options.batchSize,
    })) {
      await this.dispatch(stored)
      this.cursor = stored.cursor
    }
  }

  private async dispatch(stored: StoredForemanEvent): Promise<void> {
    for (const projection of this.projections) {
      await projection.handle(stored.event, stored)
    }
  }
}
