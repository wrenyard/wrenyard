import type { TaskDefinition } from '../../types.mts'
import { formatTaskContext, type TaskContext } from './context.mts'

export async function buildTaskPrompt(
  definition: TaskDefinition,
  input: unknown,
  ctx?: TaskContext,
  additionalInstructions?: string,
): Promise<string> {
  const config = definition.config
  const parts: string[] = []
  const instructionDocuments: string[] = []
  for (const [index, instruction] of (config.instructions ?? []).entries()) {
    const text = typeof instruction === 'function' ? await instruction(input) : instruction
    if (text.trim()) {
      instructionDocuments.push([
        `<instruction-document source="task.instructions[${index}]" order="${index + 1}">`,
        text,
        '</instruction-document>',
      ].join('\n'))
    }
  }
  if (additionalInstructions?.trim()) {
    // Resolved task settings add an isolated instruction document of their own
    // after every TaskConfig instruction and never replace builtin content.
    instructionDocuments.push([
      `<instruction-document source="task.settings.additionalInstructions" order="${(config.instructions?.length ?? 0) + 1}">`,
      additionalInstructions,
      '</instruction-document>',
    ].join('\n'))
  }
  if (instructionDocuments.length > 0) {
    parts.push([
      '<foreman-system-instructions>',
      '<task-instruction-documents>',
      ...instructionDocuments,
      '</task-instruction-documents>',
      '</foreman-system-instructions>',
    ].join('\n'))
  }
  const contextDocument = formatTaskContext(ctx)
  if (contextDocument) parts.push(contextDocument)
  parts.push(await config.prompt(input))
  return parts.join('\n\n')
}
