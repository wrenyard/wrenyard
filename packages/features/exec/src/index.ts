/**
 * Raw prompt-execution feature.
 *
 * See README.md for the raw-prompt versus structured-task distinction.
 */
export { ExecService } from './service.ts'
export type { ExecHandle, ExecRequest, ExecServiceOptions } from './service.ts'
export { ExecReplayBuffer, estimateBytes } from './replay.ts'
export type { ExecReplayBufferOptions, ExecReplayEviction, ExecReplayResult } from './replay.ts'
export type { ExecutionFeature, McpServer } from '@wrenyard/agent-client'
