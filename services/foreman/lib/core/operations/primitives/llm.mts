import type { LlmInput, LlmOpts } from '../../../types.mts'

export type LlmPrimitive = (input: LlmInput, opts?: LlmOpts) => Promise<string | unknown>

let llmPrimitive: LlmPrimitive | undefined

export function setLlmPrimitive(implementation: LlmPrimitive | undefined): void {
  llmPrimitive = implementation
}

export function getLlmPrimitive(): LlmPrimitive {
  if (!llmPrimitive) {
    throw new Error(
      'LLM primitive has not been injected. Foreman runtime must inject an LLM implementation before using llm().',
    )
  }
  return llmPrimitive
}

export function createLlmPrimitive(implementation: LlmPrimitive): LlmPrimitive {
  return (input, opts = {}) => implementation(input, opts)
}

export async function llm(input: LlmInput, opts: LlmOpts = {}): Promise<string | unknown> {
  return getLlmPrimitive()(input, opts)
}
