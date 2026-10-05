export * from './commit.mts'
export * from './artifacts.mts'

import { z } from 'zod'
import { conceptSchemas } from '../concepts.mts'
import {
  CommitChangeSetSchema, CommitRequestSchema, CommitNumstatRowSchema,
  CommitStatsSchema, CommitInfoSchema, CommitReportSchema,
} from './commit.mts'
import { TaskArtifactSchema, TaskArtifactsSchema } from './artifacts.mts'

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
