export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function createFrameParser(onMessage) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          onMessage({ type: 'parse-error', error: error instanceof Error ? error.message : String(error), raw: line });
          continue;
        }
        onMessage(parsed);
      }
    },
    rest() {
      return buffer;
    },
  };
}

export function requestMessage(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

export function resultMessage(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function errorMessage(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function eventMessage(method, params = {}) {
  return { jsonrpc: '2.0', method, params };
}

export const ERRORS = Object.freeze({
  parse: -32700,
  invalid: -32600,
  method: -32601,
  params: -32602,
  internal: -32603,
  busy: 1,
  wrongCheckout: 2,
  notRunning: 3,
  degraded: 4,
  cancelled: 5,
  desktopRunning: 6,
});
