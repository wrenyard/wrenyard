import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCodeBuddy } from '@wrenyard/providers/codebuddy';
import type { ForgeExecutionOptions } from '@wrenyard/execution';
export interface CodeBuddyQueryContext {
    readonly expectedScope: string;
    readonly expectedEnvironment: string;
}
/** Read the current account's observation directly; never publish its private scope. */
export async function readCodeBuddyObservation(context?: CodeBuddyQueryContext, options?: ForgeExecutionOptions): Promise<unknown> {
    const empty = { source: 'observed', fetched_at: new Date().toISOString(), data: null };
    if (!context?.expectedScope || !context.expectedEnvironment)
        return empty;
    const env = options?.env ?? process.env, home = env.HOME || env.USERPROFILE || homedir();
    const active = await createCodeBuddy({ env, home }).snapshot();
    if (!active || active.stableScope !== context.expectedScope || active.environment !== context.expectedEnvironment)
        return empty;
    const file = join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'wrenyard', 'runtime', 'codebuddy.json');
    try {
        if ((await stat(file)).size > 65536)
            return empty;
        const row = JSON.parse(await readFile(file, 'utf8'));
        const observed = Date.parse(row.observed_at), reset = Date.parse(row.resets_at);
        if (row.schema_version !== 2 || row.provider !== 'codebuddy' || row.scope !== active.stableScope || row.exhausted !== true || row.reason_code !== 'quota_exhausted' || !Number.isFinite(observed) || !Number.isFinite(reset) || reset <= observed || reset <= Date.now())
            return empty;
        return { ...empty, data: { exhausted: true, resets_at: row.resets_at, reason_code: row.reason_code } };
    }
    catch {
        return empty;
    }
}
export async function currentCodeBuddyContext(options?: ForgeExecutionOptions): Promise<CodeBuddyQueryContext | undefined> {
    const env = options?.env ?? process.env, home = env.HOME || env.USERPROFILE || homedir();
    try {
        const active = await createCodeBuddy({ env, home }).snapshot();
        return active?.stableScope ? { expectedScope: active.stableScope, expectedEnvironment: active.environment } : undefined;
    }
    catch {
        return undefined;
    }
}
