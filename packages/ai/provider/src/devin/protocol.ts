// Adapted from magpie-community/plugins Devin 0.1.18, commit
// 423e78e49cea4ac380ffedf4f59e6b6382184f8a. MIT license notice follows.
/*!
MIT License

Copyright (c) 2026 magpie-community contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const CHAT_RPC = '/exa.api_server_pb.ApiServerService/GetChatMessage';
const MAX_FRAME = 16 * 1024 * 1024;
const UPSTREAM_DRAIN_BUDGET_MS = 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface Field { num: number; wire: number; n?: number; data?: Uint8Array }
export class Writer {
  private parts: Uint8Array[] = [];
  varint(field: number, n: number): this { return this.bytesRaw(concat(varint(field * 8), varint(n))); }
  string(field: number, value: string): this { return this.bytes(field, encoder.encode(value)); }
  bytes(field: number, value: Uint8Array): this { return this.bytesRaw(concat(tag(field, 2, value.length), value)); }
  double(field: number, value: number): this { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value, true); return this.bytesRaw(concat(tag(field, 1), b)); }
  private bytesRaw(v: Uint8Array): this { this.parts.push(v); return this; }
  done(): Uint8Array { return concat(...this.parts); }
}
function concat(...parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let p = 0; for (const b of parts) { out.set(b, p); p += b.length; } return out; }
function varint(n: number): Uint8Array { if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid protobuf integer'); const a: number[] = []; let v = BigInt(n); while (v > 127n) { a.push(Number(v & 127n) | 128); v >>= 7n; } a.push(Number(v)); return Uint8Array.from(a); }
function tag(field: number, wire: number, value?: number): Uint8Array { const head = varint(field * 8 + wire); if (wire === 2) return concat(head, varint(value ?? 0)); return head; }

export function parseFields(input: Uint8Array): Field[] {
  if (input.length > MAX_FRAME) throw new Error('protobuf message exceeds 16 MiB');
  const out: Field[] = []; let at = 0;
  const readVarint = (): number => { let n = 0n; for (let i = 0; i < 10; i++) { if (at >= input.length) throw new Error('truncated protobuf varint'); const b = input[at++]!; n |= BigInt(b & 127) << BigInt(i * 7); if (!(b & 128)) { if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('oversized protobuf integer'); return Number(n); } } throw new Error('oversized protobuf varint'); };
  while (at < input.length) {
    const key = readVarint(); const num = key >>> 3; const wire = key & 7; if (!num) throw new Error('invalid protobuf field');
    if (wire === 0) out.push({ num, wire, n: readVarint() });
    else if (wire === 1) { if (at + 8 > input.length) throw new Error('truncated protobuf fixed64'); out.push({ num, wire }); at += 8; }
    else if (wire === 2) { const len = readVarint(); if (len > MAX_FRAME || at + len > input.length) throw new Error('invalid protobuf field length'); out.push({ num, wire, data: input.subarray(at, at + len) }); at += len; }
    else if (wire === 5) { if (at + 4 > input.length) throw new Error('truncated protobuf fixed32'); out.push({ num, wire, data: input.subarray(at, at + 4) }); at += 4; }
    else throw new Error('unsupported protobuf wire type');
  }
  return out;
}

export function metadata(key: string): Uint8Array {
  return new Writer().string(1, 'devin-cli').string(2, '3000.11.3').string(3, key)
    .string(4, 'en').string(5, process.platform === 'win32' ? 'windows' : process.platform)
    .string(7, '3000.11.3').string(12, 'chisel').string(28, 'chisel').done();
}

export async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) return concat(...parts); size += value.length; if (size > limit) throw new Error('Devin response exceeds size limit'); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function framed(payload: Uint8Array, flags = 0): Uint8Array { if (payload.length > MAX_FRAME) throw new Error('Connect frame exceeds 16 MiB'); const out = new Uint8Array(payload.length + 5); out[0] = flags; new DataView(out.buffer).setUint32(1, payload.length); out.set(payload, 5); return out; }
function message(role: number, text: string, calls: Array<{ id: string; name: string; args: string }>, callID?: string): Uint8Array {
  const w = new Writer().string(1, randomUUID()).varint(2, role); if (text) w.string(3, text);
  for (const c of calls) w.bytes(6, new Writer().string(1, c.id).string(2, c.name).bytes(3, encoder.encode(c.args)).done());
  if (callID) w.string(7, callID); return w.done();
}
function plainObjectRoot(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool parameters must be an object schema');
  const schema = { ...(value as Record<string, unknown>) };
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || !branches.length) {
      if (branches !== undefined && !Array.isArray(branches)) throw new Error('tool parameters must have a plain object root');
      continue;
    }
    if (schema.type !== undefined && schema.type !== 'object') throw new Error('tool parameters must have a plain object root');
    const properties = { ...(schema.properties as Record<string, unknown> | undefined) };
    let required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    const branchRequired: string[][] = [];
    for (const branch of branches) {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) throw new Error('tool parameters must have a plain object root');
      const object = branch as Record<string, unknown>;
      if ((object.type !== undefined && object.type !== 'object') || object.$ref || object.oneOf || object.anyOf || object.allOf) throw new Error('tool parameters must have a plain object root');
      for (const [key, property] of Object.entries((object.properties as Record<string, unknown> | undefined) ?? {})) if (!(key in properties)) properties[key] = property;
      branchRequired.push(Array.isArray(object.required) ? object.required.filter((entry): entry is string => typeof entry === 'string') : []);
    }
    const merged = keyword === 'allOf'
      ? branchRequired.flat()
      : branchRequired.reduce((keys, branch) => keys.filter((key) => branch.includes(key)), branchRequired[0] ?? []);
    required = [...new Set([...required, ...merged])];
    delete schema[keyword];
    schema.type = 'object';
    schema.properties = properties;
    if (required.length) schema.required = required; else delete schema.required;
  }
  return schema;
}
function schemaSupported(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool parameters must be an object schema');
  const walk = (obj: Record<string, unknown>) => {
    if (obj.$ref || obj.$defs || obj.definitions) throw new Error('tool schema references are unsupported');
    for (const v of Object.values(obj)) if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>);
  }; const root = value as Record<string, unknown>;
  if (root.type !== 'object') throw new Error('tool parameters must have a plain object root');
  walk(root);
}

export function encodeChatRequest(chat: Record<string, unknown>, uid: string, key: string): Uint8Array {
  for (const field of ['response_format', 'stop', 'logprobs', 'top_logprobs', 'seed', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'parallel_tool_calls', 'service_tier']) {
    if (chat[field] !== undefined) throw new Error('Devin does not support ' + field);
  }
  if (chat.n !== undefined && chat.n !== 1) throw new Error('Devin supports only n=1');
  if (chat.reasoning_effort !== undefined && chat.reasoning_effort !== 'default') throw new Error('Select an exact Devin model UID instead of reasoning_effort');
  const choice = chat.tool_choice;
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') throw new Error('Devin supports only tool_choice auto or none');
  const messages = Array.isArray(chat.messages) ? chat.messages as Array<Record<string, unknown>> : [];
  const tools = Array.isArray(chat.tools) ? chat.tools as Array<Record<string, unknown>> : [];
  if (chat.tools !== undefined && !Array.isArray(chat.tools)) throw new Error('tools must be an array');
  const converted: Array<{ role: number; text: string; calls: Array<{id:string;name:string;args:string}>; callID?: string }> = [];
  const system: string[] = []; const pending = new Set<string>();
  const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => { if (!p || typeof p !== 'object' || (p as {type?:string}).type !== 'text') throw new Error('Devin Gateway accepts text message content only'); return String((p as {text?:unknown}).text ?? ''); }).join('\n\n');
    if (content == null) return ''; throw new Error('unsupported message content');
  };
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') { system.push(textOf(m.content)); continue; }
    if (m.role === 'user') { if (pending.size) throw new Error('tool calls must be answered before the next user message'); converted.push({ role: 1, text: textOf(m.content), calls: [] }); continue; }
    if (m.role === 'assistant') {
      const calls: Array<{id:string;name:string;args:string}> = [];
      if (Array.isArray(m.tool_calls)) for (const raw of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = raw.function as Record<string, unknown> | undefined; const id = String(raw.id ?? ''); const name = String(fn?.name ?? '');
        if (!id || !name || pending.has(id)) throw new Error('invalid or duplicate tool call');
        let args = typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {}); JSON.parse(args);
        const c = { id, name, args }; calls.push(c); pending.add(id);
      }
      const previous = converted.at(-1);
      if (previous?.role === 2 && previous.calls.length) { previous.calls.push(...calls); previous.text += '\n' + textOf(m.content); }
      else converted.push({ role: 2, text: textOf(m.content), calls }); continue;
    }
    if (m.role === 'tool') { const id = String(m.tool_call_id ?? ''); if (!id || !pending.has(id)) throw new Error('tool result does not match a pending call'); pending.delete(id); converted.push({ role: 4, text: textOf(m.content), calls: [], callID: id }); continue; }
    throw new Error(`unsupported message role ${String(m.role)}`);
  }
  if (pending.size) throw new Error('conversation contains tool calls without paired results');
  if (choice === 'none' && converted.some(m => m.calls.length)) throw new Error('tool_choice none with tool history is unsupported');
  const descriptions = choice === 'none' ? [] : tools.map(tool => {
    const fn = tool.function as Record<string, unknown> | undefined;
    return fn?.description ? '<tool name="' + fn.name + '">\n' + fn.description + '\n</tool>' : '';
  }).filter(Boolean);
  const instructions = [...system, ...(descriptions.length ? ['<tool_descriptions>\n' + descriptions.join('\n') + '\n</tool_descriptions>'] : [])].filter(Boolean).join('\n\n');
  if (instructions) { let first = converted.find((m) => m.role === 1); if (!first) { first = { role: 1, text: '', calls: [] }; converted.unshift(first); } first.text = [instructions, first.text].filter(Boolean).join('\n\n'); }
  if (!converted.length || converted.at(-1)?.role === 2) converted.push({ role: 1, text: 'Please proceed with the task.', calls: [] });
  const request = new Writer().bytes(1, metadata(key));
  for (const m of converted) request.bytes(3, message(m.role, m.text, m.calls, m.callID));
  request.varint(7, 5);
  const options = new Writer().varint(1, 1).varint(2, number(chat.max_completion_tokens ?? chat.max_tokens, 128000)).varint(3, 400).varint(7, 40);
  const temperature = number(chat.temperature, 1); const topP = number(chat.top_p, 0.95);
  if (temperature < 0 || temperature > 2 || topP < 0 || topP > 1) throw new Error('unsupported sampling parameter range');
  options.double(5, temperature === 0 ? 1e-6 : temperature).double(8, topP === 0 ? 1e-6 : topP); request.bytes(8, options.done());
  if (choice !== 'none') for (const tool of tools) {
    if (tool.type !== undefined && tool.type !== 'function') throw new Error('only function tools are supported');
    const fn = tool.function as Record<string, unknown> | undefined; const name = String(fn?.name ?? ''); const schema = fn?.parameters;
    if (!name) throw new Error('tool function name is required');
    if (fn?.strict === true) throw new Error('strict tool schemas are unsupported');
    const parameters = plainObjectRoot(schema);
    schemaSupported(parameters);
    request.bytes(10, new Writer().string(1, name).string(2, fn?.description ? 'Described in <tool_descriptions> in the instructions.' : name).bytes(3, encoder.encode(JSON.stringify(parameters))).done());
  }
  const declared = new Set<string>();
  if (choice !== 'none') for (const tool of tools) { const fn = tool.function as Record<string, unknown> | undefined; declared.add(String(fn?.name ?? '')); }
  for (const m of converted) for (const call of m.calls) if (!declared.has(call.name)) { declared.add(call.name); request.bytes(10, new Writer().string(1, call.name).string(2, 'Tool').bytes(3, encoder.encode('{"type":"object","properties":{}}')).done()); }
  return request.string(21, uid).done();
}
function number(value: unknown, fallback: number): number { if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('request numeric field is invalid'); return value; }

interface Failure { status: number; message: string; code: string; upstreamStatus?: number }
interface Event { text?: string; reasoning?: string; tool?: { index: number; id: string; name: string }; args?: { index: number; text: string }; stop?: string; usage?: Record<string, unknown>; error?: Failure }

function connectError(data: Uint8Array, httpStatus = 200): Failure | undefined {
  let error: { code?: string; message?: string } | undefined;
  try {
    const parsed = JSON.parse(decoder.decode(data));
    error = parsed.error ?? (parsed.code ? parsed : undefined);
    if (!error && httpStatus < 300) return undefined;
  } catch { if (httpStatus < 300) return { status: 502, message: 'Invalid Devin Connect trailer', code: 'invalid_stream' }; }
  const code = error?.code ?? 'upstream_http_error';
  const status = ({ unauthenticated: 401, permission_denied: 403, resource_exhausted: 429, invalid_argument: 400, unavailable: 503, deadline_exceeded: 504 } as Record<string, number>)[code] ?? (httpStatus >= 300 ? httpStatus : 502);
  return { status, code, upstreamStatus: httpStatus, message: error?.message || 'Devin upstream request failed' };
}

// After the Connect trailer the message is complete, but cancelling the body
// mid-stream tears down keep-alive and can poison the connection pool for the
// next request on this socket. Bodies that end promptly are drained to EOF so
// the socket stays reusable; a bounded budget falls back to cancellation when
// the server keeps the stream open.
async function drainUpstreamBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const deadline = Date.now() + UPSTREAM_DRAIN_BUDGET_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('drain budget expired')), remaining); }),
      ]);
      if (result.done) return;
    } catch {
      return;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function* decodeEvents(response: Response, signal: AbortSignal): AsyncGenerator<Event> {
  if (!response.body) throw new Error('Devin returned an empty response stream');
  const reader = response.body.getReader();
  let buffer: Uint8Array = new Uint8Array(), toolIndex = -1, stop = 0, ended = false;
  const toolIds = new Map<string, number>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!ended) {
      signal.throwIfAborted();
      while (buffer.length >= 5) {
        const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
        if (size > MAX_FRAME) throw new Error('Devin response frame exceeds 16 MiB');
        if (buffer.length < size + 5) break;
        const flags = buffer[0]!;
        let data: Uint8Array = buffer.slice(5, size + 5);
        buffer = buffer.slice(size + 5);
        if (flags & ~3) throw new Error('Invalid Connect frame flags');
        if (flags & 1) data = gunzipSync(data, { maxOutputLength: MAX_FRAME });
        if (flags & 2) {
          const error = connectError(data);
          if (error) { yield { error }; return; }
          ended = true;
          if (buffer.length) throw new Error('Data follows Connect trailer');
          break;
        }
        for (const field of parseFields(data)) {
          if ((field.num === 3 || field.num === 9) && field.wire === 2 && field.data?.length) {
            const part = decoder.decode(field.data);
            yield field.num === 3 ? { text: part } : { reasoning: part };
          } else if (field.num === 6 && field.wire === 2 && field.data) {
            let id = '', name = '', args = '';
            for (const f of parseFields(field.data)) if (f.wire === 2 && f.data) {
              if (f.num === 1) id = decoder.decode(f.data);
              else if (f.num === 2) name = decoder.decode(f.data);
              else if (f.num === 3) args += decoder.decode(f.data);
            }
            let index = id ? toolIds.get(id) : undefined;
            if (index === undefined && name) {
              index = ++toolIndex;
              id ||= 'call_' + randomBytes(12).toString('hex');
              toolIds.set(id, index);
              yield { tool: { index, id, name } };
            }
            if (args) {
              index ??= id ? undefined : toolIndex;
              if (index === undefined || index < 0) throw new Error('Tool arguments have no matching call');
              yield { args: { index, text: args } };
            }
          } else if (field.num === 5 && field.wire === 0) stop = field.n ?? 0;
          else if (field.num === 7 && field.wire === 2 && field.data) {
            for (const f of parseFields(field.data)) if (f.wire === 0 && f.n !== undefined) {
              if (f.num === 2) inputTokens = f.n;
              else if (f.num === 3) outputTokens = f.n;
              else if (f.num === 5) cachedInputTokens = f.n;
            }
          }
        }
      }
      if (ended) break;
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) throw new Error(buffer.length ? 'Truncated Devin Connect frame' : 'Missing Devin Connect trailer');
      if (buffer.length + result.value.length > MAX_FRAME * 2) throw new Error('Devin stream buffer exceeds limit');
      buffer = concat(buffer, result.value);
    }
    // Nested 7.2 is input tokens, 7.3 output tokens, and 7.5 cached input tokens,
    // matching the labelled field-28 Token Usage block where cached input exceeds
    // uncached input on cached responses, so the counters are disjoint; the gateway
    // convention counts total input including cached input, so prompt_tokens is
    // their sum and the cached part is also exposed as
    // prompt_tokens_details.cached_tokens; subfield 7.6 remains unlabelled and unmapped.
    const usage =
      inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined
        ? undefined
        : {
            ...(inputTokens !== undefined || cachedInputTokens !== undefined
              ? { prompt_tokens: (inputTokens ?? 0) + (cachedInputTokens ?? 0) }
              : {}),
            ...(outputTokens !== undefined ? { completion_tokens: outputTokens } : {}),
            ...(cachedInputTokens !== undefined
              ? { prompt_tokens_details: { cached_tokens: cachedInputTokens } }
              : {}),
          };
    yield { stop: toolIndex >= 0 || stop === 10 ? 'tool_calls' : stop === 3 ? 'length' : 'stop',
      ...(usage === undefined ? {} : { usage }) };
  } catch (error) {
    signal.throwIfAborted();
    yield { error: { status: 502, code: 'invalid_stream', message: error instanceof Error ? error.message : 'Devin response parsing failed', upstreamStatus: response.status } };
  } finally {
    signal.removeEventListener('abort', abort);
    if (ended && !signal.aborted) { await drainUpstreamBody(reader); }
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function executeDevin(context: {
  endpoint: string; key: string; uid: string; publicModel: string; maxOutput?: number;
  body: Record<string, unknown>; signal: AbortSignal; fetch: typeof fetch; onAuthFailure(): void;
  reportUpstreamError?(fact: { status: number; code?: string; type?: string }): void;
}): Promise<Response> {
  let payload: Uint8Array;
  try {
    const requested = number(context.body.max_completion_tokens ?? context.body.max_tokens, context.maxOutput ?? 128000);
    if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('Invalid maximum output tokens');
    payload = encodeChatRequest({ ...context.body, max_completion_tokens: Math.min(requested, context.maxOutput ?? requested) }, context.uid, context.key);
  } catch (error) { return jsonError(400, error instanceof Error ? error.message : 'Invalid Devin request'); }
  context.signal.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const failureResponse = (error: Failure) => {
    if (error.status === 401) context.onAuthFailure();
    if (error.upstreamStatus !== undefined) context.reportUpstreamError?.({ status: error.upstreamStatus, code: error.code });
    return jsonError(error.status, error.message.replaceAll(context.key, '[redacted]'), error.code);
  };
  const upstream = await context.fetch(context.endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/connect+proto', 'Connect-Protocol-Version': '1', Authorization: 'Basic ' + context.key },
    body: Buffer.from(framed(payload)), signal,
  });
  if (!upstream.ok) return failureResponse(connectError(await readBounded(upstream, 64 * 1024), upstream.status)!);
  const events = decodeEvents(upstream, signal);
  const first = await events.next();
  if (first.done) return jsonError(502, 'Empty Devin response');
  if (first.value.error) { await events.return(undefined); return failureResponse(first.value.error); }
  async function* replay() {
    try { yield first.value!; yield* events; } finally { await events.return(undefined); }
  }
  const id = 'chatcmpl-' + randomBytes(12).toString('hex'), created = Math.floor(Date.now() / 1000), model = context.publicModel;
  const pieces = replay();
  if (context.body.stream !== true) {
    const content: string[] = [], reasoning: string[] = [];
    const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
    let finish = 'stop', usage: Record<string, unknown> | undefined;
    for await (const e of pieces) {
      if (e.error) return failureResponse(e.error);
      if (e.text) content.push(e.text);
      if (e.reasoning) reasoning.push(e.reasoning);
      if (e.tool) calls[e.tool.index] = { id: e.tool.id, type: 'function', function: { name: e.tool.name, arguments: '' } };
      if (e.args) calls[e.args.index]!.function.arguments += e.args.text;
      if (e.stop) { finish = e.stop; usage = e.usage; }
    }
    return Response.json({ id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: content.join(''),
        ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}), ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
  }
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, usage?: Record<string, unknown>) =>
    encoder.encode('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage === undefined ? {} : { usage }) }) + '\n\n');
  let began = false;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        if (!began) { began = true; ctl.enqueue(chunk({ role: 'assistant' })); return; }
        const next = await pieces.next();
        if (next.done) { ctl.enqueue(encoder.encode('data: [DONE]\n\n')); ctl.close(); return; }
        const e = next.value;
        if (e.error) {
          const response = failureResponse(e.error);
          ctl.enqueue(encoder.encode('data: ' + await response.text() + '\n\n'));
          await pieces.return();
          ctl.close(); return;
        }
        if (e.text) ctl.enqueue(chunk({ content: e.text }));
        else if (e.reasoning) ctl.enqueue(chunk({ reasoning_content: e.reasoning }));
        else if (e.tool) ctl.enqueue(chunk({ tool_calls: [{ index: e.tool.index, id: e.tool.id, type: 'function', function: { name: e.tool.name, arguments: '' } }] }));
        else if (e.args) ctl.enqueue(chunk({ tool_calls: [{ index: e.args.index, function: { arguments: e.args.text } }] }));
        else if (e.stop) ctl.enqueue(chunk({}, e.stop, e.usage));
      } catch (error) { controller.abort(); await pieces.return(); ctl.error(error); }
    },
    async cancel() { controller.abort(); await pieces.return(); },
  }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}
export function jsonError(status: number, message: string, code = 'devin_error'): Response {
  return Response.json({ error: { message, type: 'devin_error', code } }, { status });
}
