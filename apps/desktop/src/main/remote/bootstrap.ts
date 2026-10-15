import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';

import { WRENYARD_PROTOCOL_VERSION } from '@wrenyard/control';
import { parseUpdateFeedJson, resolveUpdateBaseUrl } from '@wrenyard/protocol/update-feed';

import { buildRemoteCommand, SshRelayError, type RemotePlatform } from './ssh-relay.js';

/**
 * Remote daemon bootstrap.
 *
 * Given a concrete SSH alias (plus the effective connection facts the caller
 * resolved), the target platform/arch and the exact product version, this
 * provisions a **version-compatible** per-user remote daemon and returns the
 * paths {@link SshRelay} needs: the remote bundled `nodePath`, the remote
 * `bridgePath` (the daemon bundle entry that speaks the stdio-bridge protocol)
 * and the remote daemon `ipcPath`. The caller never builds a remote command and
 * never has to know how the payload got there.
 *
 * Invariants:
 *  - **Confirm/Connect only.** Bootstrap is invoked by the Confirm and Connect
 *    actions; Test/probe must never call it (it installs nothing and persists
 *    nothing).
 *  - **Per-user, no sudo, no system install.** Everything the payload touches
 *    lives under `<home>/.wrenyard/remote/<version>`; no system path is written
 *    and no Desktop installer is used. The Windows NSIS installer is not a
 *    daemon archive and is never reused here.
 *  - **Versioned and checksummed.** The archive URL and digest come from the
 *    matching-version document of the *shared update feed*
 *    (`WRENYARD_UPDATE_BASE_URL`, else the canonical default) — the same
 *    convention the Desktop updater already uses, with no new release scheme.
 *    The digest is re-verified *on the target*, and an atomic ready marker is
 *    written only after a successful stage.
 *  - **Candidate `-F` until persist.** Every ssh invocation (probe, transfer,
 *    remote command) uses the caller's ephemeral candidate config, so a
 *    not-yet-persisted add-new host resolves identically to the stanza that will
 *    be appended. The default config applies only after that append.
 *  - **Native tooling before the payload lands.** The target does not have the
 *    bundled Node until the archive is extracted, so staging, the stdin
 *    transfer and the on-target digest check use POSIX shell / PowerShell
 *    tooling only — the "needs Node before Node is uploaded" paradox is
 *    repaired, not assumed away.
 *  - **Never replaces an incompatible live daemon.** A reachable daemon whose
 *    version differs fails closed; a compatible one is reused.
 *  - **Native OpenSSH, no credentials.** `BatchMode=yes`,
 *    `StrictHostKeyChecking=yes`, `ForwardAgent=no`; no password, private key or
 *    other secret is ever placed in argv, the environment or a log.
 *  - **Fail closed and clean up.** On failure only task-owned staging and the
 *    process this bootstrap launched are removed; user data and any pre-existing
 *    ready payload are preserved. Diagnostics are bounded and secret-free, and
 *    nothing is written to stdout that a caller could mistake for protocol data.
 *
 * Remote commands are built with the shared, vetted quoter
 * ({@link buildRemoteCommand}); dynamic values are never concatenated into a
 * shell string, and the only strings sent verbatim are fixed constants.
 *
 * Caller integration (Desktop main):
 *  1. On Confirm/Connect, resolve the host (`resolveSshHost`) and probe the
 *     remote platform/arch (Test already does this).
 *  2. Call `bootstrapRemoteDaemon({ target: { alias, platform, arch }, version,
 *     candidateConfigFile })` for the readiness gate.
 *  3. Build `new SshRelay({ target, remote: { ...result }, localEndpointPath,
 *     expectedVersion: version, candidateConfigFile, onTunnelLost })` and
 *     `await relay.start()` (its handshake is the final readiness gate).
 *  4. Persist: append the `Host` stanza, then `remote.host.save`; on failure
 *     restore the previous SSH config bytes.
 *  5. `relay.commitSshConfig()`, then switch the active context last.
 */

/** A single supported first-version remote install target. */
export type RemoteBootstrapTriplet = 'darwin-arm64' | 'win32-x64';

/** The remote install matrix, mirrored from the release payload builder. */
export const REMOTE_BOOTSTRAP_TARGETS: readonly RemoteBootstrapTriplet[] = Object.freeze([
  'darwin-arm64',
  'win32-x64',
]);

/** Stable failure codes surfaced to the caller (and shown to the user). */
export type RemoteBootstrapErrorCode =
  | 'aborted'
  | 'authentication'
  | 'host_key'
  | 'unsupported_platform'
  | 'unreachable'
  | 'timeout'
  | 'transfer'
  | 'checksum'
  | 'launch'
  | 'incompatible_version'
  | 'unsafe_argument';

/** A bootstrap failure with a stable code and a bounded, secret-free message. */
export class RemoteBootstrapError extends Error {
  readonly code: RemoteBootstrapErrorCode;

  constructor(code: RemoteBootstrapErrorCode, message: string) {
    super(message);
    this.name = 'RemoteBootstrapError';
    this.code = code;
  }
}

/** Effective SSH connection information resolved by the caller. */
export interface RemoteSshConnection {
  /** Concrete SSH `Host` alias. */
  readonly alias: string;
  /** Effective `HostName` from `ssh -G`, when known. */
  readonly hostname?: string | null;
  readonly user?: string | null;
  readonly port?: number | null;
}

export interface RemoteBootstrapTarget {
  readonly alias: string;
  /** Verified remote platform. Only `darwin`/`win32` are install targets. */
  readonly platform: RemotePlatform;
  /** Verified remote architecture. */
  readonly arch: string;
  readonly connection?: RemoteSshConnection;
}

/**
 * Where the matching-version payload archive comes from. By default it is read
 * from the shared update feed: the version document is fetched from
 * `WRENYARD_UPDATE_BASE_URL` (else the canonical feed) and its `remote_payloads`
 * entry for the target supplies both the URL and the sha256.
 */
export interface RemoteReleaseSource {
  /**
   * Feed base URL override; defaults to the shared
   * `resolveUpdateBaseUrl(env)` value (the `updates` branch root).
   */
  readonly baseUrl?: string;
  /**
   * Direct archive URL used *instead of* the feed document. Only for local
   * end-to-end fixtures; the digest is then computed from the local download.
   */
  readonly archiveUrl?: string;
  /** Upper bound on the downloaded archive size, in bytes. */
  readonly maxBytes?: number;
}

export interface RemoteBootstrapOptions {
  readonly target: RemoteBootstrapTarget;
  /** Exact product version; a mismatch with a live daemon fails closed. */
  readonly version: string;
  readonly releaseSource?: RemoteReleaseSource;
  /**
   * Ephemeral candidate SSH config passed with `ssh -F` to *every* remote
   * invocation (probe, transfer, remote command). It is the not-yet-persisted
   * add-new candidate, so bootstrap resolves exactly the stanza that will be
   * appended; absent for an already-configured alias.
   */
  readonly candidateConfigFile?: string;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

/** The remote bridge paths {@link SshRelay} consumes, plus how they were obtained. */
export interface RemoteBootstrapResult {
  /** `reused` when a compatible live daemon was adopted; `installed` otherwise. */
  readonly state: 'reused' | 'installed';
  readonly version: string;
  /** Absolute path of the remote per-user payload prefix. */
  readonly prefix: string;
  /** Remote bundled Node runtime. */
  readonly nodePath: string;
  /** Remote stdio-bridge entrypoint (`daemon/daemon.mjs`). */
  readonly bridgePath: string;
  /** Remote daemon owner-only IPC endpoint. */
  readonly ipcPath: string;
  /** Arguments appended after `bridgePath` for the stdio-bridge contract. */
  readonly bridgeArgs: string[];
}

interface SshRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no'];
const DEFAULT_CONNECT_TIMEOUT_SEC = 10;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 600_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HANDSHAKE_ATTEMPTS = 20;
const HANDSHAKE_DELAY_MS = 1_000;
const HANDSHAKE_PROBE_TIMEOUT_MS = 10_000;

/** The ssh binary; overridable for tests. Never a user-controlled value. */
function sshBinary(env: NodeJS.ProcessEnv): string {
  return env.WRENYARD_SSH_BIN?.trim() || 'ssh';
}

/** The remote path flavour for a target platform. */
function remotePath(platform: RemotePlatform): typeof pathPosix {
  return platform === 'win32' ? pathWin32 : pathPosix;
}

/** Reject a remote value that cannot be embedded safely. */
function assertSafeValue(value: string): void {
  if (/[\u0000\r\n]/.test(value)) {
    throw new RemoteBootstrapError('unsafe_argument', '远程路径包含不允许的控制字符');
  }
}

/** A PowerShell single-quoted literal (embedded quotes are doubled). */
function psQuote(value: string): string {
  assertSafeValue(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Wrap a remote Node source in the fixed, quote-safe loader. The source travels
 * base64-encoded, so double quotes, backslashes and `!` inside it never reach
 * the naive Windows cmd quoting — only this constant ASCII preface is quoted.
 * Data embedded in the source is always encoded with `JSON.stringify`.
 */
function nodeSourceArgv(source: string): string {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return `eval(Buffer.from('${encoded}','base64').toString('utf8'))`;
}

/**
 * PowerShell `-EncodedCommand` (UTF-16LE base64), so no PowerShell script text
 * is ever handed to the remote shell's quoting at all.
 */
function powershellArgv(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}

// ── Native remote tooling ───────────────────────────────────────────────────
// These run *before* the payload is extracted, when the target has no bundled
// Node yet. They are the repair for the bootstrap paradox: the bundle cannot be
// uploaded by the bundle's own runtime. Every argument is passed to the shared
// quoter as argv, and PowerShell steps run through `-EncodedCommand`, so no
// script text is ever handed to the remote shell's quoting.

/** Create a directory (`mkdir -p` / PowerShell `New-Item -Force`). */
function nativeMkdirArgv(platform: RemotePlatform, dir: string): string[] {
  return platform === 'win32'
    ? powershellArgv(`New-Item -ItemType Directory -Force -Path ${psQuote(dir)} | Out-Null`)
    : ['mkdir', '-p', dir];
}

/** Write this command's streamed stdin to `file` (the archive transfer). */
function nativeWriteStdinArgv(platform: RemotePlatform, file: string): string[] {
  if (platform === 'win32') {
    return powershellArgv(
      `$src=[Console]::OpenStandardInput();$dst=[IO.File]::OpenWrite(${psQuote(file)});$src.CopyTo($dst);$dst.Dispose()`,
    );
  }
  // `"$1"` is the file path handed over as a separate argv element: the shell
  // never re-parses a value that came from a variable expansion of the command.
  return ['sh', '-c', 'cat > "$1"', 'sh', file];
}

/** Hash a file with native tooling (`shasum` on macOS, `Get-FileHash` on Windows). */
function nativeHashArgv(platform: RemotePlatform, file: string): string[] {
  return platform === 'win32'
    ? powershellArgv(`(Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(file)}).Hash.ToLower()`)
    : ['shasum', '-a', '256', file];
}

/** Remove a directory this bootstrap owns, with native tooling only. */
function nativeRemoveDirArgv(platform: RemotePlatform, dir: string): string[] {
  return platform === 'win32'
    ? powershellArgv(`Remove-Item -LiteralPath ${psQuote(dir)} -Recurse -Force -ErrorAction SilentlyContinue`)
    : ['rm', '-rf', dir];
}

/** The lowercase sha256 from a native hash command's stdout (first token wins). */
function digestOf(stdout: string): string {
  return (stdout.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** First-version install support; anything else fails `unsupported_platform`. */
function assertSupportedTarget(platform: RemotePlatform, arch: string): RemoteBootstrapTriplet {
  const triplet = `${platform}-${arch}`;
  if (!REMOTE_BOOTSTRAP_TARGETS.includes(triplet as RemoteBootstrapTriplet)) {
    throw new RemoteBootstrapError(
      'unsupported_platform',
      `不支持的目标平台（${platform}-${arch}）；首版仅支持 macOS ARM64 与 Windows x64`,
    );
  }
  return triplet as RemoteBootstrapTriplet;
}

/** The matching-version remote payload archive name. */
export function remotePayloadArchiveName(version: string, triplet: RemoteBootstrapTriplet): string {
  return `wrenyard-remote-${version}-${triplet}.tar.gz`;
}

/** The closure entries a remote payload must contain, relative to its prefix. */
function requiredRemoteEntries(exeSuffix: string): readonly string[] {
  return [`runtime/node${exeSuffix}`, 'daemon/daemon.mjs', 'contracts/versions.json', 'SUITE_VERSION'];
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RemoteBootstrapError('aborted', '远程连接已取消');
}

/** Classify an ssh exit into a stable code without echoing remote text. */
function classifySshFailure(result: SshRunResult): RemoteBootstrapErrorCode {
  if (result.code === 124) return 'timeout';
  const text = result.stderr.toLowerCase();
  if (text.includes('host key verification failed') || text.includes('identification has changed')) return 'host_key';
  if (text.includes('permission denied') || text.includes('authentication failed') || text.includes('no such identity')) {
    return 'authentication';
  }
  return 'unreachable';
}

/**
 * Run one ssh invocation with the fixed safety options. `command` is either a
 * fixed constant or was produced by {@link buildRemoteCommand}; `input`, when
 * given, is written to the remote command's stdin rather than its argv.
 */
function runSsh(options: {
  binary: string;
  alias: string;
  command: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  /** Ephemeral candidate config; `-F` must precede every other operand. */
  candidateConfigFile?: string | undefined;
  /** Cancels the in-flight ssh child when the caller aborts. */
  signal?: AbortSignal | undefined;
  input?: Buffer | string;
}): Promise<SshRunResult> {
  return new Promise((resolvePromise) => {
    const args = [
      ...(options.candidateConfigFile ? ['-F', options.candidateConfigFile] : []),
      ...SSH_OPTIONS,
      '-o', `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SEC}`,
      options.alias,
      options.command,
    ];
    const child = spawn(options.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: options.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: SshRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise(result);
    };
    const onAbort = (): void => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: 124, stdout, stderr: 'aborted' });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 124, stdout, stderr: 'timeout' });
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-64 * 1024); });
    // stderr is bounded and used only for classification, never logged raw.
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8 * 1024); });
    child.on('error', () => finish({ code: 1, stdout, stderr }));
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr }));
    // A remote command that closes its stdin surfaces as EPIPE on the write
    // side; without a listener that stream error would crash the process.
    child.stdin?.on('error', () => finish({ code: 1, stdout, stderr }));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

/** Build a remote command from argv with the shared POSIX/Windows quoter. */
function remoteArgv(platform: RemotePlatform, argv: string[]): string {
  try {
    return buildRemoteCommand(platform, argv);
  } catch (error) {
    if (error instanceof SshRelayError) throw new RemoteBootstrapError('unsafe_argument', '无法安全构造远程命令');
    throw error;
  }
}

// ── Remote Node sources ─────────────────────────────────────────────────────
// Each source is a fixed template; dynamic values are embedded with
// `JSON.stringify`, and the whole source is base64-encoded into a constant
// quote-safe loader (see {@link nodeSourceArgv}), so a source containing double
// quotes, backslashes, newlines or `!` is never handed to the remote shell's
// quoting. They run with the remote bundled Node, so they only appear *after*
// the payload has been extracted; the pre-extraction steps use the native
// tooling above. stdin stays free for the archive transfer.

/**
 * Resolve the daemon's owner-only IPC endpoint exactly as the shared resolver
 * does (`packages/control/src/ipc-path.ts`): a non-blank `WRENYARD_IPC_PATH`,
 * then `config.service.ipc.path` from `WRENYARD_CONFIG_HOME/config.json` (else
 * `~/.config/wrenyard/config.json`), then the platform default. The Windows
 * pipe prefix and the forbidden pipe-name characters are injected as data so no
 * backslash is ever written literally here.
 */
function resolveIpcSource(): string {
  const pipe = '\\\\.\\pipe\\';
  const forbidden = '\\/:*?"<>|';
  return [
    "const fs=require('fs'),os=require('os'),p=require('path');",
    `const PIPE=${JSON.stringify(pipe)};`,
    `const FORBIDDEN=${JSON.stringify(forbidden)};`,
    "function baseDir(){if(process.platform==='win32')return null;try{return fs.realpathSync('/tmp');}catch(e){return fs.realpathSync(os.tmpdir());}}",
    "function normalize(name){if(process.platform==='win32'){if(name.indexOf(PIPE)===0)return name;let s=name;for(const ch of FORBIDDEN){s=s.split(ch).join('-');}return PIPE+s;}if(p.isAbsolute(name))return name;const b=baseDir();if(b)return p.join(b,name+'.sock');return name;}",
    "function configFile(){const root=(process.env.WRENYARD_CONFIG_HOME||'').trim();return p.join(root?p.resolve(root):p.join(os.homedir(),'.config','wrenyard'),'config.json');}",
    "function configured(){let raw;try{raw=fs.readFileSync(configFile(),'utf8');}catch(e){if(e&&e.code==='ENOENT')return undefined;throw e;}if(!raw.trim())return undefined;const c=JSON.parse(raw);if(!c||typeof c!=='object'||Array.isArray(c))throw new Error('invalid config json');const s=c.service;if(!s||typeof s!=='object'||Array.isArray(s))return undefined;const i=s.ipc;if(!i||typeof i!=='object'||Array.isArray(i))return undefined;const v=i.path;return (typeof v==='string'&&v.trim())?v.trim():undefined;}",
    "const envPath=(process.env.WRENYARD_IPC_PATH||'').trim();",
    "if(envPath){process.stdout.write(normalize(envPath));}",
    "else{const configuredPath=configured();process.stdout.write(configuredPath?normalize(configuredPath):normalize('wrenyard'));}",
  ].join('');
}

/**
 * Report whether an existing prefix is a reusable payload: its READY metadata
 * must match this version and target, every required entry must exist, and the
 * prefix runtime's *actual* platform/arch must equal the selected target — a
 * macOS x64 Node can run under Rosetta, so a successful exec alone is not
 * proof the payload matches.
 */
function reuseCheckSource(
  marker: string,
  entries: readonly string[],
  version: string,
  triplet: RemoteBootstrapTriplet,
  platform: RemotePlatform,
  arch: string,
): string {
  return [
    "const fs=require('fs');",
    `const MARKER=${JSON.stringify(marker)};`,
    `const ENTRIES=${JSON.stringify(entries)};`,
    `const EXPECTED_VERSION=${JSON.stringify(version)};`,
    `const EXPECTED_TARGET=${JSON.stringify(triplet)};`,
    `const EXPECTED_PLATFORM=${JSON.stringify(platform)};`,
    `const EXPECTED_ARCH=${JSON.stringify(arch)};`,
    'let ok=true;',
    "try{const meta=JSON.parse(fs.readFileSync(MARKER,'utf8'));if(!meta||meta.version!==EXPECTED_VERSION||meta.target!==EXPECTED_TARGET)ok=false;}catch(e){ok=false;}",
    "if(ok){for(const entry of ENTRIES){if(!fs.existsSync(entry)){ok=false;break;}}}",
    "if(ok&&(process.platform!==EXPECTED_PLATFORM||process.arch!==EXPECTED_ARCH))ok=false;",
    "process.stdout.write(ok?'ok':'no');",
  ].join('');
}

/**
 * Verify a freshly extracted staging payload *before* it is published: every
 * required entry must exist, the staged runtime's *actual* platform/arch must
 * equal the selected target, and `SUITE_VERSION` must name this exact version.
 * The target check runs before publishing because the staged exec could be the
 * wrong architecture (a macOS x64 Node under Rosetta), so a successful run is
 * not by itself proof of a target-native payload.
 */
function verifyStagedSource(
  entries: readonly string[],
  suiteVersionPath: string,
  version: string,
  platform: RemotePlatform,
  arch: string,
): string {
  return [
    "const fs=require('fs');",
    `const ENTRIES=${JSON.stringify(entries)};`,
    `const SUITE_VERSION=${JSON.stringify(suiteVersionPath)};`,
    `const EXPECTED_VERSION=${JSON.stringify(version)};`,
    `const EXPECTED_PLATFORM=${JSON.stringify(platform)};`,
    `const EXPECTED_ARCH=${JSON.stringify(arch)};`,
    "let state='ok';",
    "for(const entry of ENTRIES){if(!fs.existsSync(entry)){state='missing';break;}}",
    "if(state==='ok'&&(process.platform!==EXPECTED_PLATFORM||process.arch!==EXPECTED_ARCH))state='target';",
    "if(state==='ok'){let marker='';try{marker=fs.readFileSync(SUITE_VERSION,'utf8').trim();}catch(e){marker='';}if(marker!==EXPECTED_VERSION)state='version';}",
    "process.stdout.write(state);",
  ].join('');
}

/**
 * Publish a verified staging payload atomically: the READY marker is written
 * *inside* staging, so the final prefix never exists without it. A prefix that
 * already carries a READY marker is refused rather than overwritten, so a live
 * payload is never deleted blindly.
 */
function publishSource(staging: string, prefix: string, archivePath: string, payload: string): string {
  return [
    "const fs=require('fs'),p=require('path');",
    `const STAGING=${JSON.stringify(staging)};`,
    `const PREFIX=${JSON.stringify(prefix)};`,
    `const ARCHIVE=${JSON.stringify(archivePath)};`,
    `const PAYLOAD=${JSON.stringify(payload)};`,
    "if(fs.existsSync(p.join(PREFIX,'READY'))){process.stdout.write('occupied');}",
    "else{",
    "const marker=p.join(STAGING,'READY');const temp=marker+'.tmp-'+process.pid;fs.writeFileSync(temp,PAYLOAD);fs.renameSync(temp,marker);",
    "try{fs.rmSync(ARCHIVE,{force:true});}catch(e){}",
    "try{fs.rmSync(PREFIX,{recursive:true,force:true});}catch(e){}",
    "fs.renameSync(STAGING,PREFIX);",
    "process.stdout.write('published');",
    "}",
  ].join('');
}

/**
 * Probe the owner-only IPC for a live daemon and classify it against the exact
 * product and protocol versions. An endpoint that connects but is malformed,
 * erroring or silent is reported `incompatible` — never `unreachable` — so it is
 * neither adopted nor allowed to trigger a second launch.
 */
function probeSource(ipcPath: string, expectedVersion: string): string {
  return [
    "const net=require('net');",
    'const NL=String.fromCharCode(10);',
    `const IPC=${JSON.stringify(ipcPath)};`,
    `const EXPECTED_VERSION=${JSON.stringify(expectedVersion)};`,
    `const EXPECTED_PROTOCOL=${WRENYARD_PROTOCOL_VERSION};`,
    'let connected=false,settled=false,buffered="";',
    'const socket=net.connect(IPC);',
    "const finish=function(payload){if(settled)return;settled=true;try{socket.destroy();}catch(e){}process.stdout.write(JSON.stringify(payload));};",
    "const timer=setTimeout(function(){finish(connected?{state:'incompatible',reason:'timeout'}:{state:'unreachable'});},5000);",
    "socket.on('connect',function(){connected=true;socket.write(JSON.stringify({jsonrpc:'2.0',method:'health.ping',params:{protocolVersion:EXPECTED_PROTOCOL},id:1})+NL);});",
    "socket.on('data',function(chunk){buffered+=chunk.toString('utf8');const index=buffered.indexOf(NL);if(index<0)return;clearTimeout(timer);let message;try{message=JSON.parse(buffered.slice(0,index));}catch(e){return finish({state:'incompatible',reason:'malformed'});}if(!message||typeof message!=='object'||message.error!==undefined)return finish({state:'incompatible',reason:'error'});const result=message.result;if(!result||typeof result!=='object')return finish({state:'incompatible',reason:'malformed'});const protocol=result.protocolVersion;const identity=result.identity;const version=(identity&&typeof identity.version==='string')?identity.version:null;if(typeof protocol!=='number'||version===null)return finish({state:'incompatible',reason:'malformed'});if(protocol!==EXPECTED_PROTOCOL||version!==EXPECTED_VERSION)return finish({state:'incompatible',reason:'version'});return finish({state:'compatible'});});",
    "socket.on('error',function(){clearTimeout(timer);finish(connected?{state:'incompatible',reason:'error'}:{state:'unreachable'});});",
  ].join('');
}

/**
 * Launch the daemon with the real packaged contract — the bundled Node runs
 * `daemon/daemon.mjs run` with the payload prefix as cwd, exactly like
 * `packagedDaemonLaunch` — detached under the remote user's ownership.
 */
function launchSource(daemonPath: string, cwd: string, ipcPath: string): string {
  return [
    "const {spawn}=require('child_process');",
    `const env=Object.assign({},process.env,{WRENYARD_IPC_PATH:${JSON.stringify(ipcPath)}});`,
    `const child=spawn(process.execPath,[${JSON.stringify(daemonPath)},'run'],{detached:true,stdio:'ignore',cwd:${JSON.stringify(cwd)},env:env});`,
    'child.unref();',
    'process.stdout.write(String(child.pid));',
  ].join('');
}

/** Best-effort termination of a daemon this bootstrap launched, by numeric pid. */
function killSource(pid: number): string {
  return [
    `try{process.kill(${pid});}catch(e){}`,
    "process.stdout.write('ok');",
  ].join('');
}

/** Per-connection ssh runner bound to one alias/platform/env/candidate config. */
class RemoteRunner {
  readonly platform: RemotePlatform;
  private readonly binary: string;
  private readonly alias: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly candidateConfigFile: string | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(options: {
    alias: string;
    platform: RemotePlatform;
    env: NodeJS.ProcessEnv;
    candidateConfigFile?: string | undefined;
    signal?: AbortSignal | undefined;
  }) {
    this.alias = options.alias;
    this.platform = options.platform;
    this.env = options.env;
    this.candidateConfigFile = options.candidateConfigFile;
    this.signal = options.signal;
    this.binary = sshBinary(options.env);
  }

  /** Run a fixed command string (a constant, or one produced by {@link remoteArgv}). */
  async run(command: string, timeoutMs: number, input?: Buffer | string): Promise<SshRunResult> {
    const result = await runSsh({
      binary: this.binary,
      alias: this.alias,
      command,
      timeoutMs,
      env: this.env,
      candidateConfigFile: this.candidateConfigFile,
      signal: this.signal,
      input,
    });
    // An aborted signal kills the child; it must never be read as a real result.
    if (this.signal?.aborted) throw new RemoteBootstrapError('aborted', '远程连接已取消');
    return result;
  }

  /** Run a command whose argv contains dynamic values (safely quoted). */
  runArgv(argv: string[], timeoutMs: number, input?: Buffer | string): Promise<SshRunResult> {
    return this.run(remoteArgv(this.platform, argv), timeoutMs, input);
  }

  /** Run a remote Node source through the quote-safe base64 loader. */
  runNode(nodePath: string, source: string, timeoutMs: number, input?: Buffer | string): Promise<SshRunResult> {
    return this.runArgv([nodePath, '-e', nodeSourceArgv(source)], timeoutMs, input);
  }
}

type DaemonProbeState = 'unreachable' | 'compatible' | 'incompatible';

interface DaemonProbe {
  readonly state: DaemonProbeState;
  readonly reason?: string;
}

function parseProbe(stdout: string): DaemonProbe | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { state?: unknown; reason?: unknown };
    if (parsed.state === 'unreachable' || parsed.state === 'compatible' || parsed.state === 'incompatible') {
      return {
        state: parsed.state,
        ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Classify the remote endpoint against the exact product and protocol versions.
 * A probe script that fails to run means the socket was never reachable; a
 * script that ran but produced no valid classification is treated as
 * `incompatible` so a reachable-but-unknown endpoint is never launched over.
 */
async function probeDaemon(
  runner: RemoteRunner,
  nodePath: string,
  ipcPath: string,
  timeoutMs: number,
  version: string,
): Promise<DaemonProbe> {
  const result = await runner.runNode(nodePath, probeSource(ipcPath, version), timeoutMs);
  if (result.code !== 0) return { state: 'unreachable' };
  return parseProbe(result.stdout) ?? { state: 'incompatible', reason: 'malformed' };
}

/** The shared feed's immutable per-version document URL for the exact version. */
function versionDocumentUrl(baseUrl: string, version: string): string {
  const normalized = version.startsWith('v') ? version.slice(1) : version;
  return `${baseUrl.replace(/\/+$/, '')}/versions/${normalized}.json`;
}

interface ResolvedPayload {
  readonly url: string;
  /** The feed digest, or `null` for the loopback-only fixture URL. */
  readonly sha256: string | null;
}

/**
 * Resolve the matching-version remote payload from the shared update feed. The
 * version document is read from `WRENYARD_UPDATE_BASE_URL` (else the canonical
 * feed) through {@link resolveUpdateBaseUrl} — the exact convention the Desktop
 * updater already uses — and its `remote_payloads` entry for this target
 * supplies both the URL and the sha256. A feed published before remote payloads
 * existed fails closed instead of guessing an archive URL.
 */
async function resolvePayload(
  source: RemoteReleaseSource | undefined,
  version: string,
  triplet: RemoteBootstrapTriplet,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<ResolvedPayload> {
  if (source?.archiveUrl !== undefined && source.archiveUrl !== '') {
    // The digest-less direct URL is a local end-to-end fixture affordance only:
    // a real download always carries the feed's sha256.
    if (!isLoopbackFixtureUrl(source.archiveUrl)) {
      throw new RemoteBootstrapError('transfer', '直接下载地址仅限本地夹具使用');
    }
    return { url: source.archiveUrl, sha256: null };
  }
  const documentUrl = versionDocumentUrl(source?.baseUrl ?? resolveUpdateBaseUrl(env), version);
  const text = await fetchText(documentUrl, signal);
  let parsed;
  try {
    parsed = parseUpdateFeedJson(text, { triplet, expectedVersion: version });
  } catch {
    throw new RemoteBootstrapError('transfer', '远程载荷发布信息无效');
  }
  const entry = parsed.remotePayloads.find((payload) => payload.target === triplet);
  if (entry === undefined) {
    throw new RemoteBootstrapError('transfer', `当前版本未发布 ${triplet} 的远程载荷`);
  }
  return { url: entry.url, sha256: entry.sha256 };
}

/** Loopback-only `http` URL, used by local end-to-end fixtures. */
function isLoopbackFixtureUrl(url: string): boolean {
  return /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(url);
}

/** Refuse anything but https, or loopback http for local end-to-end fixtures. */
function assertFetchableUrl(url: string): void {
  if (!/^https:\/\//i.test(url) && !isLoopbackFixtureUrl(url)) {
    throw new RemoteBootstrapError('transfer', '远程载荷下载地址必须是 https');
  }
}

interface TimeoutGuard {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Combine the caller's signal with a bounded timeout; the timer is always cleared. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): TimeoutGuard {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Follow redirects manually so every hop is re-validated by
 * {@link assertFetchableUrl}: an unsafe redirect target is refused *before* the
 * request is made, not after it has already been followed.
 */
async function fetchFollowingSafeRedirects(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertFetchableUrl(current);
    const response = await fetch(current, { signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (response.body) { try { await response.body.cancel(); } catch { /* drained */ } }
      if (!location) throw new RemoteBootstrapError('transfer', '远程载荷下载重定向缺少目标地址');
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new RemoteBootstrapError('transfer', '远程载荷下载重定向次数过多');
}

/** Read a response body with a hard byte bound instead of buffering it all first. */
async function readBoundedBody(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* drained */ }
      throw new RemoteBootstrapError('transfer', `${label}超出大小上限`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Map any download failure to a stable, secret-free bootstrap error. */
function asDownloadFailure(error: unknown, signal: AbortSignal | undefined, guard: TimeoutGuard): RemoteBootstrapError {
  if (error instanceof RemoteBootstrapError) return error;
  if (signal?.aborted) return new RemoteBootstrapError('aborted', '远程连接已取消');
  if (guard.signal.aborted) return new RemoteBootstrapError('timeout', '远程下载超时');
  return new RemoteBootstrapError('transfer', '无法下载远程载荷');
}

/** Fetch a small text document; https (or loopback http for fixtures) only. */
async function fetchText(url: string, signal: AbortSignal | undefined): Promise<string> {
  const guard = withTimeout(signal, DEFAULT_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchFollowingSafeRedirects(url, guard.signal);
    if (!response.ok) throw new RemoteBootstrapError('transfer', `远程载荷发布信息不可用（HTTP ${response.status}）`);
    return (await readBoundedBody(response, MAX_FEED_BYTES, '远程载荷发布信息')).toString('utf8');
  } catch (error) {
    throw asDownloadFailure(error, signal, guard);
  } finally {
    guard.dispose();
  }
}

/** Fetch the matching-version platform archive; https only, streamed and bounded. */
async function downloadArchive(url: string, maxBytes: number, signal: AbortSignal | undefined): Promise<Buffer> {
  const guard = withTimeout(signal, DEFAULT_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchFollowingSafeRedirects(url, guard.signal);
    if (!response.ok) throw new RemoteBootstrapError('transfer', `远程载荷下载失败（HTTP ${response.status}）`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new RemoteBootstrapError('transfer', '远程载荷超出大小上限');
    }
    const buffer = await readBoundedBody(response, maxBytes, '远程载荷');
    if (buffer.length === 0) throw new RemoteBootstrapError('transfer', '远程载荷为空');
    return buffer;
  } catch (error) {
    throw asDownloadFailure(error, signal, guard);
  } finally {
    guard.dispose();
  }
}

/**
 * Provision (or adopt) a version-compatible remote daemon and return the bridge
 * paths {@link SshRelay} consumes.
 */
export async function bootstrapRemoteDaemon(options: RemoteBootstrapOptions): Promise<RemoteBootstrapResult> {
  const env = options.env ?? process.env;
  const { target, version, signal } = options;
  const triplet = assertSupportedTarget(target.platform, target.arch);
  assertNotAborted(signal);

  const runner = new RemoteRunner({
    alias: target.alias,
    platform: target.platform,
    env,
    ...(options.candidateConfigFile ? { candidateConfigFile: options.candidateConfigFile } : {}),
    ...(signal ? { signal } : {}),
  });
  const join = remotePath(target.platform).join;
  const exeSuffix = target.platform === 'win32' ? '.exe' : '';

  const home = await discoverHome(runner);
  const remoteRoot = join(home, '.wrenyard', 'remote');
  const prefix = join(remoteRoot, version);
  const marker = join(prefix, 'READY');
  const nodePath = join(prefix, 'runtime', `node${exeSuffix}`);
  const bridgePath = join(prefix, 'daemon', 'daemon.mjs');
  // A unique sibling staging directory with a cryptographic suffix: concurrent
  // installs of the same version can never share or stomp one another's staging.
  const staging = join(remoteRoot, `.staging-${version}-${randomBytes(8).toString('hex')}`);
  const archivePath = join(staging, 'payload.tar.gz');
  const requiredEntries = requiredRemoteEntries(exeSuffix).map((entry) => join(prefix, entry));

  let launchedPid: number | null = null;
  let completed = false;

  const cleanupOwned = async (): Promise<void> => {
    // Only task-owned staging and a daemon this bootstrap launched are removed;
    // a ready payload and user data survive. Native tooling removes the staging
    // directory because a failure before extraction means the bundled Node was
    // never uploaded.
    try { await runner.runArgv(nativeRemoveDirArgv(target.platform, staging), DEFAULT_COMMAND_TIMEOUT_MS); } catch { /* best effort */ }
    if (launchedPid !== null) {
      try { await runner.runNode(nodePath, killSource(launchedPid), DEFAULT_COMMAND_TIMEOUT_MS); } catch { /* best effort */ }
    }
  };

  const install = async (): Promise<void> => {
    assertNotAborted(signal);
    const release = await resolvePayload(options.releaseSource, version, triplet, env, signal);
    // A production download must carry the feed's sha256; a digest-less URL is
    // only ever the loopback end-to-end fixture path.
    if (release.sha256 === null && !isLoopbackFixtureUrl(release.url)) {
      throw new RemoteBootstrapError('checksum', '远程载荷缺少发布校验摘要');
    }
    const archive = await downloadArchive(release.url, options.releaseSource?.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES, signal);
    // The digest is computed from the bytes actually downloaded; when the feed
    // published one it must agree, so a corrupted download never lands.
    const expected = createHash('sha256').update(archive).digest('hex');
    if (release.sha256 !== null && release.sha256 !== expected) {
      throw new RemoteBootstrapError('checksum', '远程载荷校验失败');
    }

    // Everything up to and including extraction uses native tooling only: the
    // bundled Node is not on the target until the archive is unpacked.
    const staged = await runner.runArgv(nativeMkdirArgv(target.platform, staging), DEFAULT_COMMAND_TIMEOUT_MS);
    if (staged.code !== 0) throw new RemoteBootstrapError(classifySshFailure(staged), '无法在远程创建暂存目录');

    // Transfer the archive over ssh stdin: no argv and no shell interpolation.
    const written = await runner.runArgv(nativeWriteStdinArgv(target.platform, archivePath), DEFAULT_TRANSFER_TIMEOUT_MS, archive);
    if (written.code !== 0) throw new RemoteBootstrapError('transfer', '远程载荷传输失败');

    // Verify the digest *on the target*, so a corrupted transfer never lands.
    const verified = await runner.runArgv(nativeHashArgv(target.platform, archivePath), DEFAULT_COMMAND_TIMEOUT_MS);
    if (verified.code !== 0 || digestOf(verified.stdout) !== expected) {
      throw new RemoteBootstrapError('checksum', '远程载荷校验失败');
    }

    // Extract into the owned staging directory, never straight into the final
    // prefix, so a failed unpack can never damage an existing payload.
    const extracted = await runner.runArgv(
      ['tar', '-xzf', archivePath, '-C', staging],
      DEFAULT_TRANSFER_TIMEOUT_MS,
    );
    if (extracted.code !== 0) throw new RemoteBootstrapError('transfer', '远程载荷解压失败');

    // The staged Node now exists, so the staged payload verifies itself before
    // it is published: required entries, target platform/arch and the
    // SUITE_VERSION contract.
    const stagedNode = join(staging, 'runtime', `node${exeSuffix}`);
    const stagedEntries = requiredRemoteEntries(exeSuffix).map((entry) => join(staging, entry));
    const integrity = await runner.runNode(
      stagedNode,
      verifyStagedSource(stagedEntries, join(staging, 'SUITE_VERSION'), version, target.platform, target.arch),
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    if (integrity.code !== 0 || integrity.stdout.trim() !== 'ok') {
      throw new RemoteBootstrapError('transfer', '远程载荷内容与版本不匹配');
    }

    const payload = `${JSON.stringify({ version, target: triplet, sha256: expected, at: new Date().toISOString() })}\n`;
    const published = await runner.runNode(
      stagedNode,
      publishSource(staging, prefix, archivePath, payload),
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    if (published.code !== 0) throw new RemoteBootstrapError('transfer', '无法发布远程载荷');
    const outcome = published.stdout.trim();
    if (outcome === 'occupied') throw new RemoteBootstrapError('incompatible_version', '远程载荷目录已被占用，拒绝覆盖');
    if (outcome !== 'published') throw new RemoteBootstrapError('transfer', '无法发布远程载荷');
  };

  try {
    if (!(await payloadReady(runner, nodePath, marker, requiredEntries, version, triplet, target.platform, target.arch))) await install();

    assertNotAborted(signal);
    const ipcResult = await runner.runNode(nodePath, resolveIpcSource(), DEFAULT_COMMAND_TIMEOUT_MS);
    if (ipcResult.code !== 0) throw new RemoteBootstrapError(classifySshFailure(ipcResult), '无法解析远程 daemon IPC 路径');
    const ipcPath = ipcResult.stdout.trim();
    if (!ipcPath) throw new RemoteBootstrapError('unreachable', '远程 daemon IPC 路径为空');

    const bridgeArgs = ['--stdio-bridge', '--connect-to', ipcPath];

    // Adopt only an exactly compatible already-running daemon; a reachable but
    // malformed, erroring or version-mismatched endpoint fails closed here
    // rather than being adopted or triggering a second launch.
    const live = await probeDaemon(runner, nodePath, ipcPath, DEFAULT_COMMAND_TIMEOUT_MS, version);
    if (live.state === 'compatible') {
      completed = true;
      return { state: 'reused', version, prefix, nodePath, bridgePath, ipcPath, bridgeArgs };
    }
    if (live.state === 'incompatible') {
      throw new RemoteBootstrapError('incompatible_version', `远程 daemon 不兼容（${live.reason ?? 'unknown'}）`);
    }

    // Launch with the real packaged contract (`node daemon/daemon.mjs run`, cwd
    // = suite root), then await the handshake before reporting success.
    const launch = await runner.runNode(nodePath, launchSource(bridgePath, prefix, ipcPath), DEFAULT_COMMAND_TIMEOUT_MS);
    if (launch.code !== 0) throw new RemoteBootstrapError('launch', '无法启动远程 daemon');
    const pid = Number(launch.stdout.trim());
    // Only a validated numeric pid may ever be killed later.
    launchedPid = Number.isInteger(pid) && pid > 0 ? pid : null;

    for (let attempt = 0; attempt < HANDSHAKE_ATTEMPTS; attempt += 1) {
      assertNotAborted(signal);
      const probe = await probeDaemon(runner, nodePath, ipcPath, HANDSHAKE_PROBE_TIMEOUT_MS, version);
      if (probe.state === 'compatible') {
        completed = true;
        return { state: 'installed', version, prefix, nodePath, bridgePath, ipcPath, bridgeArgs };
      }
      if (probe.state === 'incompatible') {
        throw new RemoteBootstrapError('incompatible_version', `远程 daemon 不兼容（${probe.reason ?? 'unknown'}）`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, HANDSHAKE_DELAY_MS));
    }
    throw new RemoteBootstrapError('timeout', '等待远程 daemon 握手超时');
  } catch (error) {
    if (error instanceof RemoteBootstrapError) throw error;
    throw new RemoteBootstrapError('launch', '远程 daemon 引导失败');
  } finally {
    // A failed bootstrap cleans only what it owns. A successful bootstrap leaves
    // the published payload and a freshly launched daemon untouched.
    if (!completed) {
      try { await cleanupOwned(); } catch { /* best effort */ }
    }
  }
}

/** Discover the remote home directory, rejecting an empty answer. */
async function discoverHome(runner: RemoteRunner): Promise<string> {
  const result = runner.platform === 'win32'
    ? await runner.runArgv(powershellArgv('Write-Output $env:USERPROFILE'), DEFAULT_COMMAND_TIMEOUT_MS)
    : await runner.run(`printf '%s' "$HOME"`, DEFAULT_COMMAND_TIMEOUT_MS);
  if (result.code !== 0) throw new RemoteBootstrapError(classifySshFailure(result), '无法连接远程主机');
  const home = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? '';
  if (!home) throw new RemoteBootstrapError('unreachable', '无法确定远程主目录');
  return home;
}

/**
 * True when the existing prefix is a reusable payload: its READY metadata names
 * exactly this version and target, every required entry exists, and the prefix
 * runtime's actual platform/arch equals the selected target. READY existence
 * alone is never treated as integrity.
 */
async function payloadReady(
  runner: RemoteRunner,
  nodePath: string,
  marker: string,
  entries: readonly string[],
  version: string,
  triplet: RemoteBootstrapTriplet,
  platform: RemotePlatform,
  arch: string,
): Promise<boolean> {
  const result = await runner.runNode(
    nodePath,
    reuseCheckSource(marker, entries, version, triplet, platform, arch),
    DEFAULT_COMMAND_TIMEOUT_MS,
  );
  return result.code === 0 && result.stdout.trim() === 'ok';
}
