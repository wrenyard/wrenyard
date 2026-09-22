export type StructuredOutputErrorKind = 'protocol' | 'json' | 'schema'

export interface StructuredOutputDiagnostic {
  kind: StructuredOutputErrorKind
  message: string
}

export const DELIVERY_START = '<foreman-task-output>'
export const DELIVERY_END = '</foreman-task-output>'
export const SUMMARY_START = '<summary>'
export const SUMMARY_END = '</summary>'
export const RESULT_START = '<result>'
export const RESULT_END = '</result>'

export type ForemanTaskOutputParse =
  | { present: false }
  | { present: true; success: true; summary: string; result: string }
  | { present: true; success: false; diagnostics: StructuredOutputDiagnostic[] }

export function parseForemanTaskOutput(text: string): ForemanTaskOutputParse {
  if (!hasDeliveryWrapperMarker(text)) return { present: false }

  const diagnostics: StructuredOutputDiagnostic[] = []
  const startIndex = text.indexOf(DELIVERY_START)
  if (startIndex === -1) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`missing exact ${DELIVERY_START} start tag`)],
    }
  }

  let cursor = skipWhitespace(text, startIndex + DELIVERY_START.length)
  if (text.startsWith(DELIVERY_START, cursor)) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`multiple ${DELIVERY_START} start tags are not allowed`)],
    }
  }
  if (!text.startsWith(SUMMARY_START, cursor)) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`missing ${SUMMARY_START} section`)],
    }
  }

  const summaryStartIndex = cursor
  const summaryContentStart = cursor + SUMMARY_START.length
  const summaryEndIndex = text.indexOf(SUMMARY_END, summaryContentStart)
  if (summaryEndIndex === -1) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`missing ${SUMMARY_END} closing tag`)],
    }
  }
  const summary = text.slice(summaryContentStart, summaryEndIndex).trim()
  if (!summary) diagnostics.push(protocolDiagnostic(`${SUMMARY_START} content is required`))

  cursor = skipWhitespace(text, summaryEndIndex + SUMMARY_END.length)
  if (text.startsWith(SUMMARY_START, cursor)) {
    diagnostics.push(protocolDiagnostic(`multiple ${SUMMARY_START} sections are not allowed`))
  }
  if (!text.startsWith(RESULT_START, cursor)) {
    diagnostics.push(protocolDiagnostic(`missing ${RESULT_START} section`))
  }
  if (diagnostics.length > 0) return { present: true, success: false, diagnostics }

  const resultStartIndex = cursor
  if (summaryStartIndex > resultStartIndex) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`${SUMMARY_START} must appear before ${RESULT_START}`)],
    }
  }

  cursor = skipWhitespace(text, cursor + RESULT_START.length)
  if (text.startsWith('```', cursor)) {
    return {
      present: true,
      success: false,
      diagnostics: [{
        kind: 'json',
        message: `${RESULT_START} must contain raw JSON only; remove markdown code fences from inside ${RESULT_START}`,
      }],
    }
  }

  const jsonValue = findJsonContainerEnd(text, cursor)
  if (!jsonValue.success) return { present: true, success: false, diagnostics: [jsonValue.diagnostic] }
  const result = text.slice(cursor, jsonValue.endIndex)

  cursor = skipWhitespace(text, jsonValue.endIndex)
  if (!text.startsWith(RESULT_END, cursor)) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`missing ${RESULT_END} closing tag after ${RESULT_START} JSON value`)],
    }
  }

  cursor = skipWhitespace(text, cursor + RESULT_END.length)
  if (!text.startsWith(DELIVERY_END, cursor)) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`missing ${DELIVERY_END} closing tag after ${RESULT_END}`)],
    }
  }

  cursor = skipWhitespace(text, cursor + DELIVERY_END.length)
  if (text.startsWith(DELIVERY_START, cursor)) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`multiple complete ${DELIVERY_START} delivery blocks are not allowed`)],
    }
  }
  if (text.indexOf(DELIVERY_START, cursor) !== -1) {
    return {
      present: true,
      success: false,
      diagnostics: [protocolDiagnostic(`multiple complete ${DELIVERY_START} delivery blocks are not allowed`)],
    }
  }

  return {
    present: true,
    success: true,
    summary,
    result,
  }
}

export function extractForemanTaskOutputSummary(output: string | null | undefined): string | undefined {
  const text = output?.trim()
  if (!text) return undefined
  const parsed = parseForemanTaskOutput(text)
  return parsed.present && parsed.success ? parsed.summary : undefined
}

export function protocolDiagnostic(message: string): StructuredOutputDiagnostic {
  return { kind: 'protocol', message }
}

type JsonContainerScan =
  | { success: true; endIndex: number }
  | { success: false; diagnostic: StructuredOutputDiagnostic }

function findJsonContainerEnd(text: string, startIndex: number): JsonContainerScan {
  if (text[startIndex] !== '{' && text[startIndex] !== '[') {
    return {
      success: false,
      diagnostic: {
        kind: 'json',
        message: `${RESULT_START} content must begin with a JSON object or array`,
      },
    }
  }

  const expectedClosers: string[] = []
  let inString = false
  let escaped = false

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      expectedClosers.push('}')
      continue
    }
    if (char === '[') {
      expectedClosers.push(']')
      continue
    }
    if (char !== '}' && char !== ']') continue

    const expected = expectedClosers[expectedClosers.length - 1]
    if (!expected) {
      return {
        success: false,
        diagnostic: { kind: 'json', message: `${RESULT_START} JSON value has an unexpected ${char}` },
      }
    }
    if (char !== expected) {
      return {
        success: false,
        diagnostic: { kind: 'json', message: `${RESULT_START} JSON value has mismatched ${char}; expected ${expected}` },
      }
    }

    expectedClosers.pop()
    if (expectedClosers.length === 0) return { success: true, endIndex: index + 1 }
  }

  return {
    success: false,
    diagnostic: { kind: 'json', message: `${RESULT_START} JSON value is unterminated` },
  }
}

function skipWhitespace(text: string, startIndex: number): number {
  let index = startIndex
  while (index < text.length && /\s/u.test(text[index])) index += 1
  return index
}

function hasDeliveryWrapperMarker(text: string): boolean {
  if (text.startsWith('{')) return false
  return /<\/?foreman-task-output\b/u.test(text)
}
