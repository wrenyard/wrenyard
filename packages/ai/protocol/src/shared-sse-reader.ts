/**
 * Shared SSE frame reader for the session protocol adapters.
 *
 * The three adapters (Chat Completions, Responses, Messages) share one stream
 * transport: a fetch body of Server-Sent Events split into frames by a blank
 * line. This module owns exactly that common loop — reader acquisition, UTF-8
 * decoding, newline normalization, blank-line frame splitting, the abort cancel
 * listener, read-failure to network-error mapping and the final flush of an
 * unfinished tail — and hands every complete frame to the caller. Frame
 * interpretation stays in the adapters.
 */
import { abortError, networkError } from './errors.ts';

/**
 * Read one SSE body, delivering every complete frame (and, for a stream that
 * ends before the caller's done marker, its unfinished tail) to `onFrame`.
 * `isDone` is checked before each read and after each delivered frame, so a
 * protocol's terminal frame stops the loop. Cancellation, read failures and the
 * unfinished tail keep the exact behavior the adapters had inline.
 */
export async function readSseStream(
  response: Response,
  signal: AbortSignal,
  onFrame: (frame: string) => void,
  isDone: () => boolean,
): Promise<void> {
  const body = response.body;
  if (!body) throw new Error('Model response is missing a body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  if (signal.aborted) {
    await reader.cancel().catch(() => undefined);
    throw abortError();
  }
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!isDone()) {
      // A stream read rejection is a transport I/O failure, not a parse failure;
      // a frame/JSON parse error below stays a protocol failure.
      const chunk = await reader.read().catch((error: unknown) => {
        throw networkError(error, signal);
      });
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n|\r(?!$)/gu, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        onFrame(frame);
        if (isDone()) break;
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!isDone()) {
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n?/gu, '\n');
      if (buffer.trim()) onFrame(buffer);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
}
