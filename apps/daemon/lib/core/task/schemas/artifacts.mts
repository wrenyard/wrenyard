import { isAbsolute } from 'node:path'
import { z } from 'zod'

/**
 * Task artifact schemas (Zod 4).
 *
 * A task may declare an optional bounded `artifacts` array on its output.
 * Each entry describes one generated file the task wants to report (for
 * example a screenshot). The runtime collects those files from a per-run
 * artifact directory and validates them before the task output is persisted
 * (see `core/task/artifacts.mts`).
 *
 * Field shape (strict, no extra fields):
 *   - `path`        non-empty absolute filesystem path (platform-aware)
 *   - `kind`        `image` | `file`
 *   - `role`        non-empty bounded short role label
 *   - `description` bounded human-readable description
 */

export const MAX_TASK_ARTIFACTS = 128
const MAX_ARTIFACT_PATH_LENGTH = 4096
const MAX_ARTIFACT_ROLE_LENGTH = 100
const MAX_ARTIFACT_DESCRIPTION_LENGTH = 2000

export const TaskArtifactSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(MAX_ARTIFACT_PATH_LENGTH)
      .refine(isAbsolute, { message: 'artifact path must be absolute' }),
    kind: z.enum(['image', 'file']),
    role: z.string().min(1).max(MAX_ARTIFACT_ROLE_LENGTH),
    description: z.string().max(MAX_ARTIFACT_DESCRIPTION_LENGTH),
  })
  .strict()

export type TaskArtifact = z.infer<typeof TaskArtifactSchema>

/** Bounded artifact array. Optional at the task output field. */
export const TaskArtifactsSchema = z.array(TaskArtifactSchema).max(MAX_TASK_ARTIFACTS)
export type TaskArtifacts = z.infer<typeof TaskArtifactsSchema>
