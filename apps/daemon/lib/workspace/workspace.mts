import { ProjectManager } from '../core/project/manager.mts'
import {
  describeTask,
  discoverTasks,
  ensureDiscovered,
  findTaskDefinition,
  getLoadErrors,
  isPathStale,
  listTaskDefinitions,
  listTasks,
  markDirty,
  resetRegistry,
  resolveTaskTarget,
  type ListedDefinition,
  type LoadError,
} from './task-loader.mts'
import {
  compileSchema,
  generateInputExample,
  normalizeSchema,
  type CompiledSchema,
} from './schema-loader.mts'

export interface ForemanWorkspaceOptions {
  root: string
}

export class ForemanWorkspace {
  readonly root: string
  readonly projects: WorkspaceProjectFacade
  readonly tasks: WorkspaceTaskFacade
  readonly schemas: WorkspaceSchemaFacade

  constructor(options: ForemanWorkspaceOptions) {
    this.root = options.root
    this.projects = new WorkspaceProjectFacade(this.root)
    this.tasks = new WorkspaceTaskFacade(this.root)
    this.schemas = new WorkspaceSchemaFacade(this.root)
  }

  async discover(): Promise<void> {
    await discoverTasks(this.root)
  }

  async ensureDiscovered(skipRefresh = false): Promise<void> {
    await ensureDiscovered(this.root, skipRefresh)
  }

  markDirty(): void {
    markDirty(this.root)
  }

  reset(): void {
    resetRegistry(this.root)
  }

  getLoadErrors(): LoadError[] {
    return getLoadErrors(this.root)
  }

  isPathStale(sourcePath: string): boolean {
    return isPathStale(sourcePath, this.root)
  }
}

export class WorkspaceProjectFacade {
  private readonly manager: ProjectManager

  constructor(private readonly root: string) {
    this.manager = new ProjectManager({ workspaceRoot: this.root })
  }

  list(): ReturnType<ProjectManager['listProjects']> {
    return this.manager.listProjects()
  }

  describe(project: string): ReturnType<ProjectManager['getProject']> {
    return this.manager.getProject(project)
  }

  status(project: string): ReturnType<ProjectManager['status']> {
    return this.manager.status(project)
  }
}

export class WorkspaceTaskFacade {
  constructor(private readonly root: string) {}

  list(project?: string): ListedDefinition[] {
    return listTasks(this.root, project)
  }

  listDefinitions(project?: string): ReturnType<typeof listTaskDefinitions> {
    return listTaskDefinitions(this.root, project)
  }

  describe(taskId: string, project?: string): ListedDefinition | null {
    return describeTask(taskId, this.root, project)
  }

  find(taskId: string, project?: string): ListedDefinition | null {
    return findTaskDefinition(taskId, this.root, project)
  }

  resolve(taskId: string, project?: string): ReturnType<typeof resolveTaskTarget> {
    return resolveTaskTarget(taskId, this.root, project)
  }
}

export class WorkspaceSchemaFacade {
  constructor(private readonly root: string) {}

  normalize: typeof normalizeSchema = normalizeSchema
  compile: typeof compileSchema = compileSchema
  inputExample: typeof generateInputExample = generateInputExample
}

export type { CompiledSchema, ListedDefinition, LoadError }
