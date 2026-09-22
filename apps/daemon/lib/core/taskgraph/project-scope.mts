/** Return whether a project id is the requested project or one of its descendants. */
export function isProjectInScope(candidate: string, root: string): boolean {
  if (!candidate || !root) {
    throw new Error('Project scope check requires non-empty candidate and root')
  }
  return candidate === root || candidate.startsWith(`${root}/`)
}
