import { runForgeLlm } from '../../adapters/forge/llm-client.mts'
import type { RawForgeExecutor } from '../../core/fwa/forge-chat-model.mts'

export function createFwaRawExecutor(
  runLlm: typeof runForgeLlm = runForgeLlm,
): RawForgeExecutor {
  return async (params) => {
    const {
      protocol: _protocol,
      timeout_ms,
      max_retries,
      retry_backoff_ms,
      ...body
    } = params
    body.model = upstreamModelId(params.model)
    const stdout = await runLlm(body, {
      protocol: 'openai',
      model: params.model,
      timeoutMs: timeout_ms,
      maxRetries: max_retries,
      retryBackoffMs: retry_backoff_ms,
    })
    const parsed = JSON.parse(stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`ForgeChatModel raw executor: invalid non-object response: ${stdout.slice(0, 200)}`)
    }
    return parsed as Awaited<ReturnType<RawForgeExecutor>>
  }
}

function upstreamModelId(canonicalModel: string): string {
  const separator = canonicalModel.indexOf('/')
  if (separator <= 0 || separator === canonicalModel.length - 1) {
    return canonicalModel
  }
  return canonicalModel.slice(separator + 1)
}
