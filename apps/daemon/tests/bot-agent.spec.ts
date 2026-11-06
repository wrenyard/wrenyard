import { expect, it } from 'vitest'
import {
  defineBotAgent,
} from '../lib/daemon/services/bot-agents/kernel.mts'
import type {
  AgentToolName,
  BotAgentEntry,
} from '../lib/daemon/services/bot-agents/config.mts'

// Approved by the bot-on-agent-loop design (2026-11-06).
it('defines a bot agent with the configured tools', () => {
  const tools: AgentToolName[] = ['session', 'todo', 'message', 'memory', 'routine', 'workspace']
  const agent = defineBotAgent(botEntry(tools), [])

  expect(agent.tools.map(tool => tool.name)).toEqual(tools)
  expect(agent.auxiliaryTools).toEqual({ workspace: 'vcs' })
})

function botEntry(tools: AgentToolName[]): BotAgentEntry {
  return {
    id: 'helper',
    location: 'workspace',
    directory: '/workspace/bots/helper',
    configPath: '/workspace/bots/helper/bot.json',
    identityPath: '/workspace/bots/helper/identity.md',
    memoryDir: '/workspace/bots/helper/memory',
    routinesDir: '/config/bots/helper/routines',
    primary: false,
    warnings: [],
    change: { config: '', identity: '', memory: '', routines: '' },
    signature: '',
    configText: '',
    identityText: '',
    config: { primary: false, enabled: true, tools },
    identity: { name: 'Helper', body: '' },
  }
}
