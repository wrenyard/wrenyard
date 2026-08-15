/**
 * Segment-safe project subtree guard.
 * The candidate is in scope iff candidate === root || candidate.startsWith(root + '/').
 * Rejects empty ids with a clear error.
 */

export function isProjectInScope(candidate: string, root: string): boolean {
  if (!candidate || !root) {
    throw new Error('Project scope check requires non-empty candidate and root')
  }
  return candidate === root || candidate.startsWith(root + '/')
}
