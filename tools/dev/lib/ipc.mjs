import { createConnection } from 'node:net';

const CONNECT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

/** NDJSON frame parser: one JSON-RPC message per line. */
function createFrameParser(onMessage) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line)); } catch (error) { onMessage({ type: 'parse-error', error: error instanceof Error ? error.message : String(error), raw: line }); }
      }
    },
  };
}

function connect(ipcPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(ipcPath);
    socket.setEncoding('utf8');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`daemon IPC did not accept a connection within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      let nextId = 1;
      const pending = new Map();
      const parser = createFrameParser((message) => {
        if (message?.id == null) return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
        else waiter.resolve(message.result);
      });
      socket.on('data', (chunk) => parser.push(chunk));
      socket.on('close', () => {
        for (const waiter of pending.values()) waiter.reject(new Error('daemon IPC closed'));
        pending.clear();
      });
      resolve({
        request(method, params, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
          const id = nextId;
          nextId += 1;
          return new Promise((resolveRequest, rejectRequest) => {
            const requestTimer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`daemon RPC timed out (${method})`));
            }, requestTimeoutMs);
            pending.set(id, {
              resolve: (result) => { clearTimeout(requestTimer); resolveRequest(result); },
              reject: (error) => { clearTimeout(requestTimer); rejectRequest(error); },
            });
            socket.write(encodeMessage({ jsonrpc: '2.0', id, method, params: params ?? {} }));
          });
        },
        close() { socket.end(); },
      });
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Connect to the daemon, run `fn(client)`, then close. `timeoutMs` bounds the connection. */
export async function withDaemon(ipcPath, fn, timeoutMs = CONNECT_TIMEOUT_MS) {
  const client = await connect(ipcPath, timeoutMs);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
