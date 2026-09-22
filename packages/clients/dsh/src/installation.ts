import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
import { isAbsolute } from 'node:path';

/** Native DSH executable name on PATH. */
const DSH_EXECUTABLE = 'dsh';

/** Compatibility override that pins an absolute native DSH binary. */
const DSH_BIN_ENV = 'WRENYARD_DSH_BIN';

/**
 * Inspect the native `@deepseek-ai/dsh` installation. Discovery prefers an
 * explicit absolute `executable`, then the `WRENYARD_DSH_BIN` compatibility
 * override, then PATH — the same order the launch uses. The override is read
 * from the supplied environment, falling back to the process environment, so an
 * inspect and a launch given the same options agree. A configured value that is
 * not absolute is passed through unchanged so `findExecutable` reports it
 * unambiguously instead of resolving a same-named PATH entry.
 */
export function inspectDsh(options?: InspectOptions): Promise<ClientStatus> {
    const env = options?.env ?? process.env;
    const configured = options?.executable?.trim() || env[DSH_BIN_ENV]?.trim();
    if (!configured)
        return findExecutable([DSH_EXECUTABLE], options);
    if (isAbsolute(configured))
        return findExecutable([DSH_EXECUTABLE], { ...options, env, executable: configured });
    return Promise.resolve({ installation: { state: 'unknown', reason: 'configured executable is not absolute' }, authentication: 'unknown' });
}
