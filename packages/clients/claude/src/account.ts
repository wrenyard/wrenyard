import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from '@wrenyard/execution';
import { ClientError, observation, requestJson, type AccountOptions, type AccountSnapshot } from '@wrenyard/agent-client';
import { readClaudeCredential } from './credentials.ts';
export async function readClaudeAccount(execution: Executor, request: AccountOptions | undefined, options?: AccountOptions): Promise<AccountSnapshot> {
    const env = options?.env ?? process.env;
    if (!request?.refresh && env.WRENYARD_QUOTA_CODEXBAR === '1') {
        const file = join(env.HOME || env.USERPROFILE || homedir(), 'Library', 'Group Containers', 'Y5PE65HELJ.com.steipete.codexbar', 'widget-snapshot.json');
        try {
            const info = await stat(file);
            if (info.size <= 1024 * 1024 && Date.now() - info.mtimeMs <= 15 * 60000)
                return observation('claude-sources', { snapshot: JSON.parse(await readFile(file, 'utf8')), snapshot_at: info.mtime.toISOString() });
        }
        catch { /* Optional snapshot; use OAuth. */ }
    }
    const credential = await readClaudeCredential(execution, options);
    if (!credential.accessToken)
        throw new ClientError('authentication_required');
    const data = await requestJson('https://api.anthropic.com/api/oauth/usage', { headers: {
            authorization: 'Bearer ' + credential.accessToken, accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01',
        } }, options);
    return observation('oauth-api', data);
}
