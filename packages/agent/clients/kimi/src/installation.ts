import { findExecutable, withVersion, type ClientStatus, type InspectOptions } from '@wrenyard/agent';

export async function inspectKimi(options?: InspectOptions): Promise<ClientStatus> {
    return withVersion(await findExecutable(['kimi'], options), options);
}
