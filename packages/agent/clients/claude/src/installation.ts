import { findExecutable, withVersion, type ClientStatus, type InspectOptions } from '@wrenyard/agent';
export async function inspectClaude(options?: InspectOptions): Promise<ClientStatus> {
    return withVersion(await findExecutable(['claude'], options), options);
}
