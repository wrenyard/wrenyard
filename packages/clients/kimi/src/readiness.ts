import type { NativeClientReadiness, ReadinessOptions } from '@wrenyard/agent-client';
import { readManagedKimiCodingKey } from './credential.ts';

/**
 * Kimi Code needs no `kimi login`: authentication reuses the Wrenyard-managed
 * Kimi Coding credential, so readiness observes exactly that store. A missing
 * managed key is missing, not unknown — the launch would fail for the same
 * reason.
 */
export async function readKimiReadiness(options?: ReadinessOptions): Promise<NativeClientReadiness> {
    const key = await readManagedKimiCodingKey(options?.env ?? process.env, options?.home);
    return { authentication: key !== undefined ? 'ready' : 'missing' };
}
