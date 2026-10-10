/**
 * Public surface of the daemon's version-control module.
 *
 * Consumers import `runGit`, `GitRunResult`, `GitRepository`, `VcsError` and
 * the repository result types from `../vcs/index.mts`.
 */

export * from './git.mts'
export * from './repository.mts'
