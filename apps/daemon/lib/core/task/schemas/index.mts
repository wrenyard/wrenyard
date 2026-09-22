export * from './commit.mts'

import { z } from 'zod'
import { conceptSchemas } from '../concepts.mts'
import {
  CommitChangeSetSchema, CommitRequestSchema, CommitNumstatRowSchema,
  CommitStatsSchema, CommitInfoSchema, CommitReportSchema,
} from './commit.mts'

/** Schemas available to project-authored tasks; no retired workflow domains. */
export const foremanSchemas = Object.freeze({
  z,
  concepts: conceptSchemas,
  domains: Object.freeze({
    commit: Object.freeze({
      CommitChangeSetSchema, CommitRequestSchema, CommitNumstatRowSchema,
      CommitStatsSchema, CommitInfoSchema, CommitReportSchema,
    }),
  }),
})
export type ForemanSchemas = typeof foremanSchemas
