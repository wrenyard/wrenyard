/**
 * Native Forge-to-LangChain ChatModel adapter for OpenAI-compatible raw chat completions.
 * Serializes LangChain messages and bound tools into a raw request body, calls
 * the existing Forge raw LLM client with protocol=openai, parses assistant content
 * and tool_calls into LangChain AIMessage tool_calls.
 */

import { AIMessage, BaseMessage, ChatMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { ChatResult, ChatGeneration } from '@langchain/core/outputs'
import { BaseChatModel, type BaseChatModelCallOptions, type BaseChatModelParams } from '@langchain/core/language_models/chat_models'
import type { BaseMessageLike } from '@langchain/core/messages'
import { RunnableBinding } from '@langchain/core/runnables'
import type { BindToolsInput } from '@langchain/core/language_models/chat_models'
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'

// -- Forge call-options type --

export interface ForgeCallOptions extends BaseChatModelCallOptions {
  tools?: BindToolsInput[]
}

// -- Raw Forge LLM executor interface (injectable for tests) --

export interface RawForgeExecutor {
  (params: {
    protocol: 'openai'
    model: string
    messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>
    tools?: unknown[]
    max_tokens?: number
    temperature?: number
    timeout_ms?: number
    max_retries?: number
    retry_backoff_ms?: number
  }): Promise<{
    choices: Array<{
      index: number
      message: {
        role: string
        content: string | null
        tool_calls?: Array<{
          id: string
          type: string
          function: { name: string; arguments: string }
        }>
      }
      finish_reason: string
    }>
    /** Optional OpenAI-compatible token usage reported by the runtime. */
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  }>
}

// -- Model config --

export interface ForgeChatModelConfig {
  model: string
  turnTimeoutMs: number
  httpTimeoutMs?: number
  maxRetries?: number
  retryBackoffMs?: number
}

// -- Adapter --

export interface ForgeChatModelOptions extends BaseChatModelParams {
  config: ForgeChatModelConfig
  /** Injectable raw executor for deterministic tests. */
  rawExecutor: RawForgeExecutor
}

export class ForgeChatModel extends BaseChatModel<ForgeCallOptions> {
  private readonly config: ForgeChatModelConfig
  private readonly rawExecutor: RawForgeExecutor
  constructor(options: ForgeChatModelOptions) {
    super(options)
    this.config = options.config
    if (typeof options.rawExecutor !== 'function') {
      throw new Error('ForgeChatModel: rawExecutor is required and must be a function')
    }
    this.rawExecutor = options.rawExecutor
  }

  _llmType(): string {
    return 'foreman-forge'
  }

  bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ForgeCallOptions>,
  ) {
    return new RunnableBinding({
      bound: this,
      kwargs: { tools, ...kwargs },
      config: {},
    })
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const rawMessages = messages.map(serializeMessage)
    const rawTools = (options.tools as BindToolsInput[] | undefined)?.length
      ? (options.tools as BindToolsInput[]).map(serializeTool)
      : undefined

    let response
    let timeoutHandle: NodeJS.Timeout | undefined
    try {
      const timeoutMs = this.config.turnTimeoutMs
      const executorPromise = this.rawExecutor({
        protocol: 'openai',
        model: this.config.model,
        messages: rawMessages,
        ...(this.config.httpTimeoutMs !== undefined ? { timeout_ms: this.config.httpTimeoutMs } : {}),
        ...(this.config.maxRetries !== undefined ? { max_retries: this.config.maxRetries } : {}),
        ...(this.config.retryBackoffMs !== undefined ? { retry_backoff_ms: this.config.retryBackoffMs } : {}),
        ...(rawTools ? { tools: rawTools } : {}),
      })
      if (timeoutMs > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`ForgeChatModel raw executor timed out after ${timeoutMs}ms`))
          }, timeoutMs)
          timeoutHandle.unref()
        })
        response = await Promise.race([executorPromise, timeoutPromise])
      } else {
        response = await executorPromise
      }
    } catch (error) {
      throw new Error(`ForgeChatModel raw executor error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    if (!response.choices?.length) {
      throw new Error('ForgeChatModel: empty choices from raw executor')
    }

    const choice = response.choices[0]
    const msg = choice.message

    // Surface runtime token usage (when provided) via AIMessage usage_metadata
    // so the turn runtime can report per-turn metrics. Absent when the runtime
    // does not return usage — never fabricated here.
    const usage = response.usage
    const usageMetadata = usage && (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number')
      ? {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      }
      : undefined

    const generations: ChatGeneration[] = []

    if (msg.tool_calls?.length) {
      generations.push({
        text: msg.content ?? '',
        message: new AIMessage({
          content: msg.content ?? '',
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'tool_call' as const,
            name: tc.function.name,
            args: (() => {
              const parsed = JSON.parse(tc.function.arguments);
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error(`ForgeChatModel: tool call arguments must be a non-null object`);
              }
              return parsed;
            })(),
          })),
          ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
        }),
      })
    } else {
      generations.push({
        text: msg.content ?? '',
        message: new AIMessage({
          content: msg.content ?? '',
          ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
        }),
      })
    }

    return { generations }
  }

}

// -- Message serialization helpers --

function serializeMessage(msg: BaseMessageLike): { role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] } {
  if (msg instanceof HumanMessage) {
    return { role: 'user', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }
  }
  if (msg instanceof AIMessage) {
    const result: { role: 'assistant'; content: string; tool_calls?: unknown[] } = {
      role: 'assistant',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    }
    if (msg.tool_calls?.length) {
      result.tool_calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
        },
      }))
    }
    return result
  }
  if (msg instanceof SystemMessage) {
    return { role: 'system', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }
  }
  if (msg instanceof ToolMessage) {
    return { role: 'tool', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content), tool_call_id: msg.tool_call_id }
  }
  if (msg instanceof ChatMessage) {
    return { role: msg.role ?? 'user', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }
  }
  // Fallback for plain object messages
  const dict = msg as Record<string, unknown>
  return {
    role: (dict.role as string) ?? 'user',
    content: typeof dict.content === 'string' ? dict.content : JSON.stringify(dict.content),
    ...(dict.tool_call_id ? { tool_call_id: dict.tool_call_id as string } : {}),
  }
}

function serializeTool(tool: BindToolsInput): unknown {
  const candidate = tool as Record<string, unknown>
  // Preserve already-formatted OpenAI function definitions
  if (candidate.type === 'function' && candidate.function && typeof candidate.function === 'object') {
    return tool
  }
  // Use LangChain's convertToOpenAITool for StructuredTool / DynamicStructuredTool
  // which converts Zod schemas into valid JSON Schema parameters
  return convertToOpenAITool(tool)
}
