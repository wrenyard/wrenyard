import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
export function inspectCursor(options?: InspectOptions): Promise<ClientStatus> {
    // The native CLI that `launchCursor` actually starts is `cursor-agent`;
    // the desktop `cursor` executable is a different product surface.
    return findExecutable(['cursor-agent'], options);
}
