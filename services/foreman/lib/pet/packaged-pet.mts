import { statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Canonical release artifact layout for the packaged Wrenyard Pet app.
 * Returns the deterministic candidate path for the given platform; the file
 * may not exist yet and is not validated here.
 */
export function packagedPetExecutablePath(petRoot: string, platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return join(petRoot, 'Wrenyard Pet.app', 'Contents', 'MacOS', 'Wrenyard Pet')
    case 'win32':
      return join(petRoot, 'Wrenyard Pet.exe')
    default:
      return join(petRoot, 'wrenyard-pet')
  }
}

export function isNonEmptyRegularFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/**
 * Shared packaged-Pet resolver: returns the canonical executable path only
 * when it exists as a non-empty regular file. A source checkout, a missing
 * artifact, or an empty/truncated binary never resolves to packaged mode.
 */
export function resolvePackagedPetExecutable(petRoot: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const candidate = packagedPetExecutablePath(petRoot, platform)
  return isNonEmptyRegularFile(candidate) ? candidate : undefined
}
