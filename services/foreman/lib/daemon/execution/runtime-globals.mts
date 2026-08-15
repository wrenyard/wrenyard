import { createPrimitiveSet } from '../../core/operations/primitives/registry.mts'
import { foremanSchemas } from '../../core/task/schemas/index.mts'
import { foremanInstructions } from '../../standard/instructions/index.mts'
import type {
  PrimitiveSet,
  TaskConfig,
  TaskDefinition,
} from '../../types.mts'

export interface RuntimeGlobalOptions {
  primitives?: Partial<PrimitiveSet>
  checkpoint?: PrimitiveSet['checkpoint']
}

type GlobalKey = 'defineTask' | 'agent' | 'shell' | 'llm' | 'checkpoint' | 'foremanSchemas' | 'foremanInstructions'

export function installRuntimeGlobals(opts: RuntimeGlobalOptions = {}): () => void {
  const keys: GlobalKey[] = ['defineTask', 'agent', 'shell', 'llm', 'checkpoint', 'foremanSchemas', 'foremanInstructions']
  const previous = new Map<GlobalKey, unknown>()
  for (const key of keys) previous.set(key, globalThis[key])

  const primitives = createPrimitiveSet({
    ...opts.primitives,
    ...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
  })

  globalThis.agent = primitives.agent
  globalThis.shell = primitives.shell
  globalThis.llm = primitives.llm
  globalThis.checkpoint = primitives.checkpoint
  globalThis.defineTask = (config: TaskConfig): TaskDefinition => ({
    __type: 'task',
    config,
    sourcePath: '',
  })
  // Canonical Foreman-owned Zod schema bundle, installed before any
  // external task module is dynamically imported and evaluated.
  globalThis.foremanSchemas = foremanSchemas
  // Canonical Foreman-owned instruction bundle, installed alongside the
  // schema bundle before any external task module is evaluated.
  globalThis.foremanInstructions = foremanInstructions

  return () => {
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) {
        Reflect.deleteProperty(globalThis, key)
      } else {
        ;(globalThis as Record<GlobalKey, unknown>)[key] = value
      }
    }
  }
}
