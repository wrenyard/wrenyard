import { extname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCAL_MEDIA_EXTENSIONS = new Set([
  '.avi',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webm',
  '.webp',
])

export interface ExtractedMediaAttachment {
  summary: string
  mediaPath: string | null
}

export function extractMediaAttachmentFromSummary(
  summary: string,
  options: { baseDir?: string } = {},
): ExtractedMediaAttachment {
  return {
    summary,
    mediaPath: findFirstLocalMediaLink(summary, options.baseDir),
  }
}

function findFirstLocalMediaLink(markdown: string, baseDir: string | undefined): string | null {
  const linkPattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu
  let match: RegExpExecArray | null
  while ((match = linkPattern.exec(markdown)) !== null) {
    const target = normalizeMarkdownLinkTarget(match[1])
    if (!target || !isLocalMediaTarget(target)) continue

    return resolveLocalMediaTarget(target, baseDir)
  }
  return null
}

function normalizeMarkdownLinkTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim()
  if (!trimmed) return ''

  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>')
    return end > 0 ? trimmed.slice(1, end).trim() : ''
  }

  const firstToken = trimmed.split(/\s+/u)[0]
  return firstToken.replace(/^['"]|['"]$/gu, '')
}

function isLocalMediaTarget(target: string): boolean {
  if (/^(?:https?|mailto|data):/iu.test(target)) return false
  const path = target.startsWith('file://') ? fileURLToPath(target) : target
  return LOCAL_MEDIA_EXTENSIONS.has(extname(path).toLowerCase())
}

function resolveLocalMediaTarget(target: string, baseDir: string | undefined): string {
  const path = target.startsWith('file://') ? fileURLToPath(target) : target
  return isAbsolute(path) ? path : join(baseDir ?? process.cwd(), path)
}
