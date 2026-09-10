/** Static prompt fragments shared by execution and non-executing previews. */
export interface TaskPromptTemplate {
  readonly strings: readonly string[]
  readonly labels?: readonly string[]
  readonly label?: string
}

const metadata = new WeakMap<Function, readonly TaskPromptTemplate[]>()

export function renderTaskPromptTemplate(template: TaskPromptTemplate, values: readonly unknown[]): string {
  if (template.strings.length !== values.length + 1) throw new Error('Task prompt template arity mismatch')
  return template.strings.reduce((text, fragment, index) => text + (index === 0 ? '' : String(values[index - 1])) + fragment, '')
}

export function withTaskPromptTemplates<T extends Function>(prompt: T, templates: readonly TaskPromptTemplate[]): T {
  metadata.set(prompt, templates)
  return prompt
}

/** Only explicit metadata is read. Never call, stringify or inspect the prompt function. */
export function getTaskPromptTemplates(prompt: unknown): readonly TaskPromptTemplate[] {
  return typeof prompt === 'function' ? metadata.get(prompt) ?? [] : []
}
