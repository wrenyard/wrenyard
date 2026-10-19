import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadBotAgents, validateConfig } from '../lib/daemon/services/bot-agents/config.mts'
import { createScheduler } from '../lib/daemon/services/scheduler.mts'

function makeRoots(): { workspace: string; device: string; statePath: string } {
  const base = mkdtempSync(join(tmpdir(), 'wrenyard-bot-flat-'))
  const workspace = join(base, 'workspace')
  const device = join(base, 'bot-agents')
  mkdirSync(device, { recursive: true })
  return { workspace, device, statePath: join(base, 'routines.json') }
}

test('legacy flat device bot json migrates, loads and imports routines idempotently', async () => {
  const { workspace, device, statePath } = makeRoots()
  try {
    writeFileSync(join(device, 'helper.json'), `${JSON.stringify({
      id: 'helper',
      name: 'Helper',
      enabled: true,
      instructions: 'You help with todos.',
      tools: { session: true, todo: true },
      routines: [{
        name: 'sweep',
        prompt: 'Review open todos.',
        intervalMinutes: 30,
        deliver: 'none',
      }],
    }, null, 2)}\n`, 'utf-8')

    const first = await loadBotAgents({ workspace, device })
    const bot = first.bots.find(entry => entry.id === 'helper')
    assert.ok(bot !== undefined)
    assert.equal(bot.error, undefined)
    assert.equal(bot.identity?.name, 'Helper')
    assert.equal(bot.identity?.body, 'You help with todos.')
    assert.deepEqual(bot.config?.tools, ['session', 'todo'])
    assert.equal(bot.configDeclaredRoutines?.length, 1)
    assert.equal(existsSync(join(device, 'helper.json.migrated')), true)
    assert.equal(existsSync(join(device, 'helper', 'bot.json')), true)
    assert.equal(existsSync(join(device, 'helper', 'identity.md')), true)

    const scheduler = createScheduler({
      statePath,
      workspaceRoot: workspace,
      wake: () => {},
    })
    await scheduler.prepare()
    const declared = bot.configDeclaredRoutines!
    scheduler.importConfigDeclaredRoutines('helper', declared)
    assert.equal(scheduler.list('helper').routines.length, 1)
    const routine = scheduler.list('helper').routines[0]!
    assert.equal(routine.name, 'sweep')
    assert.equal(routine.prompt, 'Review open todos.')
    assert.equal(routine.intervalMinutes, 30)
    assert.equal(routine.deliver, 'none')

    scheduler.importConfigDeclaredRoutines('helper', declared)
    assert.equal(scheduler.list('helper').routines.length, 1)

    const second = await loadBotAgents({ workspace, device }, first.bots)
    const reloaded = second.bots.find(entry => entry.id === 'helper')
    assert.ok(reloaded !== undefined)
    assert.equal(reloaded.error, undefined)
    assert.equal(reloaded.configDeclaredRoutines, undefined)
    assert.equal(reloaded.identity?.name, 'Helper')
    assert.equal(readFileSync(reloaded.configPath, 'utf-8'), readFileSync(bot.configPath, 'utf-8'))
    assert.equal(readFileSync(reloaded.identityPath, 'utf-8'), readFileSync(bot.identityPath, 'utf-8'))

    scheduler.importConfigDeclaredRoutines('helper', declared)
    assert.equal(scheduler.list('helper').routines.length, 1)
  } finally {
    rmSync(join(device, '..'), { recursive: true, force: true })
  }
})

test('validateConfig still rejects legacy keys inside bot.json', () => {
  assert.throws(
    () => validateConfig(JSON.stringify({ name: 'Legacy', enabled: true })),
    /unknown field: name/u,
  )
})
