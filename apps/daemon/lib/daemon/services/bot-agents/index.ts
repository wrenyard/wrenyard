/**
 * Bot agent module surface.
 *
 * The directory loader and identity handling from `config.mts`, and the kernel
 * that assembles a bot from those definitions, are the backend an `agent.*`
 * handler needs.
 */

export {
  AGENT_TOOL_NAMES,
  assertBotIdAvailable,
  assertRealInside,
  createBotDirectory,
  formatIdentity,
  isBotId,
  isContained,
  listMemoryFiles,
  loadBotAgents,
  parseIdentity,
  validateConfig,
  type AgentBotLocation,
  type AgentMemoryFile,
  type AgentToolName,
  type BotAgentChangeSet,
  type BotAgentConfig,
  type BotAgentEntry,
  type BotAgentIdentity,
  type BotAgentRoots,
  type BotAgentScan,
} from './config.mts'
export {
  BotAgentError,
  createBotAgentKernel,
  type AgentBotSummary,
  type BotAgentKernel,
  type CreateBotAgentKernelOptions,
  type GroupEventsInput,
  type GroupEventsPage,
  type GroupSendResult,
  type GroupState,
  type GroupTranscriptEntry,
} from './kernel.mts'
