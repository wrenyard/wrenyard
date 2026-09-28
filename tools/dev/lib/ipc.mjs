import { WrenyardIpcClient } from '../../../packages/control-client/src/index.ts';

const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Connect to the daemon with the shared version-checked control client, run
 * `fn(client)`, then close. The client completes the `health.ping` handshake
 * before the first request, so a protocol mismatch fails closed instead of
 * speaking a stale protocol. `timeoutMs` bounds each request.
 */
export async function withDaemon(ipcPath, fn, timeoutMs = CONNECT_TIMEOUT_MS) {
  const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: timeoutMs });
  try {
    return await fn({
      request: (method, params, requestTimeoutMs = 30_000) =>
        client.request(method, params, { timeoutMs: requestTimeoutMs }),
    });
  } finally {
    client.close();
  }
}
