import type { ProviderDefinition } from '@wrenyard/providers/base';
import type { ProviderRuntime } from '@wrenyard/providers';
import type { ServerResponse } from 'node:http';
import type { ResponseSampler } from './response-tps.ts';
import type { GatewayProtocolModule, ResponseObserver, TpsTranslator } from './protocols/types.ts';

export interface RelayOptions {
  module: GatewayProtocolModule;
  provider: ProviderDefinition;
  providers: ProviderRuntime;
  modelId: string;
  upstreamModel: string;
  publicModel: string;
  observer: ResponseObserver;
  /** The protocol-neutral TPS bridge; receives the translator's generation signals. */
  sampler: ResponseSampler;
  /** The selected protocol module's generation-delta translator. */
  translator: TpsTranslator;
}

/** Rewrite every response `model` field to the requested public model id. */
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
    try {
      const parsed: unknown = JSON.parse(text);
      options.observer.json(parsed);
      if (options.module.isOfficialStreamError(parsed)) {
        response.write(text);
      } else {
        options.module.normalizeResponseModel(parsed, modelRewriter(options));
        response.write(JSON.stringify(parsed));
      }
    } catch {
      response.write(text);
    }
    return observedError(options);
  }
  if (!contentType.includes('text/event-stream')) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return {};
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let frame = '';
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
        response.write(relayFrame(frame, options));
        frame = '';
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      options.observer.feed(text);
      pending += text;
      flushFrames();
    }
    const tail = decoder.decode();
    options.observer.feed(tail);
    options.observer.end();
    pending += tail;
    flushFrames();
    if (pending !== '') { frame += pending; pending = ''; }
    if (frame !== '') response.write(relayFrame(frame, options));
    // A response that never reached a protocol completion — truncated, failed
    // or cancelled — can never yield a TPS sample.
    if (!options.observer.succeeded()) options.sampler.fail();
  } finally {
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
