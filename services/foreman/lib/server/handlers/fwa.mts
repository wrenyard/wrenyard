/**
 * FWA handler registrations for the core RPC router.
 */

import { ProtocolError, INVALID_PARAMS } from '../../protocol/errors.mts'
import type { RpcRouter } from '../rpc-router.mts'
import type { FwaAssignParams, FwaStatusParams, FwaTranscriptParams, FwaAssignResult, FwaListResult, FwaStatusResult, FwaTranscriptResult } from '../../protocol/methods/fwa.mts'
import type { DelegationAdmissionDescriptor } from './core.mts'

export const FWA_NOT_CONFIGURED = 'FWA_NOT_CONFIGURED'

export interface FwaHandlerService {
  assign(params: FwaAssignParams, delegationAdmission?: DelegationAdmissionDescriptor): Promise<FwaAssignResult>
  list(): Promise<FwaListResult>
  status(sessionId: string): Promise<FwaStatusResult>
  transcript(sessionId: string): Promise<FwaTranscriptResult>
}

export function registerFwaHandlers(
  router: RpcRouter,
  fwaService: FwaHandlerService | undefined,
  delegationAdmissionFromContext: (context: unknown) => DelegationAdmissionDescriptor | undefined = () => undefined,
): void {
  if (!fwaService) {
    // No FWA service configured — register methods that return a clear error
    const notNative = () => { throw new ProtocolError(
      { code: INVALID_PARAMS.code, message: FWA_NOT_CONFIGURED },
      { service: 'fwa', code: 'not_configured' },
    )}
    router.register('fwa.assign', notNative)
    router.register('fwa.list', notNative)
    router.register('fwa.status', notNative)
    router.register('fwa.transcript', notNative)
    return
  }

  router.register('fwa.assign', async (params: FwaAssignParams, _message, context) => {
    try {
      return await fwaService.assign(params, delegationAdmissionFromContext(context))
    } catch (error) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: error instanceof Error ? error.message : String(error) },
        { service: 'fwa', code: 'simulate_assign_failed' },
      )
    }
  })

  router.register('fwa.list', async () => {
    return await fwaService.list()
  })

  router.register('fwa.status', async (params: FwaStatusParams) => {
    try {
      return await fwaService.status(params.session_id)
    } catch (error) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: error instanceof Error ? error.message : String(error) },
        { service: 'fwa', code: 'status_failed' },
      )
    }
  })

  router.register('fwa.transcript', async (params: FwaTranscriptParams) => {
    try {
      return await fwaService.transcript(params.session_id)
    } catch (error) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: error instanceof Error ? error.message : String(error) },
        { service: 'fwa', code: 'transcript_failed' },
      )
    }
  })

}
