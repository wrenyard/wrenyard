import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models';
import { resolveWrenyardClientStateDir, resolveWrenyardStateRoot } from '@wrenyard/paths';
import type { AgentEvent, AgentRequest, StreamChunk } from './index.ts';

export function messageEvent(text: string, role = 'assistant'): AgentEvent {
    return { type: 'output', record: { type: 'message', role, text } };
}

export function finishedEvent(
    family: string,
    sessionId: string | undefined,
    output: string,
    failed = false,
    error?: Record<string, unknown>,
): AgentEvent {
    return {
        type: 'output',
        record: {
            type: 'run_finished',
            status: failed ? 'failed' : 'done',
            client_family: family,
            ...(sessionId ? { native_session_id: sessionId } : {}),
            ...(output ? { output } : {}),
            is_error: failed,
            ...(error !== undefined ? { error } : {}),
        },
    };
}

/**
 * Byte ceiling for a single unterminated stdout line. It matches the execution
 * layer's MAX_FRAME_BYTES so a line that survives transport cannot be rejected
 * here; the larger newline-free payload is dropped instead of buffered without
 * bound. Credit returns to the budget whenever the drain loop retires a line.
 */
const MAX_NATIVE_LINE_BYTES = 1024 * 1024;

export async function* readNativeRecords(events: AsyncIterable<StreamChunk>): AsyncGenerator<{ kind: 'record'; record: Record<string, unknown> } | { kind: 'event'; event: AgentEvent }> {
    // stdout is newline-delimited JSON, stderr is free-form text. One shared
    // decoder would interleave their byte streams and corrupt UTF-8, so each
    // stream owns an independent decoder and is flushed on its own exit path.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    let stdoutBytes = 0;
    let stdoutOverflow = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    const dropOverflow = (): AgentEvent => {
        stdoutBuffer = '';
        stdoutBytes = 0;
        stdoutOverflow = false;
        return { type: 'error', message: 'agent output line exceeded buffer limit' };
    };
    for await (const event of events) {
        if (event.type === 'stdout' && event.data) {
            const bytes = Buffer.from(event.data);
            stdoutBytes += bytes.byteLength;
            if (stdoutOverflow) {
                stdoutBytes = 0;
                continue;
            }
            stdoutBuffer += stdoutDecoder.write(bytes);
            let newline = stdoutBuffer.indexOf('\n');
            while (newline !== -1) {
                const line = stdoutBuffer.slice(0, newline).trim();
                stdoutBuffer = stdoutBuffer.slice(newline + 1);
                stdoutBytes = Buffer.byteLength(stdoutBuffer, 'utf8');
                if (line)
                    yield* parseLine(line);
                newline = stdoutBuffer.indexOf('\n');
            }
            if (stdoutBytes > MAX_NATIVE_LINE_BYTES) {
                stdoutOverflow = true;
                yield { kind: 'event', event: dropOverflow() };
            }
            continue;
        }
        if (event.type === 'stderr' && event.data) {
            // stderr shares no state with stdout framing, but it is still flushed
            // once when the process ends so a trailing partial line is delivered.
            yield { kind: 'event', event: { type: 'stderr', text: stderrDecoder.write(Buffer.from(event.data)) } };
            continue;
        }
        if (event.type === 'error') {
            const flushed = stdoutOverflow ? '' : stdoutDecoder.end();
            if (flushed.trim())
                yield* parseLine(flushed.trim());
            stdoutBuffer = '';
            stdoutBytes = 0;
            stdoutOverflow = false;
            yield { kind: 'event', event: { type: 'error', message: event.message ?? 'agent execution failed' } };
            continue;
        }
        if (event.type === 'exit') {
            if (!stdoutEnded) {
                stdoutEnded = true;
                const tail = stdoutOverflow ? '' : (stdoutBuffer + stdoutDecoder.end()).trim();
                if (tail)
                    yield* parseLine(tail);
            }
            if (!stderrEnded) {
                stderrEnded = true;
                if (!stdoutOverflow) {
                    const text = stderrDecoder.end();
                    if (text)
                        yield { kind: 'event', event: { type: 'stderr', text } };
                }
            }
            yield { kind: 'event', event: { type: 'exit', exitCode: event.exitCode ?? null, signal: event.signal ?? null } };
        }
    }
}

function* parseLine(line: string): Generator<{ kind: 'record'; record: Record<string, unknown> }> {
    try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value))
            yield { kind: 'record', record: value as Record<string, unknown> };
    }
    catch { /* native clients may print non-json logs */ }
}


export function textOf(record: Record<string, unknown>): string {
    if (typeof record.text === 'string')
        return record.text;
    const message = record.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content.map((block) => {
                if (!block || typeof block !== 'object')
                    return '';
                const item = block as Record<string, unknown>;
                return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
            }).join('');
        }
    }
    if (typeof record.result === 'string')
        return record.result;
    return '';
}

/** Byte ceiling for a tool call's bounded input summary. */
export const INPUT_SUMMARY_MAX_BYTES = 512;

/** Byte ceiling for a tool result's bounded output tail. */
export const OUTPUT_TAIL_MAX_BYTES = 2 * 1024;

/** Reads one non-empty string field, mirroring the driver's getString. */
export function stringOf(record: Record<string, unknown> | undefined, key: string): string {
    const value = record?.[key];
    return typeof value === 'string' && value !== '' ? value : '';
}

/** Reads one nested object field, when it is a plain object rather than an array. */
export function recordOf(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
    const value = record?.[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Serializes an arbitrary JSON value the way the retired driver's
 * jsonStringValue did: strings verbatim, everything else as compact JSON, and
 * undefined/null as the empty string (never the literal "null").
 */
export function jsonStringValue(value: unknown): string {
    if (value === undefined || value === null)
        return '';
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return '';
    }
}

/** Keeps the leading bytes of a summary, never splitting a UTF-8 rune. */
export function truncateHead(text: string, maxBytes = INPUT_SUMMARY_MAX_BYTES): string {
    if (maxBytes <= 0 || Buffer.byteLength(text, 'utf8') <= maxBytes)
        return text;
    let end = Math.min(maxBytes, text.length);
    // A lone surrogate sits at the end of the slice when the cut split it.
    while (end > 0) {
        const slice = text.slice(0, end);
        if (!/[\uD800-\uDBFF]$/u.test(slice))
            return slice;
        end--;
    }
    return '';
}

/** Keeps the trailing bytes of an output tail, never splitting a UTF-8 rune. */
export function truncateTail(text: string, maxBytes = OUTPUT_TAIL_MAX_BYTES): string {
    if (maxBytes <= 0 || Buffer.byteLength(text, 'utf8') <= maxBytes)
        return text;
    // Walk backward accumulating byte width until the tail fits, then step
    // past any lead surrogate the cut would strand.
    const encoder = Buffer.from(text, 'utf8');
    let start = 0;
    for (let cut = text.length - 1; cut >= 0; cut--) {
        const width = Buffer.byteLength(text[cut]!, 'utf8');
        if (encoder.length - width <= maxBytes)
            break;
        start = cut;
    }
    // A low surrogate at the front of the tail means the cut split a pair.
    while (start < text.length && /^[\uDC00-\uDFFF]/u.test(text.slice(start)))
        start++;
    return text.slice(start);
}

/** A normalized tool invocation record. */
export function toolCallRecord(name: string, callId: string, inputSummary: string, nativeSessionId?: string): Record<string, unknown> {
    return {
        type: 'tool_call',
        name,
        input_summary: truncateHead(inputSummary),
        call_id: callId,
        ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
    };
}

/** A normalized tool result record; the status is always ok or error. */
export function toolResultRecord(callId: string, status: 'ok' | 'error', outputTail: string, nativeSessionId?: string): Record<string, unknown> {
    return {
        type: 'tool_result',
        call_id: callId,
        status,
        output_tail: truncateTail(outputTail),
        ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
    };
}

/** A normalized assistant message record. */
export function messageRecord(text: string, role = 'assistant'): Record<string, unknown> {
    return { type: 'message', role, text };
}

/** A normalized reasoning record. */
export function reasoningRecord(text: string): Record<string, unknown> {
    return { type: 'reasoning', text };
}

/** A normalized token-accounting record. */
export function turnUsageRecord(data: Record<string, unknown>): Record<string, unknown> {
    return { type: 'turn_usage', ...data };
}

/** A normalized terminal record for one client family. */
export function runFinishedRecord(family: string, status: 'done' | 'failed', sessionId?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'run_finished',
        status,
        client_family: family,
        ...(sessionId ? { native_session_id: sessionId } : {}),
        ...extra,
    };
}

/** A normalized failure event, carrying only the failure fields execution consumes. */
export function failureRecord(record: Record<string, unknown>, fallbackMessage: string, sessionId?: string): Record<string, unknown> {
    const data: Record<string, unknown> = { type: 'run_finished', status: 'failed' };
    for (const key of ['failure_class', 'recovery_at', 'retry_after_seconds']) {
        if (record[key] !== undefined)
            data[key] = record[key];
    }
    const session = sessionId ?? sessionIdOf(record);
    if (session)
        data.native_session_id = session;
    const failure = recordOf(record, 'failure');
    if (failure) {
        data.error = errorValue(failure, fallbackMessage);
        if (data.failure_class === undefined) {
            const failureClass = stringOf(failure, 'failure_class') || stringOf(failure, 'class');
            if (failureClass)
                data.failure_class = failureClass;
        }
    }
    else {
        for (const key of ['error', 'message', 'result', 'detail']) {
            if (record[key] !== undefined) {
                const value = errorValue(record[key], '');
                if (value !== '' && value !== undefined) {
                    data.error = value;
                    break;
                }
            }
        }
        if (data.error === undefined)
            data.error = fallbackMessage;
    }
    return data;
}

/** Normalizes an error payload to a string or a bounded field object. */
export function errorValue(value: unknown, fallback: string): unknown {
    if (typeof value === 'string')
        return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of ['message', 'error', 'detail', 'code', 'type', 'recovery_at', 'retry_after_seconds', 'failure_class', 'class']) {
            if (source[key] !== undefined)
                out[key] = source[key];
        }
        return Object.keys(out).length > 0 ? out : fallback;
    }
    const text = jsonStringValue(value);
    return text === '' ? fallback : text;
}

/** FNV-1a 64-bit over a UTF-8 string, as a lowercase hex string. */
export function fnv1a64Hex(...parts: string[]): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (const part of parts) {
        for (const byte of Buffer.from(part, 'utf8')) {
            hash = (hash ^ BigInt(byte)) & mask;
            hash = (hash * prime) & mask;
        }
    }
    return hash.toString(16);
}

/** Private per-client state dir rooted under the shared WRENYARD state home. */
export function clientStateDir(...parts: string[]): string {
    return resolveWrenyardClientStateDir(process.env, ...parts);
}

/** Same as {@link clientStateDir}, but resolves against a launch-supplied environment. */
export function clientStateDirForEnv(env: NodeJS.ProcessEnv, ...parts: string[]): string {
    return resolveWrenyardClientStateDir(env, ...parts);
}

/** Metadata contract for a small per-invocation client home owned by Wrenyard. */
export interface OwnedClientRunHome {
    readonly path: string;
    readonly metadataPath: string;
    readonly clientFamily: 'opencode' | 'codebuddy' | 'pi' | 'grok';
    readonly runId: string;
    /**
     * Called before settle cleanup deletes the run home. A rejection aborts
     * deletion: the run home and its `active` marker are left in place.
     */
    preserveSession?: (homePath: string, context?: { readonly success: boolean }) => Promise<void>;
}

/** Launch provenance phase recorded on an owned run marker. */
export type OwnedRunLaunchPhase = 'prepared' | 'spawning' | 'running';

/**
 * Shared contract for the `.wrenyard-run.json` ownership marker.
 *
 * `prepared` is written at creation, before any child process exists, so it
 * means definitively "no spawn". `spawning` is written immediately before the
 * spawn and `running` immediately after it, carrying the child identity. A
 * marker left in `spawning`, or one whose child identity is missing, is an
 * ambiguous crash window: a consumer may only reclaim it as
 * protected/uncertain, never as a run that had no child.
 */
export interface OwnedRunMarker {
    readonly version: 1;
    readonly client_family: 'opencode' | 'codebuddy' | 'pi' | 'grok';
    readonly run_id: string;
    readonly state: 'active' | 'done' | 'failed';
    readonly created_at: string;
    readonly finished_at?: string;
    readonly owner_pid?: number;
    readonly launch_phase?: OwnedRunLaunchPhase;
    readonly child_pid?: number;
    readonly child_pgid?: number;
}

const OWNED_RUN_LAUNCH_PHASES: readonly OwnedRunLaunchPhase[] = ['prepared', 'spawning', 'running'];

function isProcessId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate an already-parsed ownership marker, so a daemon-side recovery
 * consumer shares one contract with the writer instead of re-deriving it.
 *
 * Markers written before process provenance existed lack `owner_pid` and
 * `launch_phase` and remain valid, so a missing identity is unproven rather
 * than proof that no process is running.
 */
export function parseOwnedRunMarker(value: unknown): OwnedRunMarker | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const marker = value as Record<string, unknown>;
    if (marker.version !== 1)
        return undefined;
    if (marker.client_family !== 'opencode' && marker.client_family !== 'codebuddy' && marker.client_family !== 'pi' && marker.client_family !== 'grok')
        return undefined;
    if (typeof marker.run_id !== 'string' || !marker.run_id)
        return undefined;
    if (marker.state !== 'active' && marker.state !== 'done' && marker.state !== 'failed')
        return undefined;
    if (typeof marker.created_at !== 'string' || !Number.isFinite(Date.parse(marker.created_at)))
        return undefined;
    if (marker.finished_at !== undefined && (typeof marker.finished_at !== 'string' || !Number.isFinite(Date.parse(marker.finished_at))))
        return undefined;
    for (const key of ['owner_pid', 'child_pid', 'child_pgid'] as const) {
        if (marker[key] !== undefined && !isProcessId(marker[key]))
            return undefined;
    }
    if (marker.launch_phase !== undefined && !OWNED_RUN_LAUNCH_PHASES.includes(marker.launch_phase as OwnedRunLaunchPhase))
        return undefined;
    return marker as unknown as OwnedRunMarker;
}

/**
 * Resolve the canonical trusted state root. The macOS `/var` -> `/private/var`
 * alias is tolerated only for this trusted root ancestry; every entry below it
 * is validated separately and may never be a symlink.
 */
async function canonicalStateRoot(env: NodeJS.ProcessEnv): Promise<string> {
    return await realpath(resolveWrenyardStateRoot(env));
}

/**
 * Reject any symlinked or non-directory entry between the canonical trusted
 * state root and `target`, so the `/var` alias cannot be used below the root to
 * escape containment.
 */
async function assertNoSymlinkBelowRoot(root: string, target: string): Promise<void> {
    const remainder = relative(root, target);
    if (!remainder || remainder.startsWith(`..${sep}`) || remainder === '..' || isAbsolute(remainder))
        throw new Error('Owned client run home failed path validation');
    let current = root;
    for (const segment of remainder.split(sep)) {
        current = join(current, segment);
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error('Owned client run home failed path validation');
    }
}

/** Create a unique run home and its secret-free ownership marker. */
export async function createOwnedClientRunHome(env: NodeJS.ProcessEnv, clientFamily: OwnedClientRunHome['clientFamily']): Promise<OwnedClientRunHome> {
    const runId = randomUUID();
    const stateRoot = resolveWrenyardStateRoot(env);
    await mkdir(stateRoot, { recursive: true });
    const root = await canonicalStateRoot(env);
    const runsPath = join(root, 'clients', clientFamily, 'runs');
    await mkdir(runsPath, { recursive: true });
    await assertNoSymlinkBelowRoot(root, runsPath);
    const path = join(runsPath, runId);
    await mkdir(path);
    const metadataPath = join(path, '.wrenyard-run.json');
    const marker = JSON.stringify({ version: 1, client_family: clientFamily, run_id: runId, state: 'active', created_at: new Date().toISOString(), owner_pid: process.pid, launch_phase: 'prepared' }) + '\n';
    await writeOwnedRunMarker(env, { path, metadataPath, clientFamily, runId }, marker, true);
    return { path, metadataPath, clientFamily, runId };
}

/**
 * Copy a validated owned run home into `clients/<family>/sessions/<sessionId>/`
 * beside `runs/`, replacing any prior snapshot for that session id.
 */
export async function preserveClientRunHomeSessionSnapshot(
    env: NodeJS.ProcessEnv,
    home: OwnedClientRunHome,
    homePath: string,
    sessionId: string,
): Promise<void> {
    if (homePath !== home.path) return;
    if (!sessionId || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('\0')) return;
    const expected = resolve(home.path);
    if (relative(expected, resolve(home.metadataPath)) !== '.wrenyard-run.json') return;
    const parent = dirname(expected);
    const grandparent = dirname(parent);
    if (basename(parent) !== 'runs') return;
    for (const directory of [grandparent, parent, expected]) {
        const stat = await lstat(directory).catch(() => undefined);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    }
    const markerStat = await lstat(home.metadataPath).catch(() => undefined);
    if (!markerStat?.isFile() || markerStat.isSymbolicLink()) return;
    let marker: Record<string, unknown>;
    try { marker = JSON.parse(await readFile(home.metadataPath, 'utf8')) as Record<string, unknown>; } catch { return; }
    if (marker.version !== 1 || marker.client_family !== home.clientFamily || marker.run_id !== home.runId || marker.state !== 'active') return;
    const sessionsDir = clientStateDirForEnv(env, home.clientFamily, 'sessions');
    const resolvedTarget = resolve(join(sessionsDir, sessionId));
    const relFromRuns = relative(parent, resolvedTarget);
    if (!relFromRuns || relFromRuns === '.' || !relFromRuns.startsWith(`..${sep}`)) return;
    if (relFromRuns.split(sep).some((segment) => segment === 'runs')) return;
    await rm(resolvedTarget, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(sessionsDir, { recursive: true });
    await cp(expected, resolvedTarget, { recursive: true, verbatimSymlinks: true });
}

async function validateOwnedRunHome(env: NodeJS.ProcessEnv, home: OwnedClientRunHome): Promise<void> {
    const root = await canonicalStateRoot(env);
    const runsPath = join(root, 'clients', home.clientFamily, 'runs');
    const expected = join(runsPath, home.runId);
    if (home.path !== expected || home.metadataPath !== join(expected, '.wrenyard-run.json'))
        throw new Error('Owned client run home path mismatch');
    await assertNoSymlinkBelowRoot(root, runsPath);
    const directory = await lstat(expected);
    const withinRoot = relative(runsPath, expected);
    if (directory.isSymbolicLink() || !directory.isDirectory() || !withinRoot || withinRoot.startsWith(`..${sep}`) || withinRoot === '..' || isAbsolute(withinRoot))
        throw new Error('Owned client run home failed path validation');
    try {
        const marker = await lstat(home.metadataPath);
        if (marker.isSymbolicLink() || !marker.isFile())
            throw new Error('Owned client run marker failed type validation');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

async function writeOwnedRunMarker(env: NodeJS.ProcessEnv, home: OwnedClientRunHome, contents: string, exclusive = false): Promise<void> {
    await validateOwnedRunHome(env, home);
    const handle = await open(home.metadataPath, exclusive ? 'wx' : 'w', 0o600);
    try { await handle.writeFile(contents); }
    finally { await handle.close(); }
}

/** True when `value` is one of the shared public reasoning-effort levels. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Reject a launch that is not fully resolved. Every run names an exact public
 * reasoning level — there is no omit-to-send path — and the value must be one
 * of the shared {@link REASONING_EFFORTS} levels, so a runtime can never
 * silently drop effort.
 */
export function assertLaunch(request: AgentRequest): void {
    if (!isAbsolute(request.cwd))
        throw new Error('Agent directory must be absolute');
    if (!request.model.trim())
        throw new Error('A resolved model is required');
    if (!isReasoningEffort(request.reasoningEffort))
        throw new Error('A valid reasoning effort is required');
}

export function stringEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string')
            record[key] = value;
    }
    return { ...record, ...extra };
}

export function sessionIdOf(record: Record<string, unknown>): string | undefined {
    for (const key of ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
