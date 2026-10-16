import type { ModelDefinition } from '../base/index.ts';
import type { DevinCredentials } from './credentials.ts';
import { Writer, metadata, parseFields, readBounded } from './protocol.ts';

// Field numbers and Free tier 4 follow magpie-community/devin 0.1.18.
export async function fetchDevinModels(credentials: DevinCredentials, fetcher: typeof fetch): Promise<ModelDefinition[]> {
  const response = await fetcher(credentials.server + '/exa.api_server_pb.ApiServerService/GetCliModelConfigs', {
    method: 'POST', headers: { 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1' },
    body: Buffer.from(new Writer().bytes(1, metadata(credentials.key)).done()), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Devin model discovery failed: HTTP ' + response.status); }
  const models: ModelDefinition[] = [];
  const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);
  for (const entry of parseFields(await readBounded(response, 8 * 1024 * 1024))) {
    if (entry.num !== 1 || entry.wire !== 2 || !entry.data) continue;
    let uid = '', name = '', context = 0, output = 0, free = false;
    const prices = new Map<string, number>();
    for (const field of parseFields(entry.data)) {
      if (field.num === 22 && field.wire === 2) uid = text(field.data);
      if (field.num === 1 && field.wire === 2) name = text(field.data);
      if (field.num === 18 && field.wire === 0) context = field.n ?? 0;
      if (field.num === 24 && field.wire === 0) free = field.n === 4;
      if (field.num === 23 && field.data) for (const info of parseFields(field.data)) {
        if (info.num === 13 && info.wire === 0) output = info.n ?? 0;
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
    if (!/^claude-opus-/.test(uid) && !/^swe-2-(medium|high|max)$/.test(uid) && !/^MODEL_CLAUDE_4_5_OPUS/.test(uid)) continue;
    const cached = prices.get('Cached input'), input = prices.get('Input'), out = prices.get('Output');
    models.push({ id: uid, displayName: name || uid, reasoningEfforts: ['default'], capabilities: ['text'],
      ...(context > 0 ? { contextWindow: context } : {}), ...(output > 0 ? { maxOutputTokens: output, maxTokens: output } : {}),
      ...(cached !== undefined && input !== undefined && out !== undefined ? { pricing: [cached, input, out] as const } : {}),
      ...(free ? { free: true } : {}),
    });
  }
  return models;
}
