import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
export function inspectClaude(options?: InspectOptions): Promise<ClientStatus> {
    return findExecutable(['claude'], options);
}
