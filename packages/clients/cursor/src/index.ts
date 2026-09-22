import { ForgeAgentClient, ClientError, requestJson, observation, type AccountRequest, type ClientOptions } from '@wrenyard/agent-client';
import { clientOperation } from '@wrenyard/execution';
export class CursorClient extends ForgeAgentClient {
    readonly id = 'cursor';
    readonly capabilities = { run: true, account: true };
    async readAccount(_request?: AccountRequest, options?: ClientOptions): Promise<unknown> {
        const credential = await clientOperation(this.execution, 'credential', { store: 'cursor' }, options) as {
            accessToken?: string;
        };
        if (!credential?.accessToken)
            throw new ClientError('authentication_required');
        const data = await requestJson('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
            method: 'POST', body: '{}', headers: { authorization: 'Bearer ' + credential.accessToken, 'content-type': 'application/json', 'connect-protocol-version': '1' },
        }, options);
        return observation('cursor-dashboard', data);
    }
}
