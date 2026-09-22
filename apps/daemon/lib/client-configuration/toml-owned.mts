export interface OwnedTomlState {
  topLevel: Record<string, string | null>
  tables: Record<string, string | null>
}

interface LineRange {
  start: number
  end: number
}

function lines(content: string): string[] {
  return content.match(/.*(?:\r?\n|$)/g)?.filter((line) => line.length > 0) ?? []
}

function tableRanges(content: string): Map<string, LineRange> {
  const source = lines(content)
  const ranges = new Map<string, LineRange>()
  let current: { header: string; start: number } | undefined
  for (let index = 0; index < source.length; index += 1) {
    const trimmed = source[index].trim()
    if (!/^\[[^\]]+\]$/.test(trimmed)) continue
    if (current) ranges.set(current.header, { start: current.start, end: index })
    if (ranges.has(trimmed)) throw new Error(`duplicate TOML table: ${trimmed}`)
    current = { header: trimmed, start: index }
  }
  if (current) ranges.set(current.header, { start: current.start, end: source.length })
  return ranges
}

function topLevelRanges(content: string): Map<string, LineRange> {
  const source = lines(content)
  const ranges = new Map<string, LineRange>()
  for (let index = 0; index < source.length; index += 1) {
    const trimmed = source[index].trim()
    if (trimmed.startsWith('[')) break
    const match = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed)
    if (!match) continue
    if (ranges.has(match[1])) throw new Error(`duplicate top-level TOML key: ${match[1]}`)
    ranges.set(match[1], { start: index, end: index + 1 })
  }
  return ranges
}

function sliceRange(content: string, range: LineRange | undefined): string | null {
  if (!range) return null
  return lines(content).slice(range.start, range.end).join('').replace(/\r?\n+$/, '')
}

export function snapshotOwnedToml(
  content: string,
  topLevelKeys: readonly string[],
  tableHeaders: readonly string[],
): OwnedTomlState {
  const top = topLevelRanges(content)
  const tables = tableRanges(content)
  return {
    topLevel: Object.fromEntries(topLevelKeys.map((key) => [key, sliceRange(content, top.get(key))])),
    tables: Object.fromEntries(tableHeaders.map((header) => [header, sliceRange(content, tables.get(header))])),
  }
}

function applyRanges(content: string, replacements: ReadonlyMap<LineRange, string | null>): string {
  const source = lines(content)
  const ordered = [...replacements.entries()].sort(([a], [b]) => b.start - a.start)
  for (const [range, value] of ordered) {
    source.splice(range.start, range.end - range.start, ...(value === null ? [] : [`${value.replace(/\r?\n+$/, '')}\n`]))
  }
  return source.join('')
}

function ensureTrailingNewline(content: string): string {
  return content.length === 0 || content.endsWith('\n') ? content : `${content}\n`
}

export function patchOwnedToml(content: string, desired: OwnedTomlState): string {
  let next = content
  const currentTop = topLevelRanges(next)
  const topReplacements = new Map<LineRange, string | null>()
  const missingTop: string[] = []
  for (const [key, value] of Object.entries(desired.topLevel)) {
    const range = currentTop.get(key)
    if (range) topReplacements.set(range, value)
    else if (value !== null) missingTop.push(value)
  }
  next = applyRanges(next, topReplacements)
  if (missingTop.length > 0) {
    const source = lines(next)
    const firstTable = source.findIndex((line) => line.trim().startsWith('['))
    const insertion = missingTop.map((line) => `${line.replace(/\r?\n+$/, '')}\n`)
    if (firstTable < 0) source.push(...insertion)
    else source.splice(firstTable, 0, ...insertion)
    next = source.join('')
  }

  const currentTables = tableRanges(next)
  const tableReplacements = new Map<LineRange, string | null>()
  const missingTables: string[] = []
  for (const [header, value] of Object.entries(desired.tables)) {
    const range = currentTables.get(header)
    if (range) tableReplacements.set(range, value)
    else if (value !== null) missingTables.push(value)
  }
  next = applyRanges(next, tableReplacements)
  for (const block of missingTables) {
    if (next.length > 0 && !next.endsWith('\n')) next += '\n'
    if (next.trim().length > 0 && !next.endsWith('\n\n')) next += '\n'
    next += `${block.replace(/\r?\n+$/, '')}\n`
  }
  return ensureTrailingNewline(next)
}

export function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}
