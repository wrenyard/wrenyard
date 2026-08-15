import type { PrimitiveSet } from '../../../types.mts'
import {
  isForemanOperationName,
  listOperationDescriptors,
  operationRegistry,
} from '../registry.mts'
import { agent } from './agent.mts'
import { llm } from './llm.mts'
import { shell } from './shell.mts'
import type {
  ForemanPrimitiveName,
  PrimitiveDescriptor,
  RuntimePrimitiveImplementations,
} from './types.mts'

export const primitiveRegistry = operationRegistry satisfies Record<ForemanPrimitiveName, PrimitiveDescriptor>

export const defaultRuntimePrimitives = {
  agent,
  shell,
  llm,
} satisfies RuntimePrimitiveImplementations

export function listPrimitiveDescriptors(): PrimitiveDescriptor[] {
  return listOperationDescriptors()
}

export function isForemanPrimitiveName(value: string): value is ForemanPrimitiveName {
  return isForemanOperationName(value)
}

export function createPrimitiveSet(
  overrides: Partial<PrimitiveSet> = {},
): PrimitiveSet {
  return {
    agent: overrides.agent ?? defaultRuntimePrimitives.agent,
    shell: overrides.shell ?? defaultRuntimePrimitives.shell,
    llm: overrides.llm ?? defaultRuntimePrimitives.llm,
    checkpoint: overrides.checkpoint ?? defaultCheckpoint,
  }
}

async function defaultCheckpoint(): Promise<Record<string, unknown>> {
  throw new Error('checkpoint is only available inside a running taskgraph')
}
