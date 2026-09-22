import type { Executor } from '@wrenyard/execution';
import { ClientError, observation, requestJson, type AccountOptions, type AccountSnapshot } from '@wrenyard/agent-client';
import { readCursorCredential } from './credentials.ts';
export async function readCursorAccount(execution: Executor, options?: AccountOptions): Promise<AccountSnapshot> {
    let accessToken: string;
    try {
        accessToken = await readCursorCredential(execution, options);
    }
    catch {
        throw new ClientError('authentication_required');
    }
    if (!accessToken)
        throw new ClientError('authentication_required');
    const data = await requestJson('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
        method: 'POST', body: '{}', headers: { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json', 'connect-protocol-version': '1' },
    }, options);
    return observation('cursor-dashboard', data);
}
