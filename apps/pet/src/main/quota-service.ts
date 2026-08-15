import { spawn } from 'node:child_process';
import type { DiagnosticLogger } from './diagnostic-logger';
import type { QuotaProviderState, QuotaWindowRow } from '../shared/entities';

/** Timeout for the forge quota --json child process. Exported so tests
 *  and callers can verify the budget without real-time waiting. */
export const FORGE_QUOTA_TIMEOUT_MS = 30_000;

export interface QuotaServiceOptions {
  logger?: DiagnosticLogger;
  cacheTtlMs?: number;
}

export class QuotaService {
  private readonly logger: DiagnosticLogger | undefined;
  private readonly cacheTtlMs: number;
  private cache: { providers: QuotaProviderState[]; fetchedAt: number } | null = null;
  private pending: Promise<QuotaProviderState[]> | null = null;

  constructor(opts?: QuotaServiceOptions) {
    this.logger = opts?.logger;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 60_000;
  }

  async listProviders(forceRefresh = false): Promise<QuotaProviderState[]> {
    if (!forceRefresh && this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.providers;
    }

    if (this.pending) return this.pending;

    this.pending = this.fetchProviders().finally(() => {
      this.pending = null;
    });

    return this.pending;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private async fetchProviders(): Promise<QuotaProviderState[]> {
    try {
      const output = await runForgeQuotaJson();
      const providers = parseQuotaJson(output);
      this.cache = { providers, fetchedAt: Date.now() };
      return providers;
    } catch (err) {
      this.logger?.warn('quota_fetch_error', {
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      });
      return [];
    }
  }
}

/**
 * Resolve the runtime command used to query quota. Order:
 *  1. non-empty WRENYARD_RUNTIME_BIN;
 *  2. non-empty legacy WRENYARD_FORGE_BIN;
 *  3. `forge` as an unmanaged-development fallback.
 * Keeps the Pet provider-agnostic and independent of PATH/legacy launchers.
 */
export function resolveQuotaRuntimeCommand(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runtimeBin = env.WRENYARD_RUNTIME_BIN?.trim()
  if (runtimeBin) return runtimeBin
  const forgeBin = env.WRENYARD_FORGE_BIN?.trim()
  if (forgeBin) return forgeBin
  return 'forge'
}

function runForgeQuotaJson(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(resolveQuotaRuntimeCommand(), ['quota', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      timeout: FORGE_QUOTA_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`forge quota --json exited with code ${code}: ${stderr.trim() || '(no stderr)'}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn forge quota --json: ${err.message}`));
    });
  });
}

interface RawQuotaEntry {
  pool?: string;
  label?: string;
  status?: string;
  error?: string;
  code?: string;
  message?: string;
  display_line?: string;
  fetched_at?: string;
  stale?: boolean;
  /** Provider-level remaining/expected percentages */
  remaining_pct?: number;
  expected_remaining_pct?: number;
  /** Per-window rows */
  windows?: Array<{
    name?: string;
    pct?: number;
    used_pct?: number;
    remaining_pct?: number;
    expected_remaining_pct?: number;
  }>;
}

function isFiniteZeroToOneHundred(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}

function parseWindowBars(e: RawQuotaEntry): QuotaProviderState['bars'] {
  let windows: QuotaWindowRow[] = [];

  if (Array.isArray(e.windows) && e.windows.length > 0) {
    windows = e.windows
      .filter((w): w is NonNullable<typeof e.windows>[number] & { name: string } =>
        typeof w === 'object' && w !== null && typeof w.name === 'string' && w.name.length > 0
      )
      .map((w) => {
        // Select usage from used_pct (preferred), then pct, then 0
        const usedPct = isFiniteZeroToOneHundred(w.used_pct) ? w.used_pct : (isFiniteZeroToOneHundred(w.pct) ? w.pct : 0);
        const remainingPct = isFiniteZeroToOneHundred(w.remaining_pct)
          ? w.remaining_pct
          : (isFiniteZeroToOneHundred(w.used_pct) ? Math.round((100 - w.used_pct) * 10) / 10
             : (isFiniteZeroToOneHundred(w.pct) ? Math.round((100 - w.pct) * 10) / 10 : 0));
        const expectedRemainingPct = isFiniteZeroToOneHundred(w.expected_remaining_pct)
          ? w.expected_remaining_pct
          : null;
        return { name: w.name, usedPct, remainingPct, expectedRemainingPct };
      });
    // All windows filtered out but original array had entries => invalid
    if (windows.length === 0 && Array.isArray(e.windows) && e.windows.length > 0) return undefined;
  }

  // Provider-level remaining/expected (used when windows are empty or alongside windows)
  const remainingPct = isFiniteZeroToOneHundred(e.remaining_pct) ? e.remaining_pct : null;
  const expectedRemainingPct = isFiniteZeroToOneHundred(e.expected_remaining_pct) ? e.expected_remaining_pct : null;

  // Return bars if we have windows or provider-level data
  if (windows.length > 0 || remainingPct !== null) {
    return { remainingPct, expectedRemainingPct, windows };
  }
  return undefined;
}

export function parseQuotaJson(raw: string): QuotaProviderState[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new TypeError('forge quota --json output must be a JSON array');
  }

  const results: QuotaProviderState[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== 'object') continue;

    const e = entry as RawQuotaEntry;
    const id = e.pool ?? `pool-${i}`;
    const label = typeof e.label === 'string' ? e.label : id;
    const displayLine = typeof e.display_line === 'string' && e.display_line.length > 0 ? e.display_line : null;
    // Forge-provided message takes precedence over the error field; both are
    // preserved generically so pending/error rows can surface the message.
    const error =
      typeof e.message === 'string' && e.message.length > 0
        ? e.message
        : typeof e.error === 'string' && e.error.length > 0
          ? e.error
          : null;
    const stale = e.stale === true;

    // Passive Forge code metadata (e.g. `authentication_pending`). Preserved
    // generically; status/message/error stay independent and code never
    // triggers provider-specific behavior.
    const code = typeof e.code === 'string' && e.code.length > 0 ? e.code : null;

    const status = e.status === 'pending'
      ? 'pending'
      : displayLine
        ? 'ok'
        : error
          ? 'error'
          : 'unavailable';

    const bars = parseWindowBars(e);

    results.push({
      id,
      label,
      displayLine,
      error,
      status,
      stale,
      code,
      bars,
    });
  }

  return results;
}
