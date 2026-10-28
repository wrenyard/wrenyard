import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { connect as connectNet, createServer, type Server, type Socket } from 'node:net';

/**
 * SSH stdio relay.
 *
 * The relay bridges the *active* remote daemon's owner-only IPC to a single
 * local owner-only endpoint that every existing Desktop control consumer points
 * at, so nothing else needs to know whether the active endpoint is local or
 * remote. Each local connection opens one SSH-owned stdio tunnel to a remote
 * bridge that connects to the remote daemon's own owner-only IPC; raw NDJSON
 * frames pass through untouched, so the client's protocol-v2 handshake,
 * timeouts and cancellation stay exactly as they are locally.
 *
 * Safety rules:
 *  - The local endpoint is a Unix domain socket or a Windows named pipe; it is
 *    never a TCP/public network listener (see {@link assertOwnerOnlyEndpoint}).
 *    On Unix it is chmod'ed owner-only, exactly like the daemon's own IPC
 *    endpoint. On Windows the relay relies on the same default named-pipe
 *    protection the daemon's own IPC relies on; it does *not* apply its own
 *    ACL, so per-user endpoint ownership is not asserted here.
 *  - Until the add-new `Host` stanza has been appended to the user's config the
 *    relay runs every `ssh` invocation (handshake and tunnels) with `-F` on the
 *    ephemeral candidate config, so verification resolves exactly the stanza
 *    that will be persisted. {@link SshRelay.commitSshConfig} drops the
 *    candidate once the append succeeded and the default config applies.
 *  - The SSH client runs with `BatchMode=yes`, `StrictHostKeyChecking=yes` and
 *    `ForwardAgent=no`: no app-driven credential or agent forwarding beyond the
 *    SSH session itself, and no automatic host-key acceptance.
 *  - Remote command construction is platform-specific (POSIX shell vs. the
 *    Windows OpenSSH cmd.exe shell) and never concatenates an unchecked value
 *    into a shell string; it fails closed on a value it cannot quote safely.
 *  - Buffering is bounded in both directions; a peer that exceeds the bound has
 *    its connection dropped.
 *  - Only relay/daemon processes this relay started are ever cleaned up.
 *  - Protocol and same-product-version checks fail closed: {@link verify}
 *    completes a raw handshake and rejects an incompatible peer before any
 *    business traffic is accepted.
 */

export type RemotePlatform = 'darwin' | 'win32' | 'linux';

export interface SshRelayTarget {
  /** Concrete SSH `Host` alias. */
  alias: string;
  /** Verified remote platform; drives remote command quoting. */
  platform: RemotePlatform;
  /** Verified remote CPU architecture. */
  arch: string;
}

export interface SshRelayRemoteBridge {
  /** Absolute path of the remote Node runtime in the per-user payload. */
  nodePath: string;
  /** Absolute path of the remote stdio-bridge entry in the per-user payload. */
  bridgePath: string;
  /** Absolute path of the remote daemon's owner-only IPC endpoint on the target. */
  ipcPath: string;
  /**
   * Extra arguments appended after the bridge entry. Defaults to
   * `['--connect-to', ipcPath]`, the stdio-bridge contract.
   */
  bridgeArgs?: string[];
}

export interface SshRelayOptions {
  target: SshRelayTarget;
  remote: SshRelayRemoteBridge;
  /** Local owner-only endpoint path: a Unix socket or `\\.\pipe\...`. */
  localEndpointPath: string;
  /** Expected product version; a mismatch fails the relay closed. */
  expectedVersion: string;
  /** Expected control protocol version (the handshake contract). */
  expectedProtocolVersion?: number;
  /**
   * Ephemeral candidate SSH config passed with `ssh -F` for the verification
   * handshake and every tunnel until {@link SshRelay.commitSshConfig}. It is the
   * not-yet-persisted add-new candidate, so verification runs against exactly
   * the stanza that will be appended; the default config is used only after the
   * append succeeded.
   */
  candidateConfigFile?: string;
  env?: NodeJS.ProcessEnv;
  connectTimeoutSec?: number;
  /** Bounded per-connection buffer; a larger backlog drops the connection. */
  maxBufferedBytes?: number;
  /** Idle timeout for a local connection with no traffic, in milliseconds. */
  idleTimeoutMs?: number;
  /**
   * Fired when a tunnel's ssh child exits unexpectedly while a local client is
   * still connected. The owner turns this into an explicit disconnected-remote
   * state; the relay itself never falls back to local.
   */
  onTunnelLost?: (reason: string) => void;
}

export class SshRelayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SshRelayError';
    this.code = code;
  }
}

const DEFAULT_CONNECT_TIMEOUT_SEC = 10;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 0;
/**
 * Bound on concurrent ssh *establishments*, not on live tunnels. The default
 * OpenSSH `MaxStartups 10:30:100` throttles unauthenticated connections, so
 * the cap only needs to limit how many ssh children are still handshaking at
 * once; a tunnel that finished establishing frees its slot while staying
 * alive for its normal lifetime.
 */
const MAX_CONCURRENT_TUNNELS = 4;

/** A named pipe is the only non-TCP IPC endpoint on Windows. */
function isWindowsPipePath(path: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(path);
}

/**
 * Fail closed unless the local endpoint is a non-TCP IPC endpoint (a Unix
 * socket, or a named pipe on Windows). A TCP host:port (public network
 * listener) is refused outright.
 */
export function assertOwnerOnlyEndpoint(path: string): void {
  if (!path) throw new SshRelayError('invalid_endpoint', '本地端点路径为空');
  if (/^tcp:\/\//i.test(path) || /^https?:\/\//i.test(path)) {
    throw new SshRelayError('public_listener_forbidden', `不允许公网监听端点：${path}`);
  }
  if (process.platform === 'win32') {
    if (!isWindowsPipePath(path)) {
      throw new SshRelayError('invalid_endpoint', `Windows 端点必须是命名管道：${path}`);
    }
    return;
  }
  if (isWindowsPipePath(path)) {
    throw new SshRelayError('invalid_endpoint', `当前平台不支持命名管道端点：${path}`);
  }
}

/** Single-quote one POSIX shell argument, escaping embedded single quotes. */
function quotePosix(arg: string): string {
  if (/[\u0000\r\n]/.test(arg)) {
    throw new SshRelayError('unsafe_argument', '远程命令参数包含不允许的控制字符');
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Double-quote one argument for the Windows OpenSSH cmd.exe remote shell. */
function quoteWindows(arg: string): string {
  // cmd.exe expands %VAR% and !VAR! even inside quotes; refuse such values
  // rather than risk an injection through an expandable variable. A value with
  // an embedded double quote is refused too: cmd.exe has no reliable way to
  // escape a quote inside a double-quoted argument, so it fails closed instead
  // of emitting a backslash-escaped quote cmd.exe does not honour.
  if (/[\u0000\r\n]/.test(arg) || /["%!]/.test(arg)) {
    throw new SshRelayError('unsafe_argument', '远程命令参数无法在 cmd 下安全引用');
  }
  return `"${arg}"`;
}

/** Build the remote bridge command with platform-correct quoting. */
export function buildRemoteCommand(platform: RemotePlatform, argv: string[]): string {
  if (argv.length === 0) throw new SshRelayError('unsafe_argument', '远程命令为空');
  if (platform === 'win32') return argv.map(quoteWindows).join(' ');
  return argv.map(quotePosix).join(' ');
}

interface Tunnel {
  child: ChildProcessWithoutNullStreams;
  socket: Socket | null;
  /** Set the instant this relay begins tearing the tunnel down itself. */
  closing: boolean;
  /** True while the ssh child is still establishing; only these count against the cap. */
  establishing: boolean;
}

/**
 * Reflect the daemon's own IPC security. A live Unix socket must never be
 * unlinked out from under its owner: a second relay on the same path fails
 * closed instead of stealing the endpoint.
 */
function isUnixSocketActive(path: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connectNet(path);
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(active);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(100, () => finish(false));
  });
}

async function prepareLocalEndpoint(path: string): Promise<void> {
  if (process.platform === 'win32' || !existsSync(path)) return;
  if (await isUnixSocketActive(path)) {
    throw new SshRelayError('endpoint_in_use', `本地中继端点已被占用：${path}`);
  }
  // Never unlink an arbitrary file at this path. Only a Unix socket owned by
  // this user that nothing is listening on can be a stale endpoint left behind
  // by a crashed relay; anything else is a conflict this relay must not touch.
  let stats;
  try { stats = lstatSync(path); } catch { return; }
  if (!stats.isSocket()) {
    throw new SshRelayError('endpoint_conflict', `本地端点已被非套接字文件占用：${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new SshRelayError('endpoint_conflict', `本地端点属于其他用户：${path}`);
  }
  try { unlinkSync(path); } catch { /* best effort */ }
}

/** Remove a leftover local endpoint this relay bound itself. */
function removeLocalEndpoint(path: string): void {
  if (process.platform === 'win32' || !existsSync(path)) return;
  let stats;
  try { stats = lstatSync(path); } catch { return; }
  if (!stats.isSocket()) return;
  try { unlinkSync(path); } catch { /* best effort */ }
}

export class SshRelay {
  private readonly options: SshRelayOptions;
  private server: Server | null = null;
  /** True only after this relay successfully bound its local endpoint. */
  private bound = false;
  /** The live `-F` candidate, or null once the default config applies. */
  private candidateConfigFile: string | null;
  private readonly tunnels = new Set<Tunnel>();
  /** Accepted local sockets waiting for an ssh establishment slot below the cap. */
  private readonly socketQueue: Socket[] = [];
  /** Per-queued-socket deadline timers; cleared on promote or close. */
  private readonly queueTimers = new Map<Socket, NodeJS.Timeout>();
  /** Single-flight guard for the last-tunnel-lost health probe. */
  private healthProbeInFlight = false;
  private stopped = false;

  constructor(options: SshRelayOptions) {
    this.options = options;
    this.candidateConfigFile = options.candidateConfigFile ?? null;
  }

  get endpoint(): string {
    return this.options.localEndpointPath;
  }

  /**
   * Stop using the ephemeral candidate config. Called after the add-new `Host`
   * stanza has been appended: from here on the user's default config resolves
   * the same host, so the candidate temp file can be removed.
   */
  commitSshConfig(): void {
    this.candidateConfigFile = null;
  }

  /**
   * Create the local owner-only endpoint, then verify the remote peer's protocol
   * and product version. Verification is fail-closed: an incompatible peer ends
   * the relay before it accepts a single business connection.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new SshRelayError('stopped', '中继已停止');
    assertOwnerOnlyEndpoint(this.options.localEndpointPath);
    await prepareLocalEndpoint(this.options.localEndpointPath);
    await this.verify();
    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on('error', () => { /* surfaced through a failed connection */ });
    await new Promise<void>((resolvePromise, reject) => {
      const onListenError = (error: Error): void => reject(error);
      this.server!.once('error', onListenError);
      this.server!.listen(this.options.localEndpointPath, () => {
        this.bound = true;
        this.server!.off('error', onListenError);
        if (process.platform !== 'win32') {
          // Owner-only, exactly like the daemon's own Unix IPC endpoint. On
          // Windows the relay keeps the default named-pipe protection the
          // daemon's IPC also relies on and asserts no ownership of its own.
          try {
            chmodSync(this.options.localEndpointPath, 0o600);
          } catch (error) {
            reject(error as Error);
            return;
          }
        }
        resolvePromise();
      });
    });
  }

  /** Close the local endpoint and clean up only the tunnels this relay started. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const tunnel of [...this.tunnels]) this.closeTunnel(tunnel);
    this.tunnels.clear();
    for (const timer of this.queueTimers.values()) clearTimeout(timer);
    this.queueTimers.clear();
    for (const socket of this.socketQueue.splice(0)) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    // Remove only an endpoint this relay actually bound: a relay whose start()
    // failed on a colliding path must never unlink a socket it does not own.
    if (this.bound) {
      this.bound = false;
      removeLocalEndpoint(this.options.localEndpointPath);
    }
  }

  /**
   * Raw `health.ping` handshake over a throwaway tunnel. It asserts the control
   * protocol version and the exact product version, so a peer that is not the
   * same product/version fails closed.
   */
  async verify(): Promise<void> {
    const expectedProtocol = this.options.expectedProtocolVersion ?? 2;
    const tunnel = this.openTunnel();
    let buffered = '';
    try {
      const result = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new SshRelayError('verify_timeout', '远程握手超时')), 15_000);
        const onData = (chunk: Buffer): void => {
          buffered += chunk.toString('utf8');
          const newline = buffered.indexOf('\n');
          if (newline < 0) {
            if (buffered.length > 1_000_000) {
              clearTimeout(timer);
              reject(new SshRelayError('verify_oversize', '远程握手响应过大'));
            }
            return;
          }
          clearTimeout(timer);
          tunnel.child.stdout.off('data', onData);
          const line = buffered.slice(0, newline);
          try {
            const parsed = JSON.parse(line) as { result?: unknown };
            resolvePromise((parsed.result as Record<string, unknown>) ?? {});
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        tunnel.child.stdout.on('data', onData);
        tunnel.child.once('error', (error) => { clearTimeout(timer); reject(error); });
        tunnel.child.once('exit', (code) => {
          if (code !== 0) { clearTimeout(timer); reject(new SshRelayError('verify_exit', `远程握手进程退出（code ${code ?? 'none'}）`)); }
        });
        const request = JSON.stringify({ jsonrpc: '2.0', method: 'health.ping', params: { protocolVersion: expectedProtocol }, id: 1 });
        tunnel.child.stdin.write(`${request}\n`);
      });
      const protocolVersion = typeof result.protocolVersion === 'number' ? result.protocolVersion : undefined;
      if (protocolVersion !== expectedProtocol) {
        throw new SshRelayError('protocol_mismatch', `远程协议版本不兼容（期望 ${expectedProtocol}，实际 ${String(protocolVersion)}）`);
      }
      const identity = result.identity as { version?: unknown } | undefined;
      const version = identity && typeof identity.version === 'string' ? identity.version : undefined;
      if (version !== this.options.expectedVersion) {
        throw new SshRelayError('version_mismatch', `远程 daemon 版本不匹配（期望 ${this.options.expectedVersion}，实际 ${String(version)}）`);
      }
    } finally {
      this.closeTunnel(tunnel);
    }
  }

  /** Tunnels whose ssh child is still handshaking; only these hold a slot. */
  private establishingCount(): number {
    let count = 0;
    for (const tunnel of this.tunnels) if (tunnel.establishing) count++;
    return count;
  }

  private handleConnection(socket: Socket): void {
    if (this.stopped) { socket.destroy(); return; }
    // Beyond the establishment cap the socket waits (paused, so its data is
    // buffered by the OS) until an in-flight ssh handshake frees a slot;
    // spawning another ssh child here would just be dropped by the remote
    // MaxStartups throttle.
    if (this.establishingCount() >= MAX_CONCURRENT_TUNNELS) {
      socket.pause();
      const drop = (): void => {
        const index = this.socketQueue.indexOf(socket);
        if (index >= 0) this.socketQueue.splice(index, 1);
        const timer = this.queueTimers.get(socket);
        if (timer) {
          clearTimeout(timer);
          this.queueTimers.delete(socket);
        }
      };
      socket.once('close', drop);
      socket.once('error', drop);
      this.socketQueue.push(socket);
      // 15s stays safely under the caller's 30s WrenyardRpcTimeoutError.
      this.queueTimers.set(socket, setTimeout(() => socket.destroy(), 15_000));
      return;
    }
    this.attachSocket(socket);
  }

  /** Dequeue the next waiting socket into a freed establishment slot, if any. */
  private promoteQueuedSocket(): void {
    if (this.stopped) return;
    while (this.socketQueue.length > 0 && this.establishingCount() < MAX_CONCURRENT_TUNNELS) {
      const socket = this.socketQueue.shift()!;
      const timer = this.queueTimers.get(socket);
      if (timer) {
        clearTimeout(timer);
        this.queueTimers.delete(socket);
      }
      if (socket.destroyed) continue;
      socket.resume();
      this.attachSocket(socket);
      return;
    }
  }

  private attachSocket(socket: Socket): void {
    let tunnel: Tunnel;
    try {
      tunnel = this.openTunnel();
    } catch {
      socket.destroy();
      return;
    }
    this.tunnels.add(tunnel);
    tunnel.socket = socket;

    // The tunnel holds an establishment slot only until the ssh child's first
    // output, which means the handshake completed and the bridge is up; a
    // handshake that dies first frees its slot through closeTunnel instead.
    const established = (): void => {
      if (!tunnel.establishing) return;
      tunnel.establishing = false;
      this.promoteQueuedSocket();
    };
    tunnel.child.stdout.once('data', established);
    tunnel.child.stderr.once('data', established);

    let buffered = 0;
    let remoteBuffered = 0;
    const max = this.options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    const abort = (): void => this.closeTunnel(tunnel);

    // Local socket -> remote child stdin, bounded and backpressured.
    socket.on('data', (chunk: Buffer) => {
      if (tunnel.child.stdin.destroyed) return;
      buffered += chunk.length;
      if (buffered > max) { abort(); return; }
      const ok = tunnel.child.stdin.write(chunk, () => { buffered -= chunk.length; });
      if (!ok) socket.pause();
    });
    tunnel.child.stdin.on('drain', () => { if (!socket.destroyed) socket.resume(); });

    // Remote child stdout -> local socket, bounded and backpressured in the
    // same way: without this the remote direction is unbounded.
    tunnel.child.stdout.on('data', (chunk: Buffer) => {
      if (socket.destroyed) return;
      remoteBuffered += chunk.length;
      if (remoteBuffered > max) { abort(); return; }
      const ok = socket.write(chunk, () => { remoteBuffered -= chunk.length; });
      if (!ok) tunnel.child.stdout.pause();
    });
    socket.on('drain', () => { if (!tunnel.child.stdout.destroyed) tunnel.child.stdout.resume(); });
    tunnel.child.stdout.on('end', () => { if (!socket.destroyed) socket.end(); });

    socket.on('error', abort);
    socket.on('close', abort);
    // Every stream in the tunnel can fail on a broken ssh session; a stream
    // 'error' with no listener would otherwise crash the process.
    tunnel.child.on('error', abort);
    tunnel.child.stdin.on('error', abort);
    tunnel.child.stdout.on('error', abort);
    tunnel.child.on('exit', (code) => {
      // Only an *unexpected* child exit while our client is still connected is
      // a tunnel loss. A normal per-request closure (the client closed first,
      // or ssh exited 0 after its stdin reached EOF) must never be reported as
      // a lost tunnel, and a teardown this relay initiated is never a loss.
      const unexpected = !this.stopped && !tunnel.closing && !socket.destroyed;
      abort();
      if (!unexpected || code === 0) return;
      // While other tunnels are alive this is a transient per-tunnel loss
      // (for example an sshd MaxStartups drop), not a lost remote: only when
      // the last tunnel died do we probe whether the remote is really gone.
      if (this.tunnels.size > 0) return;
      this.probeRemoteOrLost(`ssh 退出（code ${code ?? 'none'}）`);
    });

    if (this.options.idleTimeoutMs && this.options.idleTimeoutMs > 0) {
      socket.setTimeout(this.options.idleTimeoutMs, () => socket.destroy());
    }
  }

  private openTunnel(): Tunnel {
    const env = this.options.env ?? process.env;
    const binary = env.WRENYARD_SSH_BIN?.trim() || 'ssh';
    const connectTimeoutSec = this.options.connectTimeoutSec ?? DEFAULT_CONNECT_TIMEOUT_SEC;
    const bridgeArgs = this.options.remote.bridgeArgs ?? ['--connect-to', this.options.remote.ipcPath];
    const remoteCommand = buildRemoteCommand(this.options.target.platform, [
      this.options.remote.nodePath,
      this.options.remote.bridgePath,
      ...bridgeArgs,
    ]);
    const args = [
      // The candidate `-F` (add-new) must precede every other option and the
      // host operand so it selects the config before the alias is resolved.
      ...(this.candidateConfigFile ? ['-F', this.candidateConfigFile] : []),
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ForwardAgent=no',
      '-o', `ConnectTimeout=${connectTimeoutSec}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      this.options.target.alias,
      remoteCommand,
    ];
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // stderr is drained but never logged raw: it may echo remote user text. Its
    // 'error' is swallowed for the same reason every other stream error is
    // handled: an unlistened stream error would crash the process.
    child.stderr.on('data', () => { /* drained */ });
    child.stderr.on('error', () => { /* drained */ });
    // A stdin write fails (EPIPE) once the remote end closes the command's
    // stdin. The tunnel owner decides what that means; this listener only keeps
    // the failure from becoming an unhandled stream error.
    child.stdin.on('error', () => { /* handled by the tunnel owner */ });
    return { child: child as ChildProcessWithoutNullStreams, socket: null, closing: false, establishing: true };
  }

  private closeTunnel(tunnel: Tunnel): void {
    tunnel.closing = true;
    this.tunnels.delete(tunnel);
    if (!tunnel.child.killed) tunnel.child.kill();
    if (tunnel.socket && !tunnel.socket.destroyed) tunnel.socket.destroy();
    this.promoteQueuedSocket();
  }

  /**
   * Last-tunnel-lost health probe. A single unexpected ssh exit can mean the
   * whole remote is gone, but it can also be a transient per-connection drop;
   * only a failed probe (single-flight, same binary/args/host as a tunnel)
   * is reported upwards as a lost remote.
   */
  private probeRemoteOrLost(reason: string): void {
    if (this.stopped || this.healthProbeInFlight) return;
    this.healthProbeInFlight = true;
    void this.verify()
      .then(() => {
        // Probe succeeded but a fresh tunnel may have died while it ran;
        // re-check before concluding the remote is still healthy.
        if (this.stopped || this.tunnels.size > 0 || this.socketQueue.length > 0) return;
        this.probeRemoteOrLost(reason);
      })
      .catch(() => {
        if (!this.stopped) this.options.onTunnelLost?.(reason);
      })
      .finally(() => {
        this.healthProbeInFlight = false;
      });
  }
}
