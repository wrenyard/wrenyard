/**
 * Daemon-facing runtime alias owner/resolver.
 *
 * Wraps one injected RuntimeAliasStore and exposes snapshot(), put(), remove(),
 * and resolve(). It never caches alias targets: every snapshot/put/remove
 * re-reads the store at call time and resolve({kind:'alias'}) reloads the live
 * store so a concurrent update is observed on the next resolve. Inline target
 * references are parsed and canonicalized through the shared @wrenyard/catalog
 * parseRunSyntax/formatRunSyntax utilities.
 *
 * This module never constructs catalogs/resolvers, reads credentials, or
 * writes user config except through the injected store's explicit put/remove.
 */

import RuntimeAliasStore from '../../runtime-aliases/store.mts'
import { formatRunSyntax, parseRunSyntax } from '@wrenyard/catalog'
import type {
  RuntimeAliasPutParams,
  RuntimeAliasRemoveParams,
  RuntimeAliasSnapshotResult,
} from '../../protocol/methods/runtime-alias.mts'

/** Bounded typed base for alias service failures. */
export class RuntimeAliasServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A named alias reference cannot be satisfied: absent or not usable. */
export class AliasNotFoundError extends RuntimeAliasServiceError {
  readonly aliasName: string
  readonly code = 'alias_not_found'

  constructor(aliasName: string, message?: string) {
    super(message ?? `runtime alias '${aliasName}' is not defined`)
    this.name = 'AliasNotFoundError'
    this.aliasName = aliasName
  }
}

/** An inline target reference is not valid canonical "provider/model:client" syntax. */
export class AliasInvalidTargetError extends RuntimeAliasServiceError {
  readonly target: string
  readonly code = 'alias_invalid_target'

  constructor(target: string, message?: string) {
    super(message ?? `invalid runtime target '${target}'`)
    this.name = 'AliasInvalidTargetError'
    this.target = target
  }
}

/** A reference resolved either to a stored alias or to an inline canonical target. */
export type AliasResolveReference =
  | { kind: 'alias'; name: string }
  | { kind: 'target'; target: string }

export interface ResolvedAliasReference {
  kind: 'alias' | 'inline'
  /** Present when the reference was resolved through a stored alias. */
  name?: string
  /** Canonical "provider/model:client" run string. */
  target: string
}

type IssueScalar = string | number | boolean | null

function projectIssueValue(value: unknown): IssueScalar | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    default:
      // Nested documents never belong in the DTO; collapse them to a string.
      return JSON.stringify(value)
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause)
}

/**
 * Single reusable live alias owner and resolver. Mutations delegate to the
 * store's optimistic expected-revision CAS and each returns a fresh snapshot.
 */
export class RuntimeAliasService {
  constructor(private readonly store: RuntimeAliasStore) {}

  /** Fresh snapshot: usable aliases sorted by name plus projected store issues. */
  async snapshot(): Promise<RuntimeAliasSnapshotResult> {
    const loaded = await this.store.load()
    const aliases = Object.entries(loaded.aliases)
      .map(([name, target]) => ({ name, target }))
      .sort((left, right) => left.name.localeCompare(right.name))
    const issues = loaded.issues.map((issue) => {
      const value = projectIssueValue(issue.value)
      return {
        name: issue.alias,
        ...(value === undefined ? {} : { value }),
        message: issue.problem,
      }
    })
    return {
      config_path: this.store.configFilePath,
      revision: loaded.revision,
      aliases,
      issues,
    }
  }

  /** CAS-guarded put; returns the fresh snapshot after the write. */
  async put(params: RuntimeAliasPutParams): Promise<RuntimeAliasSnapshotResult> {
    await this.store.put(params.name, params.target, params.expected_revision)
    return this.snapshot()
  }

  /** CAS-guarded remove; returns the fresh snapshot after the write. */
  async remove(params: RuntimeAliasRemoveParams): Promise<RuntimeAliasSnapshotResult> {
    await this.store.remove(params.name, params.expected_revision)
    return this.snapshot()
  }

  /**
   * Resolve a live reference at call time. Alias references reload the store so
   * the most recent target is used (never a stale copy); inline targets are
   * canonicalized through the shared @wrenyard/catalog parser.
   */
  async resolve(reference: AliasResolveReference): Promise<ResolvedAliasReference> {
    if (reference.kind === 'alias') {
      const loaded = await this.store.load()
      const target = loaded.aliases[reference.name]
      if (target !== undefined) {
        return { kind: 'alias', name: reference.name, target }
      }
      // The alias may exist on disk but be unusable; surface the store reason.
      const issue = loaded.issues.find((entry) => entry.alias === reference.name)
      if (issue) {
        throw new AliasNotFoundError(
          reference.name,
          `runtime alias '${reference.name}' is not usable: ${issue.problem}`,
        )
      }
      throw new AliasNotFoundError(reference.name)
    }
    return { kind: 'inline', target: this.canonicalizeTarget(reference.target) }
  }

  private canonicalizeTarget(input: string): string {
    if (typeof input !== 'string' || input.length === 0 || input.length > 512) {
      throw new AliasInvalidTargetError(String(input))
    }
    let parsed: unknown
    try {
      parsed = parseRunSyntax(input)
    } catch (cause) {
      throw new AliasInvalidTargetError(input, `invalid runtime target '${input}': ${describeCause(cause)}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AliasInvalidTargetError(input, `unrecognized run syntax: ${JSON.stringify(input)}`)
    }
    try {
      const canonical = formatRunSyntax(parsed as Parameters<typeof formatRunSyntax>[0])
      if (typeof canonical !== 'string' || canonical.length === 0) {
        throw new Error('could not canonicalize run syntax')
      }
      return canonical
    } catch (cause) {
      throw new AliasInvalidTargetError(input, `invalid runtime target '${input}': ${describeCause(cause)}`)
    }
  }
}
