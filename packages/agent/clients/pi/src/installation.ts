import { findExecutable, withVersion, type ClientStatus, type InspectOptions } from '@wrenyard/agent';

export async function inspectPi(options?: InspectOptions): Promise<ClientStatus> {
    return withVersion(await findExecutable(['pi'], options), options);
}
