import type {
  OperationDescriptor,
  OperationName,
} from './types.mts'

export const operationRegistry = {
  task: {
    name: 'task',
    kind: 'domain',
    description: 'Runs a Foreman task operation implemented by the core task domain.',
  },
  agent: {
    name: 'agent',
    kind: 'runtime',
    description: 'Runs a prompt through an injected agent runtime.',
  },
  shell: {
    name: 'shell',
    kind: 'runtime',
    description: 'Runs a shell command through an injected or local shell runtime.',
  },
  llm: {
    name: 'llm',
    kind: 'runtime',
    description: 'Runs a direct LLM completion operation.',
  },
  checkpoint: {
    name: 'checkpoint',
    kind: 'control',
    description: 'Pauses or resumes execution at an explicit checkpoint.',
  },
} as const satisfies Record<OperationName, OperationDescriptor>

export function listOperationDescriptors(): OperationDescriptor[] {
  return Object.values(operationRegistry)
}

export function isForemanOperationName(value: string): value is OperationName {
  return Object.hasOwn(operationRegistry, value)
}
