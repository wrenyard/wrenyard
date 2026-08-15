import type { PrimitiveSet } from '../../../types.mts'
import type {
  AgentRuntimePermission,
  OperationDescriptor,
  OperationKind,
  OperationName,
} from '../types.mts'

export type RuntimePrimitiveName = Extract<OperationName, 'agent' | 'shell' | 'llm'>
export type DomainPrimitiveName = Extract<OperationName, 'task' | 'checkpoint'>
export type ForemanPrimitiveName = RuntimePrimitiveName | DomainPrimitiveName

export type PrimitiveKind = OperationKind

export type PrimitiveDescriptor = OperationDescriptor

export type RuntimePrimitiveImplementations = Pick<PrimitiveSet, RuntimePrimitiveName>
export type { AgentRuntimePermission }
