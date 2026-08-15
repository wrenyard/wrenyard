import { randomBytes } from 'node:crypto'

import { ProjectManager } from '../../core/project/manager.mts'
import { createPmTicketCommands, PmError, type PmTicketCommands } from '../../core/pm/index.mts'
import { getDb } from '../../db/connection.mts'
import { PmTicketStore } from '../../db/stores/pm-ticket-store.mts'

export function createPmTicketCommandsForWorkspace(workspaceRoot: string): PmTicketCommands {
  const projectManager = new ProjectManager({ workspaceRoot })
  const ticketStore = new PmTicketStore(getDb())

  return createPmTicketCommands({
    tickets: ticketStore,
    projects: {
      ensureProject(projectId: string): void {
        try {
          projectManager.getProject(projectId)
        } catch {
          throw new PmError('project_not_found', `Project '${projectId}' not found`)
        }
      },
    },
    clock: { now: () => new Date().toISOString() },
    ids: { nextTicketId: () => `pm_${randomBytes(8).toString('hex')}` },
    transactions: {
      run<T>(fn: () => T): T {
        return getDb().transaction(() => fn())()
      },
    },
  })
}
