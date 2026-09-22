import type { TaskDefinition } from '../../types.mts'
import { formatTaskContext, type TaskContext } from './context.mts'
import {
  getTaskPromptTemplates,
  renderTaskPromptBindings,
  runWithTaskPromptCapture,
  TASK_PROMPT_PLACEHOLDER_NOTICE,
} from './prompt-template.mts'

/** Stable instruction/template prefix first; dynamic documents, bindings and ctx last. */
export async function buildTaskPrompt(
  definition: TaskDefinition,
  input: unknown,
  ctx?: TaskContext,
): Promise<string> {
  const config = definition.config
  const hasTemplates = getTaskPromptTemplates(config.prompt).length > 0

  // One capture scope spans the static instruction documents and the prompt
  // body, because both render templates for the same build. Dynamic instruction
  // functions run after the scope closes so their own renders cannot leak into
  // this build's placeholders.
  const { capture, result: build } = runWithTaskPromptCapture(async () => {
    const documents: Array<{ index: number; text: string }> = []
    for (const [index, instruction] of (config.instructions ?? []).entries()) {
      if (hasTemplates && typeof instruction === 'function') continue
      const text = typeof instruction === 'function' ? await instruction(input) : instruction
      if (typeof text === 'string' && text.trim()) documents.push({ index, text })
    }
    return { documents, promptBody: await config.prompt(input) }
  })
  const { documents, promptBody } = await build

  // Layering: static wy-system (documents + instruction body) first, then the
  // per-run dynamic documents, bindings and context last.
  const systemParts: string[] = []
  if (documents.length > 0) {
    systemParts.push([
      '<wy-ctx-doc>',
      ...documents.map((document) => renderInstructionDocument(document.index, document.text)),
      '</wy-ctx-doc>',
    ].join('\n'))
  }

  const dynamicDocuments: string[] = []
  if (hasTemplates) {
    for (const [index, instruction] of (config.instructions ?? []).entries()) {
      if (typeof instruction !== 'function') continue
      const text = await instruction(input)
      if (typeof text === 'string' && text.trim()) {
        dynamicDocuments.push(renderInstructionDocument(index, text))
      }
    }
  }

  systemParts.push([
    '<wy-instruction>',
    promptBody,
    '</wy-instruction>',
  ].join('\n'))

  const parts: string[] = [
    ['<wy-system>', ...systemParts, '</wy-system>'].join('\n'),
  ]
  if (capture.placeholders.length > 0) parts.push(TASK_PROMPT_PLACEHOLDER_NOTICE)
  if (dynamicDocuments.length > 0) parts.push(['<wy-ctx-doc>', ...dynamicDocuments, '</wy-ctx-doc>'].join('\n'))
  if (capture.placeholders.length > 0) parts.push(renderTaskPromptBindings(capture))

  const contextDocument = formatTaskContext(ctx)
  if (contextDocument) parts.push(contextDocument)
  return parts.join('\n\n')
}

function renderInstructionDocument(index: number, text: string): string {
  return [
    `<wy-doc source="task.instructions[${index}]" order="${index + 1}">`,
    text,
    '</wy-doc>',
  ].join('\n')
}
