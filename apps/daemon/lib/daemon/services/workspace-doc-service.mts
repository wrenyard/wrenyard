/**
 * Workspace doc service — daemon-owned document authority for workspace.doc.* methods.
 *
 * Documents are addressed by project, kind and name. The single private
 * resolver maps (project, kind, name) to the one Markdown document under
 * `projects/<project>/docs/<kind>/`; project registration is checked by exact
 * name and the resolved path must stay inside the kind directory.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ProjectManager } from '../../core/project/manager.mts'
import type {
  WorkspaceDocListParams, WorkspaceDocListResult,
  WorkspaceDocReadParams, WorkspaceDocReadResult,
  WorkspaceDocCreateParams, WorkspaceDocCreateResult,
  WorkspaceDocUpdateParams, WorkspaceDocUpdateResult,
  WorkspaceDocEditParams,
  WorkspaceDocDeleteParams, WorkspaceDocDeleteResult,
  WorkspaceDocKind,
} from '../../protocol/methods/workspace-doc.mts'

const MARKDOWN_EXT = '.md'

/** Document kinds mapped to their directory under a project's docs root. */
const DOC_KIND_DIRECTORIES = {
  spec: 'specs',
  report: 'reports',
  handoff: 'handoff',
} as const

/** New document names are created from a short lowercase slug. */
const CREATE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/u

/** Header labels read for the `status` field, as the existing parsing does. */
const STATUS_LABELS = ['状态', 'status'] as const

/** Header labels read for the `updated` field, as the existing parsing does. */
const UPDATED_LABELS = ['更新', '更新时间', 'updated', 'update'] as const

/** Structured failure for document operations, carrying a specific code. */
export class WorkspaceDocError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceDocError'
    this.code = code
  }
}

export class WorkspaceDocService {
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    // Resolve the supplied root once, ensure the directory exists, then
    // canonicalize to handle symlinks (e.g. macOS /var -> /private/var)
    const resolvedRoot = resolve(workspaceRoot)
    mkdirSync(resolvedRoot, { recursive: true })
    this.workspaceRoot = realpathSync(resolvedRoot)
  }

  async listDocuments(params: WorkspaceDocListParams): Promise<WorkspaceDocListResult> {
    const { project } = params
    this.assertKnownProject(project)
    const kinds: WorkspaceDocKind[] = params.kind === undefined
      ? (Object.keys(DOC_KIND_DIRECTORIES) as WorkspaceDocKind[])
      : [params.kind]
    const documents: WorkspaceDocListResult['documents'] = []
    for (const kind of kinds) {
      const directory = resolve(this.workspaceRoot, 'projects', project, 'docs', DOC_KIND_DIRECTORIES[kind])
      if (!existsSync(directory)) continue
      this.assertCanonicalLocation(directory, project, DOC_KIND_DIRECTORIES[kind], 0)
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(MARKDOWN_EXT)) continue
        const name = entry.name.slice(0, -MARKDOWN_EXT.length)
        const content = readFileSync(resolve(directory, entry.name), 'utf-8')
        const status = headerField(content, STATUS_LABELS)
        const updated = headerField(content, UPDATED_LABELS)
        documents.push({
          project,
          kind,
          name,
          title: documentTitle(name, content),
          ...(status ? { status } : {}),
          ...(updated ? { updated } : {}),
        })
      }
    }
    documents.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)))
    return { documents }
  }

  async readDocument(params: WorkspaceDocReadParams): Promise<WorkspaceDocReadResult> {
    const { project, kind, name } = params
    const { absolute } = this.resolveDocument(project, kind, name)
    if (!existsSync(absolute)) {
      throw new WorkspaceDocError('missing', `Document not found: ${project}/${kind}/${name}`)
    }
    if (!lstatSync(absolute).isFile()) {
      throw new WorkspaceDocError('not_a_file', `Document is not a regular document: ${name}`)
    }
    const content = readFileSync(absolute, 'utf-8')
    return {
      project,
      kind,
      name,
      title: documentTitle(name, content),
      content,
      version: docVersion(content),
    }
  }

  async createDocument(params: WorkspaceDocCreateParams): Promise<WorkspaceDocCreateResult> {
    const { project, kind, name, content } = params
    if (!CREATE_SLUG_RE.test(name)) {
      throw new WorkspaceDocError('bad_name', `New document name must be a short lowercase slug: ${name}`)
    }
    const fullName = `${todayLocalDate()}-${name}`
    const { absolute } = this.resolveDocument(project, kind, fullName)
    if (existsSync(absolute)) {
      throw new WorkspaceDocError('exists', `Document already exists: ${fullName}`)
    }
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, { encoding: 'utf-8', flag: 'wx' })
    return {
      project,
      kind,
      name: fullName,
      title: documentTitle(fullName, content),
      change: 'created',
      version: docVersion(content),
    }
  }

  async updateDocument(params: WorkspaceDocUpdateParams): Promise<WorkspaceDocUpdateResult> {
    const { project, kind, name, content, base_version } = params
    const { absolute } = this.resolveDocument(project, kind, name)
    if (!existsSync(absolute)) {
      throw new WorkspaceDocError('missing', `Document not found: ${name}`)
    }
    if (!lstatSync(absolute).isFile()) {
      throw new WorkspaceDocError('not_a_file', `Document is not a regular document: ${name}`)
    }
    const currentContent = readFileSync(absolute, 'utf-8')
    if (docVersion(currentContent) !== base_version) {
      throw new WorkspaceDocError('conflict', `Document changed since it was read: ${name}`)
    }
    writeFileSync(absolute, content, 'utf-8')
    return {
      project,
      kind,
      name,
      title: documentTitle(name, content),
      change: 'updated',
      version: docVersion(content),
    }
  }

  async editDocument(params: WorkspaceDocEditParams): Promise<WorkspaceDocUpdateResult> {
    const { project, kind, name, edits, base_version } = params
    const { absolute } = this.resolveDocument(project, kind, name)
    if (!existsSync(absolute)) {
      throw new WorkspaceDocError('missing', `Document not found: ${name}`)
    }
    if (!lstatSync(absolute).isFile()) {
      throw new WorkspaceDocError('not_a_file', `Document is not a regular document: ${name}`)
    }
    const currentContent = readFileSync(absolute, 'utf-8')
    if (base_version !== undefined && docVersion(currentContent) !== base_version) {
      throw new WorkspaceDocError('conflict', `Document changed since it was read: ${name}`)
    }
    let content = currentContent
    edits.forEach((edit, index) => {
      const occurrences = countOccurrences(content, edit.old)
      if (occurrences === 0) {
        throw new WorkspaceDocError('not_found', `Edit ${index}: the text to replace was not found in ${name}`)
      }
      if (occurrences > 1) {
        throw new WorkspaceDocError('not_unique', `Edit ${index}: the text to replace occurs more than once in ${name}`)
      }
      // Replace literally: a function replacement avoids `$` replacement
      // semantics, so `$&`, `$1`, `$$`, etc. in `new` are written verbatim.
      content = content.replace(edit.old, () => edit.new)
    })
    writeFileSync(absolute, content, 'utf-8')
    return {
      project,
      kind,
      name,
      title: documentTitle(name, content),
      change: 'updated',
      version: docVersion(content),
    }
  }

  async deleteDocument(params: WorkspaceDocDeleteParams): Promise<WorkspaceDocDeleteResult> {
    const { project, kind, name, base_version } = params
    const { absolute } = this.resolveDocument(project, kind, name)
    if (!existsSync(absolute)) {
      throw new WorkspaceDocError('missing', `Document not found: ${name}`)
    }
    // lstat does not follow symlinks: anything that is not a real regular file
    // (a directory, or a symlink of any kind) is refused rather than removed.
    if (!lstatSync(absolute).isFile()) {
      throw new WorkspaceDocError('not_a_file', `Document is not a regular document: ${name}`)
    }
    const currentContent = readFileSync(absolute, 'utf-8')
    if (docVersion(currentContent) !== base_version) {
      throw new WorkspaceDocError('conflict', `Document changed since it was read: ${name}`)
    }
    // Remove exactly the one document; no parent is removed.
    unlinkSync(absolute)
    return { project, kind, name, change: 'deleted', version: base_version }
  }

  /**
   * The single authority for document resolution. The project is looked up by
   * exact name in the registered projects; the kind must be one of the mapped
   * kinds; the name must be a single safe segment; and the resolved document
   * must stay inside `projects/<project>/docs/<kindDir>/`. Every rejection is a
   * WorkspaceDocError with a specific code whose message states the rule.
   */
  private resolveDocument(project: string, kind: WorkspaceDocKind, name: string): { absolute: string; kindDir: string } {
    this.assertKnownProject(project)
    const kindDir = DOC_KIND_DIRECTORIES[kind as WorkspaceDocKind] as string | undefined
    if (!kindDir) {
      throw new WorkspaceDocError(
        'bad_kind',
        `Document kind must be one of ${Object.keys(DOC_KIND_DIRECTORIES).join(', ')}: ${kind}`,
      )
    }
    if (
      name === ''
      || name.includes('/')
      || name.includes('\\')
      || name.includes(':')
      || name.includes('\0')
      || name.startsWith('.')
      || name.split('/').includes('..')
    ) {
      throw new WorkspaceDocError('bad_name', `Document name is not a valid document name: ${name}`)
    }
    const baseDir = resolve(this.workspaceRoot, 'projects', project, 'docs', kindDir)
    const absolute = resolve(baseDir, `${name}${MARKDOWN_EXT}`)
    if (!absolute.startsWith(baseDir + sep)) {
      throw new WorkspaceDocError('outside_workspace', `Document resolves outside its kind: ${name}`)
    }
    // The lexical check above cannot see ancestor symlinks/junctions; the
    // canonical check below refuses any real path that escapes the kind.
    this.assertCanonicalLocation(absolute, project, kindDir, 1)
    return { absolute, kindDir }
  }

  /**
   * Refuse a path whose real location escapes the canonical kind directory.
   * `path` is canonicalized through its nearest existing ancestor (so a
   * not-yet-created document is checked through its existing parent), then its
   * location relative to the canonical workspace root must be exactly
   * `projects/<project>/docs/<kindDir>` followed by `extra` segment(s). This
   * catches ancestor symlink/junction escapes a lexical resolve() misses and
   * never accepts an escaped real kind directory as an authorized root. Only a
   * generic logical error is raised, never a physical path.
   */
  private assertCanonicalLocation(path: string, project: string, kindDir: string, extra: number): void {
    const realPath = canonicalizeNearestExisting(path)
    const rel = relative(this.workspaceRoot, realPath)
    const segments = rel === '' ? [] : rel.split(sep)
    // A project may be nested (e.g. gol/arts), so its registered name can span
    // several path segments; expand it rather than treating it as one segment.
    const expected = ['projects', ...project.split('/'), 'docs', kindDir]
    // Windows filesystems are case-insensitive, so compare segments
    // case-insensitively there; other platforms compare exactly.
    const caseInsensitive = process.platform === 'win32'
    const segmentMatches = (actual: string, want: string): boolean =>
      caseInsensitive ? actual.toLowerCase() === want.toLowerCase() : actual === want
    const contained = !isAbsolute(rel)
      && segments.length === expected.length + extra
      && segments[0] !== '..'
      && expected.every((segment, index) => segmentMatches(segments[index], segment))
    if (!contained) {
      throw new WorkspaceDocError('outside_workspace', 'Document resolves outside its canonical kind directory')
    }
  }

  /** Throw unknown_project unless the exact project name is registered. */
  private assertKnownProject(project: string): void {
    const known = new ProjectManager({ workspaceRoot: this.workspaceRoot })
      .listProjects()
      .some((entry) => entry.name === project)
    if (!known) {
      throw new WorkspaceDocError('unknown_project', `Project is not registered: ${project}`)
    }
  }
}

// Module-level helpers (no instance state needed)

/**
 * Canonicalize a path that may not exist yet. realpathSync requires every
 * segment to exist, so walk up to the nearest existing ancestor, canonicalize
 * it (resolving ancestor symlinks/junctions), then re-append the remaining
 * not-yet-created segments lexically. A dangling-symlink tail is treated as
 * non-existent, exactly like existsSync sees it.
 */
function canonicalizeNearestExisting(absolute: string): string {
  let existing = absolute
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    missing.unshift(basename(existing))
    existing = parent
  }
  const realExisting = realpathSync(existing)
  return missing.length === 0 ? realExisting : resolve(realExisting, ...missing)
}

/** The document title: its first '# ' heading, or the name when absent. */
function documentTitle(name: string, content: string): string {
  const heading = /^# (.+)$/m.exec(content)
  return heading ? heading[1].trim() : name
}

/**
 * Read a header field from a `>` block of a Markdown document, exactly as the
 * existing header-field parsing does. Returns '' when no label matches.
 */
function headerField(content: string, labels: readonly string[]): string {
  for (const line of content.split('\n')) {
    const quoted = /^\s*>\s*(.+)$/u.exec(line)
    if (!quoted) continue
    for (const label of labels) {
      const field = new RegExp(`^${label}\\s*[:：]\\s*(.*)$`, 'iu').exec(quoted[1].trim())
      if (field) return field[1].trim()
    }
  }
  return ''
}

/** Today's local date as YYYY-MM-DD. */
function todayLocalDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** First 8 hex characters of the sha256 of a document's content. */
function docVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 8)
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return haystack.length + 1
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
