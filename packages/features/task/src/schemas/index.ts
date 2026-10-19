export * from './commit.ts'
export * from './artifacts.ts'

import { z } from 'zod'
import { conceptSchemas } from '../concepts.ts'
import {
  CommitChangeSetSchema, CommitRequestSchema, CommitNumstatRowSchema,
  CommitStatsSchema, CommitInfoSchema, CommitReportSchema,
} from './commit.ts'
import { TaskArtifactSchema, TaskArtifactsSchema } from './artifacts.ts'

/** Schemas available to project-authored tasks; no retired workflow domains. */
export const foremanSchemas = Object.freeze({
  z,
  concepts: conceptSchemas,
  artifact: TaskArtifactSchema,
  artifacts: TaskArtifactsSchema,
  domains: Object.freeze({
    commit: Object.freeze({
      CommitChangeSetSchema, CommitRequestSchema, CommitNumstatRowSchema,
      CommitStatsSchema, CommitInfoSchema, CommitReportSchema,
    }),
  }),
})
export type ForemanSchemas = typeof foremanSchemas
