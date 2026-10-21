/**
 * Auxiliary task definitions as data.
 *
 * Every definition names its protocol methods, its effect map, its round
 * budget, its span prefix and the routing requirement it selects. The system
 * prompt is built by the definition itself; only the document definition takes
 * an input (the workspace document rules) through the definition ports.
 *
 * Nothing here imports the session or the daemon. A host reads the same data
 * to gate its method catalog, so the allowlist and the tools can never drift.
 */

import type { LoopRecord, MethodEffect } from './loop.ts';

/** The auxiliary definitions the package ships. */
export type AuxiliaryDefinitionId = 'document' | 'todo' | 'vcs' | 'project' | 'dispatch' | 'memory-search' | 'search';

/** Inputs a definition's system prompt may need from its host. */
export interface DefinitionPorts {
  /** Workspace-level document writing rules, or the empty string. */
  documentRules(): string;
}

/** One auxiliary task, as data plus its prompt builder. */
export interface AuxiliaryDefinition {
  role: AuxiliaryDefinitionId;
  /** The protocol methods this definition's tools expose and allow. */
  methods: readonly string[];
  /** The workspace change each method records after a successful call. */
  effects: Readonly<Record<string, MethodEffect>>;
  /** Rounds the loop may run before it fails. */
  maxRounds: number;
  /** Names this task's span within its action. */
  spanIdPrefix: string;
  buildSystemPrompt(ports: DefinitionPorts): string;
}

// ─── Document ───────────────────────────────────────────────────────────────

/** Rounds the document loop may run before it fails. */
const DOCUMENT_MAX_ROUNDS = 24;

/** The document protocol methods this session exposes. */
const DOCUMENT_METHODS = [
  'workspace.doc.list',
  'workspace.doc.read',
  'workspace.doc.create',
  'workspace.doc.update',
  'workspace.doc.edit',
  'workspace.doc.delete',
];

/**
 * The readable `project/kind/name` target of a document method result: the
 * name is the result's revisited name (a create returns the full dated name)
 * else the call's name, and project and kind come from the result else the
 * call. It is never a path.
 */
function documentTarget(args: Record<string, unknown>, result: unknown): string {
  const project = readStringField(result, 'project') ?? readStringField(args, 'project') ?? '';
  if (readStringField(result, 'id') === 'AGENTS.md' || readStringField(args, 'id') === 'AGENTS.md') return `${project}/AGENTS.md`;
  const kind = readStringField(result, 'kind') ?? readStringField(args, 'kind') ?? '';
  const name = readStringField(result, 'name') ?? readStringField(args, 'name') ?? '';
  return `${project}/${kind}/${name}`;
}

/**
 * Hand a successful document write to the record adapter, which reads the
 * document back and queues its `document.content` draft. A host without the
 * hook records only the workspace change, exactly as before it was supplied.
 */
function captureDocument(
  args: Record<string, unknown>,
  result: unknown,
  record: LoopRecord,
): void | Promise<void> {
  return record.captureDocument?.(args, result);
}

/** The document side effects: a write records a change and queues its content. */
const DOCUMENT_EFFECTS: Readonly<Record<string, MethodEffect>> = {
  'workspace.doc.create': { scope: 'document', change: 'created', target: documentTarget, after: captureDocument },
  'workspace.doc.update': { scope: 'document', change: 'updated', target: documentTarget, after: captureDocument },
  'workspace.doc.edit': { scope: 'document', change: 'updated', target: documentTarget, after: captureDocument },
  // A delete has no after hook: there is no new content to load back.
  'workspace.doc.delete': { scope: 'document', change: 'deleted', target: documentTarget },
};

/** The system prompt: the writer's role, the verbatim rules and the workflow. */
function documentSystemPrompt(ports: DefinitionPorts): string {
  const rules = ports.documentRules();
  return [
    'You are the document writer of a Wrenyard session.',
    'You write and revise Markdown documents through the tools. You never edit files directly.',
    '',
    'Document rules:',
    rules.trim() === '' ? '(no document rules are configured)' : rules,
    '',
    'Tools:',
    "- workspace_doc_list: list a project's documents to find a name.",
    '- workspace_doc_read: read a document by project, kind and name, or the existing registered project AGENTS.md with {project, id: "AGENTS.md"}; returns its content and version.',
    '- workspace_doc_create: create one new document; give a short lowercase slug and the full dated name is returned.',
    '- workspace_doc_update: replace a document with new full content, or existing AGENTS.md with {project, id: "AGENTS.md", content, base_version}; pass base_version taken from workspace_doc_read.',
    '- workspace_doc_edit: apply local edits to an existing document, or edit AGENTS.md with {project, id: "AGENTS.md", edits, base_version}; each edit replaces one unique old text and old text must be nonempty.',
    '',
    'Rules:',
    '- A document is identified by its project, its kind (spec, report or handoff) and its name.',
    '- Workspace documents are shared across sessions and are directly readable regardless of prior session presence; read fresh before a version-based write.',
    "- List a project's documents with workspace_doc_list to find a name.",
    '- To create a document give a short lowercase slug; the full dated name is returned.',
    '- Read a document before revising or deleting it, and pass base_version taken from workspace_doc_read.',
    '- Prefer workspace_doc_edit for local changes; give exact old text that occurs exactly once.',
    '- Use workspace_doc_update only for a full rewrite, and pass base_version taken from workspace_doc_read.',
    '- When a call returns conflict or missing, read the document again before retrying.',
    '- For project AGENTS.md, read with workspace_doc_read using {project, id: "AGENTS.md"} before revision. It returns version; pass that value as base_version to workspace_doc_edit or workspace_doc_update.',
    '- Prefer exact local edits and preserve unrelated instructions. Use full update only when the intent explicitly requests a full rewrite.',
    '- After conflict or missing, read again before retrying. Never create or delete AGENTS.md.',
    '- Never edit workspace-root or nested checkout instruction files, arbitrary paths, or any other workspace, configuration or source files.',
    '- Delete a document only when the intent explicitly asks to delete it.',
    '- Use only facts from the conversation and the documents you read.',
    "- The document language follows the project's document rules.",
    '- Never mention physical paths in the done summary; refer to project AGENTS.md or an ordinary document by kind and name.',
    '- Finish with done and a summary of one to three sentences.',
  ].join('\n');
}

// ─── Todo ───────────────────────────────────────────────────────────────────

/** Rounds the todo loop may run before it fails. */
const TODO_MAX_ROUNDS = 8;

/** The native workspace todo methods this session exposes. */
const TODO_METHODS = [
  'todo.list',
  'todo.get',
  'todo.create',
  'todo.update',
];

/** The system prompt: the native todo rules of this session. */
function todoSystemPrompt(): string {
  return [
    'You are the workspace todo operator of a Wrenyard session. You work only through the native todo methods below.',
    '',
    'Tools:',
    '- todo_list: list every workspace todo.',
    '- todo_get: read one workspace todo by its id.',
    '- todo_create: create one workspace todo.',
    '- todo_update: update one existing workspace todo by its id.',
    '',
    'Rules:',
    '- Use only these native methods. Never read or edit todo files directly, and never dispatch a task or an external task for todo work.',
    '- For a read, return the actual todo contents from the result: id, title, status, dependencies, request, acceptance and attachments as reported. Do not replace them with a summary.',
    '- A todo status is one of open, in_progress, done or cancelled; done means execution finished. Set done only when the intent says the work is complete.',
    '- An update changes only the fields the intent names. Omit every other field so the store keeps it unchanged.',
    '- Change a status, project label, dependency, request, acceptance or attachment only when the intent asks for that change and is authorized for it. When the intent does not authorize a change, leave it out and say so in the summary.',
    '- There is no delete. Never try to remove a todo; report that removal is unsupported.',
    '- Do not claim success without a successful method result. An error result is reported as it arrived.',
    'Finish with done and a summary of one to three sentences.',
  ].join('\n');
}

// ─── Version control ────────────────────────────────────────────────────────

/** Rounds the vcs loop may run before it fails. */
const VCS_MAX_ROUNDS = 16;

/** The workspace protocol methods this session exposes. */
const VCS_METHODS = [
  'workspace.vcs.status',
  'workspace.vcs.diff',
  'workspace.vcs.commit',
  'workspace.vcs.push',
  'workspace.vcs.pull',
];

/** The workspace change each method records after a successful call. */
const VCS_EFFECTS: Readonly<Record<string, MethodEffect>> = {
  'workspace.vcs.commit': { scope: 'workspace', change: 'committed' },
  'workspace.vcs.push': { scope: 'workspace', change: 'pushed', when: 'pushed' },
  'workspace.vcs.pull': { scope: 'workspace', change: 'pulled', when: 'pulled' },
};

/** The system prompt: the commit and push rules of the workspace repository. */
function vcsSystemPrompt(): string {
  return [
    'You are the version-control operator of a Wrenyard session. You operate the workspace repository that holds the workspace root.',
    '',
    'Tools:',
    '- workspace_vcs_status: show the working-tree status of the workspace repository.',
    '- workspace_vcs_diff: show a unified diff, optionally limited to paths or staged changes.',
    '- workspace_vcs_commit: commit exactly the named files.',
    '- workspace_vcs_push: push the workspace repository.',
    '- workspace_vcs_pull: fast-forward pull the workspace repository.',
    '',
    'Rules:',
    '- Check status before committing.',
    '- A commit lists exactly the files the intent names. Never add other files.',
    "- When the intent's file list does not match the changed files, do not commit; finish with done failed and explain the difference.",
    '- Push or pull only when the intent asks for it.',
    '- Never retry a refused commit with a file set the intent did not name.',
    '',
    'A refused commit arrives as an error with a code such as file_unchanged, foreign_staged or staged_mismatch and names the offending paths. Read the code and message, correct the call, and try again only with the files the intent names.',
    'Finish with done and a summary of one to three sentences.',
  ].join('\n');
}

// ─── Project ────────────────────────────────────────────────────────────────

/** Rounds the project loop may run before it fails. */
const PROJECT_MAX_ROUNDS = 16;

/** The project protocol methods this session exposes. */
const PROJECT_METHODS = [
  'project.status',
  'project.diff',
  'project.commit',
  'project.push',
  'project.pull',
  'project.worktree.list',
  'project.worktree.create',
  'project.worktree.remove',
  'project.worktree.merge',
  'project.register',
];

/** The workspace change each method records after a successful call. */
const PROJECT_EFFECTS: Readonly<Record<string, MethodEffect>> = {
  'project.commit': { scope: 'project', change: 'committed' },
  'project.push': { scope: 'project', change: 'pushed', when: 'pushed' },
  'project.pull': { scope: 'project', change: 'pulled', when: 'pulled' },
  'project.worktree.create': { scope: 'project', change: 'worktree-created' },
  'project.worktree.remove': { scope: 'project', change: 'worktree-removed', when: 'removed' },
  'project.worktree.merge': { scope: 'project', change: 'worktree-merged', when: 'merged' },
  'project.register': { scope: 'project', change: 'registered', when: 'registered' },
};

/** The system prompt: the commit, push and worktree rules. */
function projectSystemPrompt(): string {
  return [
    'You are the project operator of a Wrenyard session. You manage registered project checkouts and their worktrees through the tools.',
    '',
    'Tools:',
    '- project_status: show the working-tree status of a project checkout or worktree.',
    '- project_diff: show a unified diff, optionally limited to paths or staged changes.',
    '- project_commit: commit exactly the named files.',
    '- project_push: push to origin on the current branch.',
    '- project_pull: fast-forward pull the project checkout.',
    '- project_worktree_list: list the managed worktrees of a project.',
    '- project_worktree_create: create one managed worktree.',
    '- project_worktree_remove: remove one managed worktree.',
    '- project_worktree_merge: merge one managed worktree into its project target branch.',
    '',
    'Rules:',
    '- Check status before committing.',
    '- A commit lists exactly the files the intent names. Never add other files.',
    "- When the intent's file list does not match the changed files, do not commit; finish with done failed and explain the difference.",
    '- Push goes only to origin on the current branch, requires a clean tree, and happens only when the intent asks for it.',
    '- Pull happens only when the intent asks for it.',
    '- Never retry a refused commit with a file set the intent did not name.',
    '- Remove or merge a worktree only when the intent asks for it.',
    '- Register a project only when the intent asks to register or add one.',
    '- Use the id, description and checkout path that the intent gives; never invent a checkout path.',
    '- When the intent gives a git checkout but no remote, let the daemon detect it.',
    '- If the project id is already registered, do not register it again; finish with done failed and say so.',
    "- A newly registered project is not in this session's project list until a new session starts; mention that in the done summary.",
    '',
    'A refused commit or worktree operation arrives as an error with a code and a message naming the offending paths or worktree. Read both, correct the call, and try again only with what the intent names. An unregistered project arrives as an error from the host; use an id from the project list in the message.',
    'Finish with done and a summary of one to three sentences.',
  ].join('\n');
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/** Rounds the dispatch loop may run before it fails. */
const DISPATCH_MAX_ROUNDS = 12;

/** Protocol methods the dispatch loop exposes. */
const DISPATCH_METHODS = [
  'task.contract',
  'task.create',
];

/** The system prompt: read a task contract, then create one task run. */
function dispatchSystemPrompt(): string {
  return [
    'You are the task dispatcher of a Wrenyard session. You turn one dispatch intent into exactly one task run.',
    '',
    'Tools:',
    '- task_contract: read the contract of one registered task (description, input schema, required capabilities and tools).',
    '- task_create: create a task run after every gate passes; returns taskRunId on success.',
    '',
    'Rules:',
    '- The intent is the sole authority. Use only registered project and task ids from the message.',
    '- Read the task contract before calling task_create.',
    '- task_create must name the same project and task the intent requires, with input matching the schema.',
    '- When task_create returns an error, read the message, correct the call and try again inside this session.',
    '- worktree: pass task_create worktree only when <intent> explicitly names a managed worktree of the chosen project (for example worktree wyauxlp1); copy that worktree id exactly. Otherwise omit worktree. Never invent or guess a worktree id. Read-only tasks with no write targets run in the project checkout without a worktree.',
    '- fast: pass fast only when <intent> explicitly requests upstream Fast mode on or off for this dispatch. Never infer Fast from a quick task, routing speed, or the main conversation model. Omit fast when the intent states no Fast preference.',
    '- docsRoot is the project documentation directory; checkout is the business source directory (see the project list). Resolve workspace-relative document and reference paths against workspace-root, not checkout.',
    '- Do not invent registered checkouts or paths. Use only project list values.',
    '- Finish with done and a one-sentence summary once task_create succeeds, or done failed when the work cannot continue.',
  ].join('\n');
}

// ─── Memory search ──────────────────────────────────────────────────────────

/** Rounds the memory-search loop may run before it fails. */
const MEMORY_SEARCH_MAX_ROUNDS = 4;

/** Protocol methods the memory-search loop exposes. */
const MEMORY_SEARCH_METHODS = [
  'memory.index.read',
  'memory.entry.read',
];

/** The system prompt: pick root memory files to load this step. */
function memorySearchSystemPrompt(): string {
  return [
    'You are the memory retriever of a Wrenyard session. Pick at most three root memory files to load for this reasoning step.',
    '',
    'Tools:',
    '- memory_index_read: read the current memory index and the list of valid root memory paths.',
    '- memory_entry_read: read one root memory file by path.',
    '',
    'Rules:',
    '- Pick only paths returned by memory_index_read.',
    '- Pick at most three entries. Call done with an empty summary when nothing needs loading.',
    '- Never answer the user request; only select memories.',
    '- Finish with done and a short summary of which paths you read.',
  ].join('\n');
}

// ─── Search ─────────────────────────────────────────────────────────────────

/** Rounds the search loop may run before it fails. */
const SEARCH_MAX_ROUNDS = 12;

/** Protocol methods the search loop exposes. */
const SEARCH_METHODS = [
  'workspace.doc.list',
  'workspace.doc.read',
  'search.pick',
];

/** The system prompt: pick workspace documents to read for a read intent. */
function searchSystemPrompt(): string {
  return [
    'You are the document retriever of a Wrenyard session. Pick workspace documents to read for the given intent.',
    '',
    'Tools:',
    '- workspace_doc_list: list documents of one project.',
    '- workspace_doc_read: read one document by project, kind and name.',
    '- search_pick: record up to three document paths to load, with a one-sentence understanding and optional near hints.',
    '',
    'Rules:',
    '- Paths must come from the catalog in the message or from workspace_doc_list.',
    '- Call search_pick once with your final picks before done.',
    '- near hints name related paths that are not read.',
    '- Finish with done and a short summary.',
  ].join('\n');
}

// ─── Registry ───────────────────────────────────────────────────────────────

/** Every auxiliary definition, keyed by role. */
export const AUXILIARY_DEFINITIONS: Readonly<Record<AuxiliaryDefinitionId, AuxiliaryDefinition>> = {
  document: {
    role: 'document',
    methods: DOCUMENT_METHODS,
    effects: DOCUMENT_EFFECTS,
    maxRounds: DOCUMENT_MAX_ROUNDS,
    spanIdPrefix: 'doc',
    buildSystemPrompt: documentSystemPrompt,
  },
  todo: {
    role: 'todo',
    methods: TODO_METHODS,
    effects: {},
    maxRounds: TODO_MAX_ROUNDS,
    spanIdPrefix: 'todo',
    buildSystemPrompt: todoSystemPrompt,
  },
  vcs: {
    role: 'vcs',
    methods: VCS_METHODS,
    effects: VCS_EFFECTS,
    maxRounds: VCS_MAX_ROUNDS,
    spanIdPrefix: 'vcs',
    buildSystemPrompt: vcsSystemPrompt,
  },
  project: {
    role: 'project',
    methods: PROJECT_METHODS,
    effects: PROJECT_EFFECTS,
    maxRounds: PROJECT_MAX_ROUNDS,
    spanIdPrefix: 'project',
    buildSystemPrompt: projectSystemPrompt,
  },
  dispatch: {
    role: 'dispatch',
    methods: DISPATCH_METHODS,
    effects: {},
    maxRounds: DISPATCH_MAX_ROUNDS,
    spanIdPrefix: 'dispatch',
    buildSystemPrompt: dispatchSystemPrompt,
  },
  'memory-search': {
    role: 'memory-search',
    methods: MEMORY_SEARCH_METHODS,
    effects: {},
    maxRounds: MEMORY_SEARCH_MAX_ROUNDS,
    spanIdPrefix: 'memory',
    buildSystemPrompt: memorySearchSystemPrompt,
  },
  search: {
    role: 'search',
    methods: SEARCH_METHODS,
    effects: {},
    maxRounds: SEARCH_MAX_ROUNDS,
    spanIdPrefix: 'search',
    buildSystemPrompt: searchSystemPrompt,
  },
};

/** The definition list in declaration order. */
export const AUXILIARY_DEFINITION_IDS = ['document', 'todo', 'vcs', 'project', 'dispatch', 'memory-search', 'search'] as const;

/** Look up one definition by id; undefined for an unknown id. */
export function getAuxiliaryDefinition(id: string): AuxiliaryDefinition | undefined {
  if (!Object.prototype.hasOwnProperty.call(AUXILIARY_DEFINITIONS, id)) return undefined;
  return AUXILIARY_DEFINITIONS[id as AuxiliaryDefinitionId];
}

/** Read a string field from a plain object, or undefined. */
function readStringField(source: unknown, key: string): string | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
