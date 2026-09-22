import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
export function inspectOpenCode(options?: InspectOptions): Promise<ClientStatus> {
    return findExecutable(['opencode'], options);
}
