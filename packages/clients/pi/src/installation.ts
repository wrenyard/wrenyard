import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';

export function inspectPi(options?: InspectOptions): Promise<ClientStatus> {
    return findExecutable(['pi'], options);
}
