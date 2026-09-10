import commitRules from './commit-rules.mts'
import shellUsage from './shell-usage.mts'

/** Shared instructions used by current tasks and exposed to project tasks. */
const foremanInstructions = Object.freeze({ commitRules, shellUsage })
export type ForemanInstructions = typeof foremanInstructions
export { foremanInstructions, commitRules, shellUsage }
