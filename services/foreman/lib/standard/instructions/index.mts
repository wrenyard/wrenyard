import commitRules from './commit-rules.mts'
import shellUsage from './shell-usage.mts'
import editOperationUnits from './edit-operation-units.mts'
import brandGuidelines from './brand-guidelines.mts'
import designTaste from './design-taste.mts'
import docCoauthoring from './doc-coauthoring.mts'
import featurePointDefinition from './feature-point-definition.mts'
import gitMaster from './git-master.mts'
import handoffDoc from './handoff-doc.mts'
import notesArchive from './notes-archive.mts'
import obsidianCli from './obsidian-cli.mts'
import repoRules from './repo-rules.mts'
import specDocument from './spec-document.mts'

/**
 * Canonical, immutable bundle of the Foreman-owned instruction text consumed
 * by external workspace task/flow definitions without imports.
 *
 * Composed by reference from the sibling instruction modules — no cloning or
 * serialization. Installed on `globalThis.foremanInstructions` by the daemon
 * runtime-global setup before any external task/flow module is evaluated.
 */
const foremanInstructions = Object.freeze({
  commitRules: Object.freeze(commitRules),
  shellUsage: Object.freeze(shellUsage),
  editOperationUnits: Object.freeze(editOperationUnits),
  brandGuidelines: Object.freeze(brandGuidelines),
  designTaste: Object.freeze(designTaste),
  docCoauthoring: Object.freeze(docCoauthoring),
  featurePointDefinition: Object.freeze(featurePointDefinition),
  gitMaster: Object.freeze(gitMaster),
  handoffDoc: Object.freeze(handoffDoc),
  notesArchive: Object.freeze(notesArchive),
  obsidianCli: Object.freeze(obsidianCli),
  repoRules: Object.freeze(repoRules),
  specDocument: Object.freeze(specDocument),
})

export type ForemanInstructions = typeof foremanInstructions

export {
  foremanInstructions,
  commitRules,
  shellUsage,
  editOperationUnits,
  brandGuidelines,
  designTaste,
  docCoauthoring,
  featurePointDefinition,
  gitMaster,
  handoffDoc,
  notesArchive,
  obsidianCli,
  repoRules,
  specDocument,
}
