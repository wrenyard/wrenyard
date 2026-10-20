import { findExecutable, withVersion, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
export async function inspectCursor(options?: InspectOptions): Promise<ClientStatus> {
    // The native CLI that `launchCursor` actually starts is `cursor-agent`;
    // the desktop `cursor` executable is a different product surface.
    return withVersion(await findExecutable(['cursor-agent'], options), options);
}
