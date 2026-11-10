import type { ReasoningEffort } from '../base/contracts.ts';

/** The public models.dev document the OpenCode client itself consumes. */
export const OPENCODE_CATALOG_URL = 'https://models.dev/api.json';

/** Operational override so verification can point at a mirror. */
const CATALOG_URL_ENV = 'WRENYARD_OPENCODE_CATALOG_URL';

/** The published document is ~5.5 MiB; 32 MiB leaves room without letting a
 * misbehaving mirror stream unbounded bytes into the daemon. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 15_000;

/** Only these levels are real route efforts. Upstream also lists `minimal`,
 * which has no product mapping, so unknown values are dropped instead of being
 * exposed as a level the route cannot materialize. */
const KNOWN_EFFORT_LEVELS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/** One free offering as reported by the live catalog. */
export interface OpenCodeCatalogRow {
  readonly id: string;
  readonly name: string;
  readonly context: number;
  readonly output: number;
  readonly efforts: readonly ReasoningEffort[];
}

export interface OpenCodeCatalogOptions {
  /** Injectable for deterministic tests and offline mirrors. */
  readonly fetch?: typeof fetch;
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read the body with a hard byte ceiling; a declared oversize body is
 * rejected before it is read. */
async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`OpenCode catalog response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`OpenCode catalog response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Effort levels a model advertises. Only `reasoning_options` entries of type
 * `effort` contribute values; a toggle-only or empty list yields no explicit
 * level, which the caller materializes as the provider default.
 */
function effortsOf(model: Record<string, unknown>): readonly ReasoningEffort[] {
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  const advertised = new Set<string>();
  for (const option of options) {
    if (!isRecord(option) || option.type !== 'effort') continue;
    if (!Array.isArray(option.values)) continue;
    for (const value of option.values) if (typeof value === 'string') advertised.add(value);
  }
  return KNOWN_EFFORT_LEVELS.filter((level) => advertised.has(level));
}

/**
 * Fetch the live catalog and return the current free OpenCode rows. A row is
 * free only when both input and output cost are exactly zero and the upstream
 * has not marked it deprecated: the promotion lifecycle is expressed upstream
 * (deprecation / removal), never by a date in this repository.
 */
export async function fetchOpenCodeFreeRows(
  options: OpenCodeCatalogOptions = {},
): Promise<OpenCodeCatalogRow[]> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = process.env[CATALOG_URL_ENV] ?? OPENCODE_CATALOG_URL;
  const response = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenCode catalog request failed: HTTP ${response.status}`);
  }
  const bytes = await readBounded(response);
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('OpenCode catalog returned invalid JSON');
  }
  const provider = isRecord(document) ? document.opencode : undefined;
  const models = isRecord(provider) ? provider.models : undefined;
  if (!isRecord(models)) throw new Error('OpenCode catalog does not contain the opencode provider');

  const rows: OpenCodeCatalogRow[] = [];
  for (const [id, raw] of Object.entries(models)) {
    if (!isRecord(raw)) continue;
    const cost = isRecord(raw.cost) ? raw.cost : undefined;
    if (cost?.input !== 0 || cost.output !== 0) continue;
    if (raw.status === 'deprecated') continue;
    const limit = isRecord(raw.limit) ? raw.limit : undefined;
    rows.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : id,
      context: positiveInteger(limit?.context),
      output: positiveInteger(limit?.output),
      efforts: effortsOf(raw),
    });
  }
  return rows;
}
