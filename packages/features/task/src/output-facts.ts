import type { TaskRunFacts } from '@wrenyard/protocol/task'

/** Maps daemon-collected facts to top-level output fields; mapped values may be nested. */
export type TaskOutputFactsMapper = (
  facts: Readonly<TaskRunFacts>,
) => Readonly<Record<string, unknown>>
