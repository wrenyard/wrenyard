/**
 * The one usability rule and aggregation for tokenizer speed samples, shared
 * by the daemon's Task speed estimate and the Desktop session status bar.
 *
 * A sample is tokens generated over a first-to-last-delta window. The rule
 * rejects only samples that carry no usable timing — a collapsed or buffered
 * stream, a handful of tokens, or an implausible rate — and leaves every other
 * sample, however small, to be smoothed by the aggregate. Aggregates are
 * token-weighted (`Σ tokens / Σ window`), so a small sample moves the result
 * only in proportion to its size.
 */

/** A generation sample: tokens observed over a first-to-last-delta window. */
export interface TpsWindowSample {
  outputTokens: number;
  windowMs: number;
}

/** Fewer tokens than this carry no rate worth keeping. */
export const TPS_MIN_SAMPLE_TOKENS = 8;
/** A shorter window is a buffered or collapsed stream, not a generation interval. */
export const TPS_MIN_SAMPLE_WINDOW_MS = 100;
/**
 * A faster implied rate is burst delivery of buffered content, not generation
 * speed. Measured per-sample rates of the routed models stay well below it
 * (p99 about 550 tok/s), while buffered bursts reach several thousand.
 */
export const TPS_MAX_PLAUSIBLE_RATE = 1000;

/** True when a sample has enough tokens and window, and a plausible rate. */
export function isUsableTpsSample(sample: TpsWindowSample | undefined): sample is TpsWindowSample {
  if (sample === undefined) return false;
  const { outputTokens, windowMs } = sample;
  if (!Number.isFinite(outputTokens) || !Number.isFinite(windowMs)) return false;
  if (outputTokens < TPS_MIN_SAMPLE_TOKENS || windowMs < TPS_MIN_SAMPLE_WINDOW_MS) return false;
  return outputTokens / (windowMs / 1000) <= TPS_MAX_PLAUSIBLE_RATE;
}

/** Tokens per second of one sample. */
export function tpsOfSample(sample: TpsWindowSample): number {
  return sample.outputTokens / (sample.windowMs / 1000);
}

/** Token-weighted speed of the usable samples; undefined when none is usable. */
export function weightedTps(samples: readonly (TpsWindowSample | undefined)[]): number | undefined {
  let tokens = 0;
  let windowMs = 0;
  for (const sample of samples) {
    if (!isUsableTpsSample(sample)) continue;
    tokens += sample.outputTokens;
    windowMs += sample.windowMs;
  }
  return tokens > 0 && windowMs > 0 ? tokens / (windowMs / 1000) : undefined;
}

/** Token-weighted speed of the newest `size` usable samples of a chronological list. */
export function rollingTps(samples: readonly (TpsWindowSample | undefined)[], size: number): number | undefined {
  return weightedTps(samples.filter(isUsableTpsSample).slice(-size));
}
