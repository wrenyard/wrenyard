import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
export function inspectCodex(options?: InspectOptions): Promise<ClientStatus> {
    return findExecutable(['codex'], options);
}
