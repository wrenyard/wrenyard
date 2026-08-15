import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultWrenyardIpcPath,
  ForemanIpcClient,
  ForemanRpcError,
  resolveForemanIpcPath,
  resolveWrenyardIpcPath,
  WrenyardIpcClient,
  WrenyardRpcError,
} from "../src/index.js";

const isWindows = process.platform === "win32";

test("WRENYARD_IPC_PATH takes precedence over the legacy FOREMAN_* variables", () => {
  assert.equal(
    resolveWrenyardIpcPath({
      WRENYARD_IPC_PATH: "/run/wrenyard.sock",
      FOREMAN_IPC_PATH: "/run/foreman.sock",
      FOREMAN_PET_FOREMAN_IPC: "/run/pet.sock",
    }),
    "/run/wrenyard.sock",
  );
});

test("legacy FOREMAN_IPC_PATH is honored as a fallback", () => {
  assert.equal(
    resolveWrenyardIpcPath({ FOREMAN_IPC_PATH: "/run/foreman.sock" }),
    "/run/foreman.sock",
  );
});

test("legacy FOREMAN_PET_FOREMAN_IPC is honored as a further fallback", () => {
  assert.equal(
    resolveWrenyardIpcPath({ FOREMAN_PET_FOREMAN_IPC: "/run/pet.sock" }),
    "/run/pet.sock",
  );
});

test("resolveWrenyardIpcPath falls back to the shared wrenyard.sock default", () => {
  assert.equal(resolveWrenyardIpcPath({}), defaultWrenyardIpcPath());
  assert.ok(defaultWrenyardIpcPath().endsWith("wrenyard.sock"));
});

test("deprecated legacy aliases are wired to the Wrenyard API", () => {
  assert.equal(ForemanIpcClient, WrenyardIpcClient);
  assert.equal(ForemanRpcError, WrenyardRpcError);
  assert.equal(resolveForemanIpcPath, resolveWrenyardIpcPath);
  assert.ok(new ForemanIpcClient({ path: "/dev/null" }) instanceof WrenyardIpcClient);
});

interface TestServer {
  socketPath: string;
  stop: () => Promise<void>;
}

async function startServer(
  handleFrame: (socket: Socket, frame: string) => void,
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "control-client-"));
  const socketPath = join(dir, "ipc.sock");
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));

    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (frame.trim() !== "") {
          handleFrame(socket, frame);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  "client resolves requests from partial NDJSON frames",
  { skip: isWindows },
  async (t) => {
    const srv = await startServer((socket, frame) => {
      const request = JSON.parse(frame) as { id: number; method: string };
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { method: request.method },
      });
      const mid = Math.floor(response.length / 2);
      socket.write(response.slice(0, mid));
      setImmediate(() => socket.write(response.slice(mid) + "\n"));
    });
    t.after(() => srv.stop());

    const client = new ForemanIpcClient({ path: srv.socketPath });
    t.after(() => client.close());

    const result = await client.request<{ method: string }>("ping");
    assert.deepEqual(result, { method: "ping" });
  },
);

test(
  "JSON-RPC error replies preserve code and data",
  { skip: isWindows },
  async (t) => {
    const srv = await startServer((socket, frame) => {
      const request = JSON.parse(frame) as { id: number };
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "boom",
            data: { detail: 42 },
          },
        }) + "\n",
      );
    });
    t.after(() => srv.stop());

    const client = new ForemanIpcClient({ path: srv.socketPath });
    t.after(() => client.close());

    await assert.rejects(
      client.request("fail"),
      (error: unknown) => {
        if (!(error instanceof ForemanRpcError)) return false;
        assert.equal(error.code, -32000);
        assert.equal(error.message, "boom");
        assert.deepEqual(error.data, { detail: 42 });
        return true;
      },
    );
  },
);

test(
  "requests time out when no reply arrives",
  { skip: isWindows },
  async (t) => {
    const srv = await startServer(() => {
      // Intentionally never reply.
    });
    t.after(() => srv.stop());

    const client = new ForemanIpcClient({
      path: srv.socketPath,
      requestTimeoutMs: 100,
    });
    t.after(() => client.close());

    await assert.rejects(client.request("slow"), /timed out/);
  },
);

test(
  "close rejects pending requests",
  { skip: isWindows },
  async (t) => {
    const srv = await startServer(() => {
      // Intentionally never reply.
    });
    t.after(() => srv.stop());

    const client = new ForemanIpcClient({
      path: srv.socketPath,
      requestTimeoutMs: 60_000,
    });
    t.after(() => client.close());

    const pending = client.request("never");
    client.close();
    await assert.rejects(pending, /closed before response/);
  },
);
