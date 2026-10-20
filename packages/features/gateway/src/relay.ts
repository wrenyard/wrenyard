import type { ProviderDefinition } from '@wrenyard/providers/base';
import type { ProviderRuntime } from '@wrenyard/providers';
import type { ServerResponse } from 'node:http';
import type { ResponseSampler } from './response-tps.ts';
import type { GatewayProtocolModule, ResponseObserver, TpsTranslator } from './protocols/types.ts';
import { object } from './protocols/types.ts';

export interface RelayOptions {
  response: ServerResponse;
  module: GatewayProtocolModule;
  provider: ProviderDefinition;
  providers: ProviderRuntime;
  /** Registered model id the request was resolved for. */
  modelId: string;
  /** Exact private upstream wire model (or effort UID) sent outbound. */
  upstreamModel: string;
  /** Requested registered model id, restored on every response `model` field. */
  publicModel: string;
  observer: ResponseObserver;
  /** The protocol-neutral TPS bridge; receives the translator's generation signals. */
  sampler: ResponseSampler;
  /** The selected protocol module's generation-delta translator. */
  translator: TpsTranslator;
  /** Commits the downstream HTTP response (status and headers) before the first body byte. */
  commit: () => void;
  /** When aborted, upstream relay stops and no further downstream bytes are committed or written. */
  signal?: AbortSignal;
}

function downstreamWritable(options: RelayOptions): boolean {
  return options.signal === undefined || !options.signal.aborted;
}

/** Rewrite every response `model` field to the requested registered model id. */
function modelRewriter(options: RelayOptions): (model: string) => string {
  return (model) => options.providers.publicResponseModel(
    options.provider, model, options.upstreamModel, options.publicModel,
  );
}

/**
 * The result of relaying one upstream response.
 *
 * `observedError` reports the official error identity the protocol module
 * recognized in the body after an HTTP success status; the frames themselves
 * are never rewritten. The relay only observes — the pipeline records the fact.
 */
export interface RelayResult {
  observedError?: { type?: string; code?: string };
}

/** The observed official error identity, if the protocol module recognized one. */
function observedError(options: RelayOptions): RelayResult {
  const error = options.observer.error();
  return error === undefined ? {} : { observedError: error };
}

/** The joined `data` payload of one complete SSE frame, or undefined when it carries none. */
function frameData(frame: string): string | undefined {
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    const match = /^data:\s?(.*)$/u.exec(body);
    if (match) data.push(match[1]!);
  }
  return data.length === 0 ? undefined : data.join('\n');
}

/** Re-emit one frame with its `data` payloads replaced by a single serialized line. */
function rebuildFrame(frame: string, payload: string): string {
  const out: string[] = [];
  let written = false;
  for (const line of frame.split('\n')) {
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (/^data:/u.test(body)) {
      if (!written) { out.push(`data: ${payload}`); written = true; }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Translate one complete SSE frame and, when safe, rewrite its model field.
 *
 * A frame's joined `data` payload is parsed and handed to the selected
 * protocol module's translator exactly once, so a multi-line payload is one
 * event and never several. A non-JSON payload (e.g. the Chat completion
 * sentinel) and an official error frame are re-emitted with their original
 * bytes; only a successful JSON frame has its `model` field rewritten to the
 * requested public model id.
 */
function writeBody(options: RelayOptions, chunk: string | Buffer): void {
  if (!downstreamWritable(options)) return;
  options.commit();
  if (!downstreamWritable(options)) return;
  options.response.write(chunk);
}

/** Buffers SSE body bytes until the downstream response is committed. */
interface SseDownstreamState {
  pending: (string | Buffer)[];
}

function flushSseDownstream(options: RelayOptions, state: SseDownstreamState, chunk: string | Buffer): void {
  if (!downstreamWritable(options)) return;
  options.commit();
  if (!downstreamWritable(options)) return;
  for (const buffered of state.pending) options.response.write(buffered);
  state.pending.length = 0;
  options.response.write(chunk);
}

/** True when this frame should commit headers and flush any buffered SSE bytes. */
function shouldCommitSseFrame(frame: string, options: RelayOptions): boolean {
  if (options.sampler.hasSeenOutput()) return true;
  if (options.observer.succeeded() || options.observer.failedStream()) return true;
  const payload = frameData(frame);
  if (payload === undefined) return false;
  try {
    return options.module.isOfficialStreamError(JSON.parse(payload));
  } catch {
    return false;
  }
}

function writeSseFrame(frame: string, options: RelayOptions, state: SseDownstreamState): void {
  const chunk = relayFrame(frame, options);
  if (!downstreamWritable(options)) return;
  if (shouldCommitSseFrame(frame, options)) flushSseDownstream(options, state, chunk);
  else state.pending.push(chunk);
}

function relayFrame(frame: string, options: RelayOptions): string {
  const payload = frameData(frame);
  if (payload === undefined) return frame;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    options.translator.translate(payload, options.sampler);
    return frame;
  }
  options.translator.translate(parsed, options.sampler);
  if (options.module.isOfficialStreamError(parsed)) return frame;
  const record = object(parsed);
  if (record !== undefined) options.module.normalizeResponseUsage(record);
  options.module.normalizeResponseModel(parsed, modelRewriter(options));
  return rebuildFrame(frame, JSON.stringify(parsed));
}

/**
 * Relay one upstream response to the client: JSON and SSE are re-serialized so
 * the public model id replaces the upstream model id, opaque bodies are copied
 * byte-for-byte, and the passive usage / TPS observers see the raw upstream
 * bytes before normalization. Official error frames — both an HTTP-200 JSON
 * error body and an in-stream error frame — are forwarded with their exact
 * bytes, so their status and body survive unchanged.
 */
export async function relayResponse(
  upstream: Response,
  response: ServerResponse,
  options: RelayOptions,
): Promise<RelayResult> {
  if (!upstream.body) return {};
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    const text = await upstream.text();
    if (!downstreamWritable(options)) return observedError(options);
    try {
      const parsed: unknown = JSON.parse(text);
      options.observer.json(parsed);
      if (options.module.isOfficialStreamError(parsed)) {
        writeBody(options, text);
      } else {
        if (object(parsed) !== undefined) options.module.normalizeResponseUsage(parsed as Record<string, unknown>);
        options.module.normalizeResponseModel(parsed, modelRewriter(options));
        writeBody(options, JSON.stringify(parsed));
      }
    } catch {
      writeBody(options, text);
    }
    return observedError(options);
  }
  if (!contentType.includes('text/event-stream')) {
    const reader = upstream.body.getReader();
    const onAbort = (): void => { reader.cancel().catch(() => undefined); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (options.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        writeBody(options, Buffer.from(value));
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
    return {};
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let frame = '';
  let upstreamEof = false;
  const downstream: SseDownstreamState = { pending: [] };
  const onAbort = (): void => { reader.cancel().catch(() => undefined); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const flushBufferedPending = (): void => {
    if (!downstreamWritable(options) || downstream.pending.length === 0) return;
    options.commit();
    if (!downstreamWritable(options)) return;
    for (const buffered of downstream.pending) options.response.write(buffered);
    downstream.pending.length = 0;
  };
  // A blank line terminates an SSE frame, so a multi-line `data` field is
  // assembled into one event before it is ever parsed.
  const flushFrames = (): void => {
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      frame += line;
      if ((line.endsWith('\r\n') ? line.slice(0, -2) : line.slice(0, -1)) === '') {
        writeSseFrame(frame, options, downstream);
        frame = '';
      }
    }
  };
  try {
    for (;;) {
      if (options.signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) { upstreamEof = true; break; }
      const text = decoder.decode(value, { stream: true });
      options.observer.feed(text);
      pending += text;
      flushFrames();
      // Every terminal frame settles the stream immediately, whether completed,
      // incomplete, failed, or an in-stream error. Waiting for upstream EOF
      // afterwards lets a client disconnect record the call as 499 without usage.
      if (options.observer.succeeded() || options.observer.failedStream()) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!options.signal?.aborted) {
      const tail = decoder.decode();
      options.observer.feed(tail);
      options.observer.end();
      pending += tail;
      flushFrames();
      if (pending !== '') { frame += pending; pending = ''; }
      if (frame !== '') writeSseFrame(frame, options, downstream);
      if (options.observer.succeeded() || options.observer.failedStream() || upstreamEof) {
        flushBufferedPending();
      }
    }
    // A response that never reached a protocol completion — truncated, failed
    // or cancelled — can never yield a TPS sample.
    if (!options.observer.succeeded()) options.sampler.fail();
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return observedError(options);
}

/**
 * Give the owning provider's response hook a chance to repair a successful
 * upstream response (e.g. supply a missing Content-Type). The supplier hook is
 * executed generically through the runtime; without one the response is
 * unchanged.
 */
export async function repairUpstreamResponse(
  upstream: Response,
  options: Pick<RelayOptions, 'module' | 'provider' | 'providers' | 'modelId' | 'publicModel'>,
): Promise<Response> {
  if (!upstream.ok || !options.providers.afterResponse) return upstream;
  try {
    const result = await options.providers.afterResponse(options.provider, {
      protocol: options.module.protocol,
      modelId: options.modelId,
      publicModel: options.publicModel,
      status: upstream.status,
      headers: upstream.headers,
      response: upstream,
    });
    return result?.response ?? upstream;
  } catch {
    return upstream;
  }
}
