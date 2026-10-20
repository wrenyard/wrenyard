import { findExecutable, withVersion, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
export async function inspectOpenCode(options?: InspectOptions): Promise<ClientStatus> {
    return withVersion(await findExecutable(['opencode'], options), options);
}
