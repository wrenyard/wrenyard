import type { ModelDefinition } from '../base/index.ts';
import { builtinModelDisplayName, MAINSTREAM_MODEL_IDS, REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models';
import type { DevinCredentials } from './credentials.ts';
import { Writer, metadata, parseFields, readBounded } from './protocol.ts';

export interface DevinModel extends ModelDefinition {
  variants: Partial<Record<ReasoningEffort, ModelDefinition>>;
}

// Field numbers and Free tier 4 follow magpie-community/devin 0.1.18.
export async function fetchDevinModels(credentials: DevinCredentials, fetcher: typeof fetch): Promise<DevinModel[]> {
  const response = await fetcher(credentials.server + '/exa.api_server_pb.ApiServerService/GetCliModelConfigs', {
    method: 'POST', headers: { 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1' },
    body: Buffer.from(new Writer().bytes(1, metadata(credentials.key)).done()), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Devin model discovery failed: HTTP ' + response.status); }
  const models: Array<ModelDefinition & { devinFamily: string; familyName: string; canonical?: string }> = [];
  const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);
  for (const entry of parseFields(await readBounded(response, 8 * 1024 * 1024))) {
    if (entry.num !== 1 || entry.wire !== 2 || !entry.data) continue;
    let uid = '', name = '', family = '', familyName = '', context = 0, output = 0, free = false;
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
      if (field.num === 30 && field.data) familyName = text(parseFields(field.data).find(f => f.num === 1 && f.wire === 2)?.data);
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
    const canonical = MAINSTREAM_MODEL_IDS.find(id => id.replaceAll('.', '-') === family.replaceAll('.', '-'));
    const cached = prices.get('Cached input'), input = prices.get('Input'), out = prices.get('Output');
    models.push({ id: uid, devinFamily: canonical ?? (family || uid), familyName: familyName || name || uid, canonical, displayName: name || uid, reasoningEfforts: ['default'], capabilities: ['text'],
      ...(context > 0 ? { contextWindow: context } : {}), ...(output > 0 ? { maxOutputTokens: output, maxTokens: output } : {}),
      ...(cached !== undefined && input !== undefined && out !== undefined ? { pricing: [cached, input, out] as const } : {}),
      ...(free ? { free: true } : {}),
    });
  }
  const groups = new Map<string, DevinModel>();
  for (const model of models) {
    const match = /(?:-|_)(none|low|medium|high|xhigh|max)$/i.exec(model.id);
    const label = /\s+(No Thinking|None|Low|Medium|High|XHigh|Max)(?: Thinking)?( 1M)?$/i.exec(model.displayName);
    const level = match?.[1].toLowerCase() ?? label?.[1].toLowerCase().replace('no thinking', 'none');
    // Context variants stay separate; opaque UIDs can still carry an explicit effort label.
    const id = level ? model.devinFamily + (label?.[2] ? '-1m' : '') : model.id;
    const effort = (level ?? 'default') as ReasoningEffort;
    let group = groups.get(id);
    if (!group) {
      group = { ...model, id,
        displayName: level ? model.familyName + (label?.[2] ?? '') : model.displayName,
        ...(model.canonical ? { canonicalModel: { id: model.canonical, displayName: builtinModelDisplayName(model.canonical) } } : {}),
        reasoningEfforts: [], variants: {},
      };
      groups.set(id, group);
    }
    group.variants[effort] = model;
    group.reasoningEfforts = REASONING_EFFORTS.filter(level => group.variants[level] !== undefined);
    // Only expose metadata shared by every admitted variant; execution uses the exact row.
    for (const key of ['pricing', 'contextWindow', 'maxTokens', 'maxOutputTokens', 'free'] as const) {
      if (JSON.stringify(group[key]) !== JSON.stringify(model[key])) delete group[key];
    }
  }
  return [...groups.values()];
}
