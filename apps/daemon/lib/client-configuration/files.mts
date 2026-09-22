import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface FileSnapshot {
  path: string
  exists: boolean
  content: string
  digest: string
  mode?: number
}

export interface FileReplacement {
  path: string
  content: string | null
  mode?: number
}

function digestContent(exists: boolean, content: string): string {
  return createHash('sha256').update(exists ? `file\0${content}` : 'missing\0').digest('hex')
}

export async function readFileSnapshot(path: string): Promise<FileSnapshot> {
  try {
    const [content, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return {
      path,
      exists: true,
      content,
      digest: digestContent(true, content),
      mode: metadata.mode & 0o777,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { path, exists: false, content: '', digest: digestContent(false, '') }
  }
}

export function assertPlanDigest(snapshot: FileSnapshot, expected: string): void {
  if (snapshot.digest !== expected) {
    throw new Error(`configuration changed after preview: ${snapshot.path}`)
  }
}

async function replaceFile(replacement: FileReplacement, previous?: FileSnapshot): Promise<void> {
  if (replacement.content === null) {
    await rm(replacement.path, { force: true })
    return
  }
  await mkdir(dirname(replacement.path), { recursive: true })
  const temporary = `${replacement.path}.wrenyard-${process.pid}-${randomUUID()}.tmp`
  const mode = replacement.mode ?? previous?.mode ?? 0o600
  try {
    await writeFile(temporary, replacement.content, { encoding: 'utf8', mode })
    await chmod(temporary, mode)
    await rename(temporary, replacement.path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function applyFileTransaction<T>(
  replacements: readonly FileReplacement[],
  commit: () => Promise<T>,
): Promise<T> {
  const previous = await Promise.all(replacements.map((entry) => readFileSnapshot(entry.path)))
  let written = 0
  try {
    for (let index = 0; index < replacements.length; index += 1) {
      await replaceFile(replacements[index], previous[index])
      written += 1
    }
    return await commit()
  } catch (error) {
    for (let index = written - 1; index >= 0; index -= 1) {
      const snapshot = previous[index]
      await replaceFile({
        path: snapshot.path,
        content: snapshot.exists ? snapshot.content : null,
        mode: snapshot.mode,
      }).catch(() => undefined)
    }
    throw error
  }
}
