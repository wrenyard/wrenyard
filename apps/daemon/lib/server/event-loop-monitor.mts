import { monitorEventLoopDelay } from 'node:perf_hooks'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_WARN_MS = 200

/**
 * Samples the event-loop delay histogram on an unref'd interval and warns only
 * when the windowed p99 meets the threshold. Only aggregate delay numbers are
 * reported. The returned function clears the timer and disables the histogram.
 */
export function startEventLoopDelayMonitor(opts: {
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void
  intervalMs?: number
  warnMs?: number
}): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const warnMs = opts.warnMs ?? DEFAULT_WARN_MS
  const histogram = monitorEventLoopDelay()
  histogram.enable()

  const timer = setInterval(() => {
    // perf_hooks histogram values are nanoseconds; report milliseconds.
    const meanMs = histogram.mean / 1e6
    const p99Ms = histogram.percentile(99) / 1e6
    const maxMs = histogram.max / 1e6
    histogram.reset()
    if (p99Ms >= warnMs) {
      const round = (value: number): number => Math.round(value * 10) / 10
      opts.log('warn', 'event loop delay high', {
        meanMs: round(meanMs),
        p99Ms: round(p99Ms),
        maxMs: round(maxMs),
        windowMs: intervalMs,
      })
    }
  }, intervalMs)
  timer.unref()

  return () => {
    clearInterval(timer)
    histogram.disable()
  }
}
