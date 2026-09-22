import type { ForemanEvent, ForemanEventSink } from './event-types.mts'

export class ForemanEventBus {
  private readonly sinks = new Set<ForemanEventSink>()

  subscribe(sink: ForemanEventSink): () => void {
    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }

  async publish(event: ForemanEvent): Promise<void> {
    const settled = await Promise.allSettled(
      [...this.sinks].map((sink) => Promise.resolve().then(() => sink.handle(event))),
    )

    for (const result of settled) {
      if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        process.stderr.write(`[foreman-events] sink failed: ${message}\n`)
      }
    }
  }

  clear(): void {
    this.sinks.clear()
  }
}

const defaultForemanEventBus = new ForemanEventBus()

export function getForemanEventBus(): ForemanEventBus {
  return defaultForemanEventBus
}

export async function publishForemanEvent(event: ForemanEvent): Promise<void> {
  await defaultForemanEventBus.publish(event)
}

export function resetForemanEventBusForTest(): void {
  defaultForemanEventBus.clear()
}
