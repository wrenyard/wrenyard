import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { registerCoreHandlers, type DelegationAdmissionDescriptor } from '../../lib/server/handlers/core.mts'
import type { FwaHandlerService } from '../../lib/server/handlers/fwa.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'

describe('fwa.assign internal delegation context', () => {
  it('forwards the validated admission descriptor to the FWA service', async () => {
    const admissions: Array<DelegationAdmissionDescriptor | undefined> = []
    const fwaService: FwaHandlerService = {
      async assign(params, admission) {
        admissions.push(admission)
        return {
          session: {
            id: 'fwa_0123456789abcdef01234567',
            message_address: 'fwa-0123456789abcdef01234567',
            ticket_id: params.ticket_id,
            project_id: params.project_id,
            status: 'idle',
            queue_depth: 1,
            graph_refs: [],
            task_refs: [],
          },
        }
      },
      async list() { return { sessions: [] } },
      async status() { throw new Error('not used') },
      async transcript() { throw new Error('not used') },
    }
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      fwaService,
    })
    const admission: DelegationAdmissionDescriptor = {
      address: 'foreman-work',
      turn_seq: 4,
      delegation_id: 'del_fwa_context',
      tool_name: 'fwa_assign',
      input: { ticket_id: 'ticket-1' },
    }

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'fwa.assign',
      params: { ticket_id: 'ticket-1', project_id: 'app', prompt: 'Investigate' },
    }, { delegationAdmission: admission })

    assert.ok(response && 'result' in response)
    assert.deepEqual(admissions, [admission])
  })

  it('does not forward malformed external-looking context', async () => {
    const admissions: Array<DelegationAdmissionDescriptor | undefined> = []
    const fwaService: FwaHandlerService = {
      async assign(params, admission) {
        admissions.push(admission)
        return {
          session: {
            id: 'fwa_0123456789abcdef01234567',
            message_address: 'fwa-0123456789abcdef01234567',
            ticket_id: params.ticket_id,
            project_id: params.project_id,
            status: 'idle',
            queue_depth: 1,
            graph_refs: [],
            task_refs: [],
          },
        }
      },
      async list() { return { sessions: [] } },
      async status() { throw new Error('not used') },
      async transcript() { throw new Error('not used') },
    }
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      fwaService,
    })

    await router.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'fwa.assign',
      params: { ticket_id: 'ticket-1', project_id: 'app', prompt: 'Investigate' },
    }, { delegationAdmission: { address: 'foreman-work' } })

    assert.deepEqual(admissions, [undefined])
  })
})
