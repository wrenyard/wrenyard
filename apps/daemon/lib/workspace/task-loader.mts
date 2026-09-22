export {
  QualifiedDefinitionIdError,
  describeTask,
  discoverTasks,
  ensureDiscovered,
  findTaskDefinition,
  getLoadErrors,
  invalidateFile,
  isPathStale,
  listTaskDefinitions,
  listTasks,
  markDirty,
  registerTaskFile,
  resetRegistry,
  resolveRunTarget,
  resolveTaskTarget,
} from './definition-registry.mts'
export type {
  DefinitionSource,
  DuplicateDefinitionLoadError,
  GenericLoadError,
  ListedDefinition,
  LoadError,
} from './definition-registry.mts'
