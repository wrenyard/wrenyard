import { z } from 'zod'
import {
  ChangeSchema,
  FileTargetSchema,
  evidenceWith,
} from '../../core/task/concepts.mts'
import shellUsage from '../instructions/shell-usage.mts'

/**
 * Edit — file-level edit executor builtin.
 *
 * Input is an object containing `ChangeSchema[]` (each change binds
 * a file `Target` to an `action` + `instruction` + `expected` state), and
 * output is `EvidenceSchema[]` (one evidence record per observed edit).
 *
 * The exact-path-only editing semantics from the original `edit.task.ts`
 * are preserved: the edit agent must only operate on the declared file
 * paths and must not infer unrelated work. Targets are narrowed to
 * `FileTarget` so every change is bound to one exact path.
 */

// ─── I/O schemas ──────────────────────────────────────────────────

/** Each change is bound to exactly one file path (exact-path-only). */
export const EditChangeSchema = ChangeSchema.extend({
  target: FileTargetSchema,
})

export const CanonicalEditInputSchema = z.object({
  changes: z.array(EditChangeSchema).min(1),
})
/** Legacy array input remains accepted so persisted pre-ctx TaskGraphs can resume. */
export const EditInputSchema = z.union([
  CanonicalEditInputSchema,
  z.array(EditChangeSchema).min(1),
])
export const EditEvidenceSchema = evidenceWith(FileTargetSchema)
export const EditOutputSchema = z.array(EditEvidenceSchema)

export type EditInput = z.infer<typeof EditInputSchema>
export type EditOutput = z.infer<typeof EditOutputSchema>

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'File-level edit executor - apply precise create/update/remove instructions and report changes as evidence.',
    agentRuntime: 'forge/fast',
    permission: 'edit',
    writeTargets: (input: unknown): readonly string[] => {
      const editInput = input as EditInput
      const changes = Array.isArray(editInput) ? editInput : editInput.changes
      return changes.map((change) => change.target.value)
    },
    instructions: [shellUsage],
    input: EditInputSchema,
    output: EditOutputSchema,
    prompt: (input: unknown): string => {
      const editInput = input as EditInput
      const changes = Array.isArray(editInput) ? editInput : editInput.changes
      return `
You are an **Edit Executor**. Apply precise file-level edit instructions and report exactly what changed as evidence.

## Hard Boundary
- Operate only on the exact paths listed in the changes below.
- This is a mechanical edit task. The input and Foreman context are the complete working context: do not read AGENTS.md, README, specs, plans, package manifests, neighboring directories, or unrelated callers to understand the wider project.
- Do not broaden scope, refactor adjacent code, or perform opportunistic cleanup.
- Do not commit.
- For \`remove\`, remove the described code from the file. Delete the whole file only when the instruction explicitly says to delete the file.
- If a change is ambiguous, unsafe, or its target cannot be found, do not guess; report it as evidence with an observation describing why it could not be applied.

## Edit Instructions
${JSON.stringify(changes, null, 2)}

## Workflow
1. Treat exact full target content supplied in Foreman context as an already-completed target read. Otherwise Read each existing target exactly once; a create target needs no read.
2. After those target reads, begin the first Edit/Write immediately. Do not call Glob, Grep, Bash, or read any non-target file before the first mutation.
3. Apply only the declared mechanical changes. Combine compatible changes to the same file into one mutation when safe.
4. Do not run project tests, builds, or broad verification; those belong to an independent test task. A focused diff/check is allowed only after all mutations, and do not re-read a whole file merely to confirm your own edit.
5. Across the task, Read/Glob/Grep calls must not outnumber Edit/Write mutations. Produce one Evidence record per change and report any blocked change as evidence.

## Output Format
Put exactly one JSON array matching the output schema in the Foreman <result> field. Each element is an Evidence record with a file source. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
[
  {
    "id": "change-1",
    "source": { "kind": "file", "value": "relative/path/to/file", "line_range": [start, end] },
    "observation": "what was changed and how it satisfies the instruction"
  }
]
`
    },
  },
  sourcePath: 'lib/standard/tasks/edit.mts',

}

export default definition
