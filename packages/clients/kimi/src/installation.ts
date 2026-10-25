import { findExecutable, withVersion, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';

export async function inspectKimi(options?: InspectOptions): Promise<ClientStatus> {
    return withVersion(await findExecutable(['kimi'], options), options);
}
