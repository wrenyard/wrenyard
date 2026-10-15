import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Local SSH host discovery.
 *
 * It enumerates the concrete `Host` aliases the user configured (following
 * `Include` directives), resolves each alias' effective configuration with
 * `ssh -G`, and reports display name, address and a *detected* remote OS. Facts
 * that are not yet known are reported as `null` rather than fabricated.
 *
 * Safety rules:
 *  - The user's SSH configuration is trusted input and is never modified here;
 *    discovery only reads it.
 *  - Every external call uses the native OpenSSH client with `BatchMode=yes` and
 *    `StrictHostKeyChecking=yes`, bounded by explicit connect/probe timeouts.
 *  - No shell is used: arguments are passed as an argv array, so an alias can
 *    never be interpreted as a shell fragment.
 *  - No password, private key or other secret is ever placed into argv or logs.
 */

/** The OpenSSH binary; overridable for tests. Never a user-controlled value. */
function sshBinary(env: NodeJS.ProcessEnv): string {
  return env.WRENYARD_SSH_BIN?.trim() || 'ssh';
}

export interface SshDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  /** Explicit SSH config file; defaults to `~/.ssh/config`. */
  configPath?: string;
  /**
   * Ephemeral config file passed with `ssh -F` (an add-new candidate). When set,
   * only that file plus the system config apply; the candidate normally
   * `Include`s the user's own config so routing/auth still inherit.
   */
  configFile?: string;
  /** Bounded connect timeout for `ssh -G`/probe calls, in seconds. */
  connectTimeoutSec?: number;
  /** Hard ceiling for one ssh invocation, in milliseconds. */
  timeoutMs?: number;
  /** Remote command timeout used by {@link probeSshHost}, in seconds. */
  remoteTimeoutSec?: number;
}

export interface DiscoveredSshHost {
  /** Concrete SSH `Host` alias. */
  alias: string;
  /** Display name: `user@host` when resolvable, else the alias. */
  displayName: string;
  /** Effective `HostName` from `ssh -G`; `null` when it cannot be resolved. */
  address: string | null;
  /** Detected remote OS (`darwin`/`win32`/`linux`); `null` until probed. */
  os: string | null;
}

export interface ResolvedSshHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  displayName: string;
}

export interface RemotePlatformProbe {
  /** Detected OS (`darwin`/`win32`/`linux`) or `null` when unknown. */
  platform: string | null;
  /** Detected CPU architecture (`arm64`/`x64`) or `null` when unknown. */
  arch: string | null;
}

const DEFAULT_CONNECT_TIMEOUT_SEC = 8;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_REMOTE_TIMEOUT_SEC = 8;
const MAX_INCLUDE_DEPTH = 8;
const MAX_HOSTS = 200;

/** Build the ssh argv prefix shared by discovery and probing. */
function sshOptionArgs(connectTimeoutSec: number, configFile?: string): string[] {
  return [
    // `-F` selects the config file; it must precede the host operand. The
    // candidate file itself Includes the user's config for inheritance.
    ...(configFile ? ['-F', configFile] : []),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no',
    '-o', `ConnectTimeout=${connectTimeoutSec}`,
  ];
}

function runSsh(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise) => {
    execFile(binary, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout) => {
      const text = typeof stdout === 'string' ? stdout : '';
      if (error) {
        const code = typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : 1;
        resolvePromise({ stdout: text, code });
        return;
      }
      resolvePromise({ stdout: text, code: 0 });
    });
  });
}

/**
 * A concrete host alias: not a wildcard, not a negation, not an option. Wildcard
 * and negated `Host` patterns are configuration selectors, not connectable
 * hosts, so they are skipped rather than listed.
 */
function isConcreteAlias(alias: string): boolean {
  if (!alias || alias.startsWith('-') || alias.startsWith('!')) return false;
  if (/[*?]/.test(alias)) return false;
  if (/[\u0000-\u0020\u007f]/.test(alias)) return false;
  return true;
}

/** Expand a possibly-globbed `Include` path relative to the SSH config dir. */
function expandInclude(pattern: string, baseDir: string): string[] {
  const candidate = isAbsolute(pattern) ? pattern : join(baseDir, pattern);
  if (!/[*?]/.test(candidate)) return existsSync(candidate) ? [candidate] : [];
  const dir = dirname(candidate);
  const glob = basename(candidate);
  if (!existsSync(dir)) return [];
  const regex = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try {
    return readdirSync(dir).filter((name) => regex.test(name)).map((name) => join(dir, name)).sort();
  } catch {
    return [];
  }
}

/** Collect the config files reachable from a root config, following Includes. */
function collectConfigFiles(rootPath: string): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const walk = (filePath: string, depth: number): void => {
    const canonical = resolve(filePath);
    if (depth > MAX_INCLUDE_DEPTH || visited.has(canonical) || !existsSync(canonical)) return;
    visited.add(canonical);
    files.push(canonical);
    let content: string;
    try {
      content = readFileSync(canonical, 'utf8');
    } catch {
      return;
    }
    const baseDir = dirname(canonical);
    for (const rawLine of content.split(/\r?\n/)) {
      const match = /^\s*Include\s+(.+?)\s*$/i.exec(rawLine);
      if (!match) continue;
      for (const pattern of match[1].split(/\s+/).filter(Boolean)) {
        for (const included of expandInclude(pattern, baseDir)) walk(included, depth + 1);
      }
    }
  };
  walk(rootPath, 0);
  return files;
}

/** Extract the concrete `Host` aliases from a list of config files. */
function readHostAliases(files: string[]): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of content.split(/\r?\n/)) {
      // Strip trailing comments conservatively: `#` starts a comment when it is
      // not inside the alias token list. Alias lists never contain `#`.
      const line = rawLine.replace(/\s+#.*$/, '');
      const match = /^\s*Host\s+(.+?)\s*$/i.exec(line);
      if (!match) continue;
      for (const token of match[1].split(/\s+/)) {
        if (!isConcreteAlias(token) || seen.has(token)) continue;
        seen.add(token);
        aliases.push(token);
        if (aliases.length >= MAX_HOSTS) return aliases;
      }
    }
  }
  return aliases;
}

/** Parse `ssh -G <alias>` output into a lowercase key -> value map. */
function parseEffectiveConfig(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space).toLowerCase();
    const value = line.slice(space + 1).trim();
    // First occurrence wins: `ssh -G` reports the effective value first.
    if (!values.has(key)) values.set(key, value);
  }
  return values;
}

/** Resolve one alias' effective configuration with `ssh -G`. */
export async function resolveSshHost(
  alias: string,
  options: SshDiscoveryOptions = {},
): Promise<ResolvedSshHost> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { stdout } = await runSsh(
    sshBinary(env),
    ['-G', ...sshOptionArgs(options.connectTimeoutSec ?? DEFAULT_CONNECT_TIMEOUT_SEC, options.configFile), alias],
    timeoutMs,
  );
  const values = parseEffectiveConfig(stdout);
  const hostname = values.get('hostname')?.trim() || null;
  const user = values.get('user')?.trim() || null;
  const portRaw = values.get('port');
  const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : null;
  const displayName = user && hostname ? `${user}@${hostname}` : (hostname ?? alias);
  return { alias, hostname, user, port, displayName };
}

/**
 * Probe the remote platform/arch without installing anything. It first tries a
 * POSIX `uname`; when the remote shell is Windows (cmd.exe), it falls back to
 * `cmd /c ver` plus the processor architecture variable. Unknown stays `null`.
 */
export async function probeSshHost(
  alias: string,
  options: SshDiscoveryOptions = {},
): Promise<RemotePlatformProbe> {
  const env = options.env ?? process.env;
  const binary = sshBinary(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remoteTimeoutSec = options.remoteTimeoutSec ?? DEFAULT_REMOTE_TIMEOUT_SEC;
  const prefix = ['-T', ...sshOptionArgs(options.connectTimeoutSec ?? DEFAULT_CONNECT_TIMEOUT_SEC, options.configFile)];

  const posix = await runSsh(
    binary,
    [...prefix, alias, `-- uname -s; uname -m`],
    timeoutMs,
  );
  if (posix.code === 0) {
    const lines = posix.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const platform = normalizePlatform(lines[0]);
    const arch = normalizeArch(lines[1]);
    if (platform || arch) return { platform, arch };
  }

  // Windows OpenSSH runs the remote command through cmd.exe by default.
  const winOs = await runSsh(binary, [...prefix, alias, `cmd /c ver`], timeoutMs);
  if (winOs.code === 0 && /Windows/i.test(winOs.stdout)) {
    const archOut = await runSsh(
      binary,
      [...prefix, alias, `cmd /c echo %PROCESSOR_ARCHITECTURE%`],
      Math.min(timeoutMs, remoteTimeoutSec * 1000 + 2_000),
    );
    return { platform: 'win32', arch: normalizeWindowsArch(archOut.stdout) };
  }
  return { platform: null, arch: null };
}

function normalizePlatform(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (text.startsWith('darwin')) return 'darwin';
  if (text.startsWith('linux')) return 'linux';
  if (text.startsWith('mingw') || text.startsWith('msys') || text.startsWith('windows')) return 'win32';
  return null;
}

function normalizeArch(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (text === 'arm64' || text === 'aarch64') return 'arm64';
  if (text === 'x86_64' || text === 'amd64' || text === 'x64') return 'x64';
  return null;
}

function normalizeWindowsArch(value: string): string | null {
  const text = value.trim().toUpperCase();
  if (text.includes('ARM64')) return 'arm64';
  if (text.includes('AMD64') || text.includes('X64')) return 'x64';
  return null;
}

/**
 * Enumerate the concrete local SSH hosts. Each alias' effective `HostName` is
 * resolved with `ssh -G`; OS stays `null` (honest unknown) until a probe runs.
 * Aliases whose effective config cannot be read are still listed, with an
 * unknown address, rather than being dropped.
 */
export async function listLocalSshHosts(
  options: SshDiscoveryOptions = {},
): Promise<DiscoveredSshHost[]> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? join(homedir(), '.ssh', 'config');
  if (!existsSync(configPath)) return [];
  const aliases = readHostAliases(collectConfigFiles(configPath));
  const hosts: DiscoveredSshHost[] = [];
  for (const alias of aliases) {
    try {
      const resolved = await resolveSshHost(alias, options);
      hosts.push({
        alias,
        displayName: resolved.displayName,
        address: resolved.hostname,
        os: null,
      });
    } catch {
      hosts.push({ alias, displayName: alias, address: null, os: null });
    }
  }
  return hosts;
}

/**
 * Validate a candidate alias for a new SSH configuration. Validation is
 * structural only (it never runs a command), rejects option/newline injection,
 * and returns the trimmed alias so the caller can build a `Host` stanza safely.
 */
export function validateSshAlias(value: unknown): { ok: true; alias: string } | { ok: false; message: string } {
  if (typeof value !== 'string') return { ok: false, message: 'SSH 别名无效' };
  const alias = value.trim();
  if (alias === '') return { ok: false, message: '请输入 SSH 别名' };
  if (!isConcreteAlias(alias)) return { ok: false, message: '别名不能包含通配符、感叹号或空白' };
  if (alias.length > 255) return { ok: false, message: '别名过长' };
  return { ok: true, alias };
}

/* ------------------------------------------------------------------ */
/* Add-new SSH configuration: ephemeral candidate + atomic stanza      */
/* ------------------------------------------------------------------ */

/** Minimal add-new form fields; every field is optional except `alias`. */
export interface SshHostCandidateInput {
  alias?: unknown;
  host?: unknown;
  user?: unknown;
  port?: unknown;
  identityPath?: unknown;
}

/** A structurally validated candidate; empty strings became `null`. */
export interface SshHostCandidate {
  alias: string;
  host: string | null;
  user: string | null;
  port: number | null;
  identityPath: string | null;
}

export type SshCandidateValidation =
  | { ok: true; candidate: SshHostCandidate }
  | { ok: false; message: string };

const HOST_MAX = 255;
const USER_MAX = 64;
const IDENTITY_PATH_MAX = 1024;

/**
 * Hostnames, IPv4 and IPv6 literals only. Whitespace, quotes, comment markers
 * and shell metacharacters are refused so a value can never alter the rendered
 * stanza or reach an option position.
 */
function isSafeHost(value: string): boolean {
  return value.length <= HOST_MAX && !value.startsWith('-') && /^[A-Za-z0-9._:[\]-]+$/.test(value);
}

function isSafeUser(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${USER_MAX - 1}}$`).test(value);
}

function isSafeIdentityPath(value: string): boolean {
  if (value.length > IDENTITY_PATH_MAX || !isAbsolute(value)) return false;
  return !/[\u0000-\u001f\u007f\s"'#]/.test(value);
}

/**
 * Validate the add-new candidate structurally. No command runs and nothing is
 * written: this is the shared boundary for silent validation, Test and Confirm.
 */
export function validateSshCandidate(input: unknown): SshCandidateValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'SSH 配置无效' };
  }
  const record = input as SshHostCandidateInput;
  const alias = validateSshAlias(record.alias);
  if (!alias.ok) return alias;

  const host = typeof record.host === 'string' ? record.host.trim() : '';
  if (host !== '' && !isSafeHost(host)) return { ok: false, message: '主机地址无效' };

  const user = typeof record.user === 'string' ? record.user.trim() : '';
  if (user !== '' && !isSafeUser(user)) return { ok: false, message: '用户名无效' };

  let port: number | null = null;
  if (record.port !== undefined && record.port !== null && record.port !== '') {
    const parsed = typeof record.port === 'number' ? record.port : Number(String(record.port).trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return { ok: false, message: '端口无效' };
    port = parsed;
  }

  const identityPath = typeof record.identityPath === 'string' ? record.identityPath.trim() : '';
  if (identityPath !== '' && !isSafeIdentityPath(identityPath)) {
    return { ok: false, message: '身份文件路径无效（需为不含空白的绝对路径）' };
  }

  return {
    ok: true,
    candidate: {
      alias: alias.alias,
      host: host || null,
      user: user || null,
      port,
      identityPath: identityPath || null,
    },
  };
}

/** The canonical user SSH config path (`~/.ssh/config`). */
export function resolveDefaultSshConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || homedir();
  return join(home, '.ssh', 'config');
}

/** Render the `Host` stanza for a candidate; each line is only emitted when set. */
export function renderSshStanza(candidate: SshHostCandidate): string {
  const lines = [`Host ${candidate.alias}`];
  if (candidate.host) lines.push(`    HostName ${candidate.host}`);
  if (candidate.user) lines.push(`    User ${candidate.user}`);
  if (candidate.port !== null) lines.push(`    Port ${candidate.port}`);
  if (candidate.identityPath) lines.push(`    IdentityFile ${candidate.identityPath}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Compose an ephemeral candidate config. The user's own config is `Include`d
 * first and the candidate stanza follows it, which mirrors exactly what Confirm
 * produces (a stanza appended to the end of the existing config, "first value
 * wins"): silent/Test validation therefore resolves the same values that the
 * saved configuration will. A missing user config contributes nothing.
 *
 * Exported so every `ssh -F` consumer (silent validation, Test, Confirm's probe,
 * bootstrap transfer and relay verification) composes the *same* ephemeral
 * config the append will later persist.
 */
export function buildCandidateConfigText(candidate: SshHostCandidate, userConfigPath: string): string {
  const text = renderSshStanza(candidate);
  if (!existsSync(userConfigPath)) return text;
  const quoted = /\s/.test(userConfigPath) ? `"${userConfigPath}"` : userConfigPath;
  return `Include ${quoted}\n${text}`;
}

/**
 * Run `use` with an ephemeral candidate config file in a private temp directory.
 * The file carries no secret (only alias/host/user/port/identity path), is mode
 * `0600`, and is always removed: validation never writes the user's config.
 */
export async function withCandidateConfig<T>(
  candidate: SshHostCandidate,
  userConfigPath: string,
  use: (configFile: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'wrenyard-remote-'));
  const configFile = join(directory, 'config');
  try {
    await writeFile(configFile, buildCandidateConfigText(candidate, userConfigPath), { mode: 0o600 });
    await chmod(configFile, 0o600);
    return await use(configFile);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The exact pre-append state of the user's SSH config, captured so a later step
 * of the same transaction (the daemon host-registry save) can undo the append
 * without touching a config that changed concurrently.
 */
export interface SshStanzaRollback {
  readonly path: string;
  /** Exact previous bytes; `null` when no config existed before the append. */
  readonly previous: string | null;
  /** The previous file mode, restored verbatim. */
  readonly mode: number;
  /**
   * The full content this append wrote. {@link restoreSshHostStanza} rewinds
   * only while the file still holds exactly these bytes, so a concurrent edit is
   * never overwritten.
   */
  readonly appended: string;
}

export type AppendSshStanzaResult =
  | { ok: true; path: string; rollback: SshStanzaRollback }
  | { ok: false; message: string };

export type RestoreSshStanzaResult = { ok: true } | { ok: false; message: string };

/**
 * Append one nonconflicting `Host` stanza as a transaction: the existing config
 * content and its file mode are preserved, and the write is atomic (temp file
 * in the same directory, then rename). An alias that already exists anywhere
 * reachable from the config is refused instead of being duplicated, and a
 * partially written file is never left behind.
 *
 * On success the exact previous bytes and mode are returned as a rollback, so
 * the caller can undo the append if the rest of the connection transaction
 * fails.
 */
export async function appendSshHostStanza(
  candidate: SshHostCandidate,
  options: { configPath?: string } = {},
): Promise<AppendSshStanzaResult> {
  const configPath = options.configPath ?? resolveDefaultSshConfigPath();
  let existing = '';
  let mode = 0o600;
  let existed = false;
  try {
    existing = readFileSync(configPath, 'utf8');
    mode = statSync(configPath).mode & 0o777;
    existed = true;
  } catch {
    // A missing or unreadable config is created fresh with owner-only mode.
  }
  // Refuse a conflicting alias rather than silently shadowing the user's host.
  if (readHostAliases(collectConfigFiles(configPath)).includes(candidate.alias)) {
    return { ok: false, message: `SSH 配置中已存在主机 ${candidate.alias}，未做修改` };
  }
  const stanza = renderSshStanza(candidate);
  const prefix = existing === '' ? '' : (existing.endsWith('\n') ? `${existing}\n` : `${existing}\n\n`);
  const next = `${prefix}${stanza}`;
  const directory = dirname(configPath);
  let temporary: string | null = null;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = join(directory, `.config.wrenyard-${randomUUID()}.tmp`);
    await writeFile(temporary, next, { mode });
    await chmod(temporary, mode);
    await rename(temporary, configPath);
    temporary = null;
    return {
      ok: true,
      path: configPath,
      rollback: { path: configPath, previous: existed ? existing : null, mode, appended: next },
    };
  } catch (error) {
    if (temporary !== null) await rm(temporary, { force: true }).catch(() => undefined);
    return { ok: false, message: `保存 SSH 配置失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Undo one {@link appendSshHostStanza}. Byte-exact and conflict-safe: the exact
 * previous bytes (or the absence of the file) are restored only while the config
 * still holds precisely what the append wrote. If anything else edited the file
 * in between, the rollback is refused rather than clobbering the concurrent
 * change, and the caller is told.
 */
export async function restoreSshHostStanza(rollback: SshStanzaRollback): Promise<RestoreSshStanzaResult> {
  let current: string;
  try {
    current = readFileSync(rollback.path, 'utf8');
  } catch {
    return { ok: false, message: 'SSH 配置已不可读，未回滚' };
  }
  if (current !== rollback.appended) {
    return { ok: false, message: 'SSH 配置已被外部修改，未回滚以保留并发编辑' };
  }
  if (rollback.previous === null) {
    try {
      await rm(rollback.path, { force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `回滚 SSH 配置失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const directory = dirname(rollback.path);
  let temporary: string | null = null;
  try {
    temporary = join(directory, `.config.wrenyard-${randomUUID()}.tmp`);
    await writeFile(temporary, rollback.previous, { mode: rollback.mode });
    await chmod(temporary, rollback.mode);
    await rename(temporary, rollback.path);
    temporary = null;
    return { ok: true };
  } catch (error) {
    if (temporary !== null) await rm(temporary, { force: true }).catch(() => undefined);
    return { ok: false, message: `回滚 SSH 配置失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

