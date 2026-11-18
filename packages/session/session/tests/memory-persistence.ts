import {
  MemorySessionPersistence,
  type SessionEventBase,
  type SessionSummaryBase,
} from '../src/index.ts';

export function createMemoryPersistence<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
>(options?: { now?: () => Date }): MemorySessionPersistence<E, TSummary> {
  return new MemorySessionPersistence<E, TSummary>(options);
}
