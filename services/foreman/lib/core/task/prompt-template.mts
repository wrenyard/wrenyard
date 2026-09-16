import { AsyncLocalStorage } from 'node:async_hooks'

/** Static prompt fragments shared by execution and non-executing previews. */
export interface TaskPromptTemplate {
  readonly strings: readonly string[]
  readonly labels?: readonly string[]
  readonly label?: string
}

const metadata = new WeakMap<Function, readonly TaskPromptTemplate[]>()

/**
 * Collects one execution prompt build: the placeholders emitted for static
 * template values and those values themselves, in capture order.
 */
export interface TaskPromptCapture {
  readonly placeholders: string[]
  readonly values: unknown[]
}

const captureStore = new AsyncLocalStorage<TaskPromptCapture>()

export function renderTaskPromptTemplate(template: TaskPromptTemplate, values: readonly unknown[]): string {
  if (template.strings.length !== values.length + 1) throw new Error('Task prompt template arity mismatch')
  const capture = captureStore.getStore()
  if (capture) {
    return renderWithPlaceholders(capture, template, values)
  }
  return values.reduce<string>(
    (text, value, index) => text + String(value) + (template.strings[index + 1] ?? ''),
    template.strings[0] ?? '',
  )
}

/**
 * Render stable labeled placeholders instead of dynamic substitutions. The
 * static fragments are emitted untouched, so every builtin shares a
 * byte-identical prefix; the original values are recorded once, in order.
 */
function renderWithPlaceholders(
  capture: TaskPromptCapture,
  template: TaskPromptTemplate,
  values: readonly unknown[],
): string {
  let text = template.strings[0] ?? ''
  for (const [index, value] of values.entries()) {
    const placeholder = placeholderFor(template, index, capture.placeholders.length)
    capture.values.push(value)
    capture.placeholders.push(placeholder)
    text += placeholder + (template.strings[index + 1] ?? '')
  }
  return text
}

function placeholderFor(template: TaskPromptTemplate, valueIndex: number, ordinal: number): string {
  const label = template.labels?.[valueIndex] ?? (template.labels ? '' : template.label ?? '')
  return `[[task-prompt:${sanitize(label)}:${ordinal}]]`
}

/**
 * Run `build` with scoped placeholder rendering and collect its values. Calls
 * made outside this scope (previews, direct rendering, unit tests) keep the
 * existing dynamic rendering behavior. The scope is storage-local, so
 * concurrent and interleaved async builds never share placeholders or values.
 */
export function runWithTaskPromptCapture<T>(build: () => T): { capture: TaskPromptCapture; result: T } {
  const capture: TaskPromptCapture = { placeholders: [], values: [] }
  return { capture, result: captureStore.run(capture, build) }
}

/**
 * Concise instruction appended with the captured values, explaining how the
 * reader resolves the placeholders left in the static instructions above.
 */
export const TASK_PROMPT_PLACEHOLDER_NOTICE = [
  '## Placeholder Bindings',
  'The static instructions above keep stable `[[task-prompt:<label>:<index>]]` placeholders so they stay identical across tasks.',
  'Each placeholder was filled at render time by the original value bound to it during assembly; those original values are listed in order in the `task-input-bindings` block below, matched by index. Read each placeholder as replaced by its listed value; do not treat the placeholder token itself as content.',
].join('\n')

/**
 * Render captured values as the prompt "parameter tail". Values stay complete:
 * a closing wrapper tag inside a value is escaped rather than dropped.
 */
export function renderTaskPromptBindings(capture: TaskPromptCapture): string {
  if (capture.placeholders.length === 0) return ''
  const bindings = capture.placeholders.map(
    (placeholder, index) => `${placeholder} =\n${escapeClosingWrapperTag(String(capture.values[index]))}`,
  )
  return ['<task-input-bindings>', ...bindings, '</task-input-bindings>'].join('\n')
}

function sanitize(label: string): string {
  return label.replaceAll(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
}

/** Escape a closing wrapper tag so captured content cannot terminate its wrapper. */
function escapeClosingWrapperTag(value: string): string {
  return value.replaceAll('</task-input-bindings>', '<\\/task-input-bindings>')
}

export function withTaskPromptTemplates<T extends Function>(prompt: T, templates: readonly TaskPromptTemplate[]): T {
  metadata.set(prompt, templates)
  return prompt
}

/** Only explicit metadata is read. Never call, stringify or inspect the prompt function. */
export function getTaskPromptTemplates(prompt: unknown): readonly TaskPromptTemplate[] {
  return typeof prompt === 'function' ? metadata.get(prompt) ?? [] : []
}
