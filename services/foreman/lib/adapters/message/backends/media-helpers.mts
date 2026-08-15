import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { extname, join, parse } from 'node:path'

export const MAX_TELEGRAM_MEDIA_BYTES = 5 * 1024 * 1024
const TARGET_TELEGRAM_MEDIA_BYTES = Math.floor(MAX_TELEGRAM_MEDIA_BYTES * 0.96)
const MEDIA_COMMAND_TIMEOUT_MS = 120_000
const VIDEO_BITRATE_SAFETY_RATIO = 0.94
const MIN_VIDEO_BITRATE_KBPS = 64

const VIDEO_MEDIA_EXTENSIONS = new Set(['.avi', '.gif', '.m4v', '.mkv', '.mov', '.mp4', '.webm'])
const IMAGE_MEDIA_EXTENSIONS = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp'])

export async function prepareMediaForTelegram(mediaPath: string): Promise<string> {
  const mediaSize = statSync(mediaPath).size
  if (mediaSize <= MAX_TELEGRAM_MEDIA_BYTES) return mediaPath
  const extension = extname(mediaPath).toLowerCase()
  if (VIDEO_MEDIA_EXTENSIONS.has(extension)) {
    return compressVideoForTelegram(mediaPath)
  }
  if (IMAGE_MEDIA_EXTENSIONS.has(extension)) {
    return compressImageForTelegram(mediaPath)
  }
  return mediaPath
}

interface TargetVideoBitrateInput {
  durationSeconds: number
  maxBytes?: number
}

export function targetVideoBitrateKbps(input: TargetVideoBitrateInput): number {
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new Error(`Invalid video duration: ${input.durationSeconds}`)
  }
  const maxBytes = input.maxBytes ?? MAX_TELEGRAM_MEDIA_BYTES
  const targetBytes = Math.min(TARGET_TELEGRAM_MEDIA_BYTES, Math.floor(maxBytes * 0.96))
  const targetKbps = Math.floor((targetBytes * 8 * VIDEO_BITRATE_SAFETY_RATIO) / input.durationSeconds / 1000)
  return Math.max(MIN_VIDEO_BITRATE_KBPS, targetKbps)
}

function compressedMediaPath(mediaPath: string, suffix: string, extension: string): string {
  const parsed = parse(mediaPath)
  const outputDir = join(parse(mediaPath).dir, '.foreman-telegram')
  mkdirSync(outputDir, { recursive: true })
  return join(outputDir, `${parsed.name}${suffix}${extension}`)
}

function commandOutput(binary: string, args: string[], errorPrefix: string): string {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MEDIA_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }).trim()
  } catch (error) {
    throw new Error(`${errorPrefix} failed: ${commandErrorDetail(error)}`)
  }
}

function runMediaCommand(binary: string, args: string[], errorPrefix: string): void {
  try {
    execFileSync(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MEDIA_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(`${errorPrefix} failed: ${commandErrorDetail(error)}`)
  }
}

function commandErrorDetail(error: unknown): string {
  const maybeError = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string }
  const output = [maybeError.stderr, maybeError.stdout]
    .map((chunk) => Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    .filter((chunk): chunk is string => Boolean(chunk?.trim()))
    .join('\n')
    .trim()
  return output || maybeError.message || String(error)
}

function mediaFileSize(mediaPath: string): number {
  return statSync(mediaPath).size
}

function probeVideoDurationSeconds(mediaPath: string): number {
  const durationText = commandOutput('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    mediaPath,
  ], 'ffprobe video duration')
  const durationSeconds = Number.parseFloat(durationText)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not read video duration for ${mediaPath}`)
  }
  return durationSeconds
}

function compressVideoForTelegram(mediaPath: string): string {
  const durationSeconds = probeVideoDurationSeconds(mediaPath)
  let bitrateKbps = targetVideoBitrateKbps({ durationSeconds })
  let lastOutputPath: string | null = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const outputPath = compressedMediaPath(mediaPath, `-telegram-${bitrateKbps}k`, '.mp4')
    runMediaCommand('ffmpeg', [
      '-y', '-i', mediaPath,
      '-map', '0:v:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', `${bitrateKbps}k`,
      '-maxrate', `${bitrateKbps}k`,
      '-bufsize', `${bitrateKbps * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      outputPath,
    ], 'ffmpeg video compression')
    if (mediaFileSize(outputPath) <= MAX_TELEGRAM_MEDIA_BYTES) return outputPath
    lastOutputPath = outputPath
    bitrateKbps = Math.max(MIN_VIDEO_BITRATE_KBPS, Math.floor(bitrateKbps * 0.82))
  }
  throw new Error(`Compressed video still exceeds 5MB: ${lastOutputPath ?? mediaPath}`)
}

function compressImageForTelegram(mediaPath: string): string {
  const attempts = [
    { quality: 3, maxSide: null as number | null },
    { quality: 5, maxSide: 2560 },
    { quality: 8, maxSide: 1920 },
    { quality: 12, maxSide: 1600 },
    { quality: 18, maxSide: 1280 },
    { quality: 24, maxSide: 1024 },
  ]
  let lastOutputPath: string | null = null
  for (const attempt of attempts) {
    const outputPath = compressedMediaPath(
      mediaPath,
      attempt.maxSide ? `-telegram-q${attempt.quality}-${attempt.maxSide}` : `-telegram-q${attempt.quality}`,
      '.jpg',
    )
    const args = ['-y', '-i', mediaPath, '-frames:v', '1', '-q:v', String(attempt.quality)]
    if (attempt.maxSide) {
      args.push('-vf', `scale=min(${attempt.maxSide}\\,iw):min(${attempt.maxSide}\\,ih):force_original_aspect_ratio=decrease`)
    }
    args.push(outputPath)
    runMediaCommand('ffmpeg', args, 'ffmpeg image compression')
    if (mediaFileSize(outputPath) <= MAX_TELEGRAM_MEDIA_BYTES) return outputPath
    lastOutputPath = outputPath
  }
  throw new Error(`Compressed image still exceeds 5MB: ${lastOutputPath ?? mediaPath}`)
}
