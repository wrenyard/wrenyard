import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initTestDb, closeTestDb } from '../tests/helpers/test-db.mts'
import { PmTicketStore } from '../lib/db/stores/pm-ticket-store.mts'
import { createPmTicketCommands } from '../lib/core/pm/index.mts'
import { PmError } from '../lib/core/pm/index.mts'
import type { ForemanDatabase } from '../lib/db/types.mts'

describe('PM ticket commands', () => {
  let db: ForemanDatabase
  let ticketStore: PmTicketStore
  let commands: ReturnType<typeof createPmTicketCommands>
  let nowIndex = 0
  let idIndex = 0

  function setup(validProjects = ['foreman']) {
    db = initTestDb()
    ticketStore = new PmTicketStore(db)
    nowIndex = 0
    idIndex = 0
    commands = createPmTicketCommands({
      tickets: ticketStore,
      projects: {
        ensureProject(projectId: string) {
          if (!validProjects.includes(projectId)) {
            throw new PmError('project_not_found', `Project '${projectId}' not found`)
          }
        },
      },
      clock: { now: () => {
        nowIndex += 1
        return `2024-01-01T00:00:00.${String(nowIndex).padStart(3, '0')}Z`
      }},
      ids: { nextTicketId: () => {
        idIndex += 1
        return `pm_id_${idIndex}`
      }},
      transactions: {
        run<T>(fn: () => T): T {
          return db.transaction(() => fn())()
        },
      },
    })
  }

  it('creates a main ticket', async () => {
    setup()
    const ticket = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Fix login bug',
      description: 'Users cannot log in',
      assignee: { session_id: 'sess_abc' },
    })
    assert.equal(ticket.kind, 'main')
    assert.equal(ticket.project_id, 'foreman')
    assert.equal(ticket.title, 'Fix login bug')
    assert.equal(ticket.description, 'Users cannot log in')
    assert.equal(ticket.status, 'todo')
    assert.deepEqual(ticket.assignee, { session_id: 'sess_abc' })
    assert.equal(ticket.parent_id, undefined)
  })

  it('creates a sub ticket', async () => {
    setup()
    const parent = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Parent',
    })
    const child = await commands.create({
      kind: 'sub',
      project_id: 'foreman',
      title: 'Child',
      parent_id: parent.id,
    })
    assert.equal(child.kind, 'sub')
    assert.equal(child.parent_id, parent.id)
  })

  it('throws parent_ticket_not_found for missing parent', async () => {
    setup()
    await assert.rejects(
      () => commands.create({
        kind: 'sub',
        project_id: 'foreman',
        title: 'Child',
        parent_id: 'nonexistent',
      }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'parent_ticket_not_found')
        return true
      },
    )
  })

  it('throws parent_must_be_main when parent is not main', async () => {
    setup()
    const parent = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Parent',
    })
    const child = await commands.create({
      kind: 'sub',
      project_id: 'foreman',
      title: 'Child',
      parent_id: parent.id,
    })
    // Now try to create a sub under a sub
    await assert.rejects(
      () => commands.create({
        kind: 'sub',
        project_id: 'foreman',
        title: 'Grandchild',
        parent_id: child.id,
      }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'parent_must_be_main')
        return true
      },
    )
  })

  it('throws project_mismatch when parent is in different project', async () => {
    setup(['foreman', 'other'])
    // Create parent in foreman project
    const parent = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Parent',
    })
    await assert.rejects(
      () => commands.create({
        kind: 'sub',
        project_id: 'other',
        title: 'Child',
        parent_id: parent.id,
      }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'project_mismatch')
        return true
      },
    )
  })

  it('rejects assignee on sub tickets', async () => {
    setup()
    const parent = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Parent',
    })
    await assert.rejects(
      () => commands.create({
        kind: 'sub',
        project_id: 'foreman',
        title: 'Child',
        parent_id: parent.id,
        assignee: { session_id: 'sess_xyz' },
      }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'invalid_field_for_kind')
        return true
      },
    )
  })

  it('edit updates only title/description/assignee', async () => {
    setup()
    const ticket = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Original',
    })
    const updated = await commands.update({
      action: 'edit',
      id: ticket.id,
      title: 'Updated',
      description: 'New description',
    })
    assert.equal(updated.title, 'Updated')
    assert.equal(updated.description, 'New description')
  })

  it('edit with description null clears it', async () => {
    setup()
    const ticket = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Original',
      description: 'Some desc',
    })
    const updated = await commands.update({
      action: 'edit',
      id: ticket.id,
      description: null,
    })
    assert.equal(updated.description, undefined)
  })

  it('rejects invalid patch with no fields', async () => {
    setup()
    const ticket = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Test',
    })
    await assert.rejects(
      () => commands.update({
        action: 'edit',
        id: ticket.id,
      }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'invalid_patch')
        return true
      },
    )
  })

  it('blocks main done when it has open sub-tickets', async () => {
    setup()
    const parent = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Parent',
    })
    await commands.create({
      kind: 'sub',
      project_id: 'foreman',
      title: 'Child',
      parent_id: parent.id,
    })
    await commands.update({
      action: 'set_status',
      id: parent.id,
      status: 'in_progress',
    })
    await assert.rejects(
      () => commands.update({
        action: 'set_status',
        id: parent.id,
        status: 'done',
      }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'main_has_open_subtickets')
        return true
      },
    )
  })

  it('allows main done after sub is done', async () => {
    setup()
    const parent = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Parent',
    })
    const child = await commands.create({
      kind: 'sub',
      project_id: 'foreman',
      title: 'Child',
      parent_id: parent.id,
    })
    await commands.update({
      action: 'set_status',
      id: child.id,
      status: 'in_progress',
    })
    await commands.update({
      action: 'set_status',
      id: child.id,
      status: 'done',
    })
    await commands.update({
      action: 'set_status',
      id: parent.id,
      status: 'in_progress',
    })
    const updated = await commands.update({
      action: 'set_status',
      id: parent.id,
      status: 'done',
    })
    assert.equal(updated.status, 'done')
  })

  it('blocks delete of main with children', async () => {
    setup()
    const parent = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Parent',
    })
    await commands.create({
      kind: 'sub',
      project_id: 'foreman',
      title: 'Child',
      parent_id: parent.id,
    })
    await assert.rejects(
      () => commands.delete({ id: parent.id }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'main_has_subtickets')
        return true
      },
    )
  })

  it('allows delete of sub ticket', async () => {
    setup()
    const parent = await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Parent',
    })
    const child = await commands.create({
      kind: 'sub',
      project_id: 'foreman',
      title: 'Child',
      parent_id: parent.id,
    })
    const result = await commands.delete({ id: child.id })
    assert.equal(result.deleted, true)
    assert.equal(result.id, child.id)

    // Verify ticket is gone
    await assert.rejects(
      () => commands.get({ id: child.id }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'ticket_not_found')
        return true
      },
    )
  })

  it('throws ticket_not_found for missing ticket', async () => {
    setup()
    await assert.rejects(
      () => commands.get({ id: 'nonexistent' }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'ticket_not_found')
        return true
      },
    )
  })

  it('lists tickets with project_id filter', async () => {
    setup()
    await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Ticket 1',
    })
    await commands.create({
      kind: 'main',
      project_id: 'foreman',
      title: 'Ticket 2',
    })
    const tickets = await commands.list({ project_id: 'foreman' })
    assert.equal(tickets.length, 2)
  })

  it('rejects listing without valid project', async () => {
    setup()
    await assert.rejects(
      () => commands.list({ project_id: 'nonexistent' }),
      (error: unknown) => {
        assert(error instanceof PmError)
        assert.equal(error.code, 'project_not_found')
        return true
      },
    )
  })
})

describe('PmTicketStore', () => {
  it('stores and retrieves tickets via DB', () => {
    const db = initTestDb()
    const store = new PmTicketStore(db)
    const ticket = {
      id: 'pm_test_1',
      kind: 'main' as const,
      project_id: 'foreman',
      title: 'Store test',
      status: 'todo' as const,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    }
    store.insert(ticket)
    const retrieved = store.get('pm_test_1')
    assert.equal(retrieved?.id, ticket.id)
    assert.equal(retrieved?.kind, ticket.kind)
    assert.equal(retrieved?.project_id, ticket.project_id)
    assert.equal(retrieved?.title, ticket.title)
    assert.equal(retrieved?.status, ticket.status)
    assert.equal(retrieved?.created_at, ticket.created_at)
    assert.equal(retrieved?.updated_at, ticket.updated_at)
  })
})
