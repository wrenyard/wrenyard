// ─── Task definition contract resolver ───────────────────────────────────────
// Independent resolver that discovers task definition input schemas
// from workspace registry metadata. Does not extend or conflate with
// TaskGraphAutoSchemaResolver (which handles graph wiring schemas).
//
// Exposes a test-injectable interface and a workspace-registry-backed
// implementation. The resolver returns a JsonSchema (any root) — not object-root
// only — supporting array-root task input contracts.

import type { JsonSchema } from '../../types.mts'

// ─── Public contract types ─────────────────────────────────────────────────────

export interface ResolvedDefinitionContract {
  /** Canonical task id. */
  definitionId: string
  /** Always 'task'. */
  kind: 'task'
  /** Project scope where the definition was found. */
  project: string
  /** The definition's input schema (any valid JSON Schema root, may be array). */
  input: JsonSchema | undefined
  /** The definition's output schema, when the definition declares one. */
  output?: JsonSchema
  /** Validated definition category; present only when the definition declares one. */
  category?: { id: string; displayLabel: string }
  /** One-line human-readable definition description (snapshots bound it). */
  description?: string
  /** Resolved requested agent runtime selector (e.g. 'forge/codex-luna'). */
  agentRuntime?: string
  scheduling?: 'active' | 'legacy'
}

export interface TaskGraphTaskContractResolver {
  /**
   * Resolve a task definition contract by plain name and project.
   *
   * @param kind - 'task'
   * @param name - Plain definition name (from action params.name).
   * @param project - Project scope for definition resolution.
   *
   * @returns The resolved contract, null if an enabled resolver could not find
   * the named definition (genuine registry miss), or undefined if contract
   * resolution is intentionally disabled/unavailable and validation must skip.
   * Must determine missing-name and missing-project from validation input,
   * not from this resolver — pure registry discovery.
   */
  resolveDefinitionContract(
    kind: 'task',
    name: string,
    project: string,
  ): ResolvedDefinitionContract | null | undefined
}

// ─── Workspace-registry-backed implementation ─────────────────────────────────

export interface WorkspaceContractResolverOptions {
  /** Callback to find a task definition by name and project. */
  findTaskDefinition: (name: string, project: string) => {
    name: string
    input_schema?: unknown
    output_schema?: unknown
    category?: { id: string; displayLabel: string }
    description?: string
    agentRuntime?: string
    scheduling?: 'active' | 'legacy'
  } | null
}

interface FoundDefinition {
  name: string
  input_schema?: unknown
  output_schema?: unknown
  category?: { id: string; displayLabel: string }
  description?: string
  agentRuntime?: string
  scheduling?: 'active' | 'legacy'
}

function toFoundDefinition(def: FoundDefinition): FoundDefinition {
  return {
    name: def.name,
    ...(def.input_schema !== undefined ? { input_schema: def.input_schema } : {}),
    ...(def.output_schema !== undefined ? { output_schema: def.output_schema } : {}),
    ...(def.category ? { category: def.category } : {}),
    ...(def.description ? { description: def.description } : {}),
    ...(def.agentRuntime ? { agentRuntime: def.agentRuntime } : {}),
    ...(def.scheduling ? { scheduling: def.scheduling } : {}),
  }
}

/**
 * Workspace-registry-backed TaskGraphTaskContractResolver.
 *
 * Uses synchronous definition lookup (discovery must have happened
 * before this resolver is called). The caller is responsible for
 * ensuring the workspace is discovered.
 */
export class WorkspaceTaskContractResolver implements TaskGraphTaskContractResolver {
  private readonly options: WorkspaceContractResolverOptions

  constructor(options: WorkspaceContractResolverOptions) {
    this.options = options
  }

  resolveDefinitionContract(
    kind: 'task',
    name: string,
    project: string,
  ): ResolvedDefinitionContract | null {
    if (kind !== 'task') return null
    const def = this.options.findTaskDefinition(name, project)
    if (!def) return null

    const found = toFoundDefinition(def)
    return {
      definitionId: found.name,
      kind: 'task',
      project,
      input: found.input_schema as JsonSchema | undefined,
      ...(found.output_schema !== undefined
        ? { output: found.output_schema as JsonSchema }
        : {}),
      ...(found.category ? { category: found.category } : {}),
      ...(found.description ? { description: found.description } : {}),
      ...(found.agentRuntime ? { agentRuntime: found.agentRuntime } : {}),
      ...(found.scheduling ? { scheduling: found.scheduling } : {}),
    }
  }
}

// ─── Null/test resolver ───────────────────────────────────────────────────────

/**
 * A contract resolver that always returns undefined (contract validation
 * disabled). Useful as a default or in tests that don't need definition
 * contract validation.
 */
export const NULL_CONTRACT_RESOLVER: TaskGraphTaskContractResolver = {
  resolveDefinitionContract: () => undefined,
}
