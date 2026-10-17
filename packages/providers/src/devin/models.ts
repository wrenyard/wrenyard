import type { CanonicalModelOverrides } from '../base/model-defaults.ts';
import { resolveProviderModel } from '../base/model-defaults.ts';
import type { ModelDefinition } from '../base/index.ts';
import { models, REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models';
import type { DevinCredentials } from './credentials.ts';
import { Writer, metadata, parseFields, readBounded } from './protocol.ts';

export interface DevinModel extends ModelDefinition {
  variants: Partial<Record<ReasoningEffort, ModelDefinition>>;
}

/** One discovered upstream row before identity resolution. `definition` is the
 * exact transport row (its id is the private upstream UID, never an offering). */
interface DiscoveredRow {
  uid: string;
  name: string;
  family: string;
  context: number;
  output: number;
  free: boolean;
  prices: Map<string, number>;
  /** Transport row before identity resolution: intelligence and speed are
   * identity-owned and attached only after the row resolves to a registration. */
  definition: Omit<ModelDefinition, 'intelligence' | 'speed'>;
}

/** Registry identity lookup. Separator-insensitive so `claude-opus-5.5` and
 * `claude-opus-5-5` name the same identity, but the registered spelling is
 * always what comes back. */
const normalizeIdentity = (value: string): string => value.replaceAll('.', '-').toLowerCase();
const REGISTERED_IDS = models.list().map((entry) => entry.id);

function resolveRegisteredId(uid: string, family: string): string | undefined {
  // An exact registered id is authoritative: the upstream row publishes the
  // registered identity directly.
  if (models.get(uid) !== undefined) return uid;
  const normalizedUid = normalizeIdentity(uid);
  const exactUid = REGISTERED_IDS.find((id) => normalizeIdentity(id) === normalizedUid);
  if (exactUid !== undefined) return exactUid;
  if (family === '') return undefined;
  if (models.get(family) !== undefined) return family;
  const normalizedFamily = normalizeIdentity(family);
  return REGISTERED_IDS.find((id) => normalizeIdentity(id) === normalizedFamily);
}

/** The effort an upstream row names, or the provider-default sentinel. */
function effortOf(uid: string, name: string): ReasoningEffort {
  const suffix = /(?:-|_)(none|low|medium|high|xhigh|max)$/i.exec(uid);
  const label = /\s+(No Thinking|None|Low|Medium|High|XHigh|Max)(?: Thinking)?$/i.exec(name);
  const level = (suffix?.[1] ?? label?.[1])?.toLowerCase().replace('no thinking', 'none');
  return (level ?? 'default') as ReasoningEffort;
}

/** The smallest declared value, or undefined when no variant declares one. */
function minimum(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : Math.min(...known);
}

/** A value every variant agrees on; a disagreement leaves it unknown. */
function agreed<T>(values: readonly (T | undefined)[]): T | undefined {
  if (values.length === 0) return undefined;
  return values.every((value) => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : undefined;
}

// Field numbers and Free tier 4 follow magpie-community/devin 0.1.18.
export async function fetchDevinModels(credentials: DevinCredentials, fetcher: typeof fetch): Promise<DevinModel[]> {
  const response = await fetcher(credentials.server + '/exa.api_server_pb.ApiServerService/GetCliModelConfigs', {
    method: 'POST', headers: { 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1' },
    body: Buffer.from(new Writer().bytes(1, metadata(credentials.key)).done()), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Devin model discovery failed: HTTP ' + response.status); }
  const rows: DiscoveredRow[] = [];
  const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);
  for (const entry of parseFields(await readBounded(response, 8 * 1024 * 1024))) {
    if (entry.num !== 1 || entry.wire !== 2 || !entry.data) continue;
    let uid = '', name = '', family = '', context = 0, output = 0, free = false;
    const prices = new Map<string, number>();
    for (const field of parseFields(entry.data)) {
      if (field.num === 22 && field.wire === 2) uid = text(field.data);
      if (field.num === 1 && field.wire === 2) name = text(field.data);
      if (field.num === 18 && field.wire === 0) context = field.n ?? 0;
      if (field.num === 24 && field.wire === 0) free = field.n === 4;
      if (field.num === 23 && field.data) for (const info of parseFields(field.data)) {
        if (info.num === 13 && info.wire === 0) output = info.n ?? 0;
        if (info.num === 23 && info.wire === 2) family = text(info.data);
      }
      if (field.num === 32 && field.data) {
        const fields = parseFields(field.data);
        const value = fields.find(f => f.num === 2 && f.wire === 5)?.data;
        if (value && text(fields.find(f => f.num === 3)?.data) === '1M tokens') {
          const price = new DataView(value.buffer, value.byteOffset, 4).getFloat32(0, true);
          if (Number.isFinite(price) && price >= 0) prices.set(text(fields.find(f => f.num === 1)?.data), Number(price.toPrecision(6)));
        }
      }
    }
    if (!uid || /(?:^|[-_])(fast|priority)(?:$|[-_])/i.test(uid) || /\bFast\b/i.test(name)) continue;
    if (/^(adaptive|fusion)(?:$|[-_])/i.test(family || uid)) continue;
    const cached = prices.get('Cached input'), input = prices.get('Input'), out = prices.get('Output');
    const definition: Omit<ModelDefinition, 'intelligence' | 'speed'> = {
      id: uid,
      displayName: name || uid,
      reasoningEfforts: ['default'],
      capabilities: ['text'],
      ...(context > 0 ? { contextWindow: context } : {}),
      ...(output > 0 ? { maxOutputTokens: output, maxTokens: output } : {}),
      ...(cached !== undefined && input !== undefined && out !== undefined
        ? { pricing: [cached, input, out] as const }
        : {}),
      ...(free ? { free: true } : {}),
    };
    rows.push({ uid, name, family, context, output, free, prices, definition });
  }

  // Group exact discovered rows by registered identity and effort. A row whose
  // upstream identity resolves to no registered model is withheld: a
  // provider-local or synthesized identity is never published. Two rows naming
  // the same registered identity at the same effort make the outbound UID
  // ambiguous, so that identity is withheld entirely rather than resolved by
  // declaration order.
  const byIdentity = new Map<string, Map<ReasoningEffort, DiscoveredRow>>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    const registeredId = resolveRegisteredId(row.uid, row.family);
    if (registeredId === undefined) continue;
    const effort = effortOf(row.uid, row.name);
    let variants = byIdentity.get(registeredId);
    if (variants === undefined) {
      variants = new Map();
      byIdentity.set(registeredId, variants);
    }
    if (variants.has(effort)) { ambiguous.add(registeredId); continue; }
    variants.set(effort, row);
  }

  const catalog: DevinModel[] = [];
  for (const [registeredId, variants] of byIdentity) {
    if (ambiguous.has(registeredId)) continue;
    const efforts = REASONING_EFFORTS.filter((effort) => variants.has(effort));
    // The base request needs one unambiguous outbound UID: the provider-default
    // row, or the only row when the identity materializes a single effort.
    const defaultRow = variants.get('default') ?? (efforts.length === 1 ? variants.get(efforts[0]) : undefined);
    if (defaultRow === undefined) continue;
    const declaredRows = [...variants.values()];
    const cached = agreed(declaredRows.map((row) => row.prices.get('Cached input')));
    const input = agreed(declaredRows.map((row) => row.prices.get('Input')));
    const output = agreed(declaredRows.map((row) => row.prices.get('Output')));
    const contextWindow = minimum(declaredRows.map((row) => (row.context > 0 ? row.context : undefined)));
    const maxOutputTokens = minimum(declaredRows.map((row) => (row.output > 0 ? row.output : undefined)));
    // The account reported this identity; its pricing, limits and free status
    // are account-owned, so an omitted value stays absent instead of regaining
    // a registry default. Speed and intelligence remain registry-owned.
    const overrides: CanonicalModelOverrides = {
      upstreamId: defaultRow.uid,
      ownsMetadata: true,
      capabilities: ['text'],
      reasoningEfforts: efforts,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens, maxTokens: maxOutputTokens }),
      ...(cached !== undefined && input !== undefined && output !== undefined
        ? { pricing: [cached, input, output] as const }
        : {}),
      ...(declaredRows.every((row) => row.free) ? { free: true } : {}),
    };
    const exactVariants: DevinModel['variants'] = {};
    // Exact transport rows carry the registered identity's required metadata;
    // intelligence and speed are never sourced from an upstream row. Each
    // variant owns the account metadata it actually reported.
    const identity = models.require(registeredId);
    for (const [effort, row] of variants) {
      exactVariants[effort] = {
        ...row.definition,
        ownsMetadata: true,
        intelligence: identity.defaults.intelligence,
        speed: identity.defaults.speed,
      };
    }
    catalog.push({ ...resolveProviderModel({ canonical: registeredId, overrides }), variants: exactVariants });
  }
  return catalog;
}
