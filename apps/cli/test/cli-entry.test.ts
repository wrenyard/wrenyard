import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../src/index.js';

// Entry identity must not depend on how the caller spelled the path: the module
// resolver canonicalizes `import.meta.url` (macOS CI stages under /var/folders,
// which canonicalizes to /private/var/folders) while `process.argv[1]` keeps the
// spelling given on the command line. A directory symlink reproduces the same
// respelling on Windows (junction) and POSIX (dir symlink).
test('isEntryPoint matches a module reached through a symlinked ancestor directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-entry-'));
  const real = join(root, 'private', 'entry');
  const link = join(root, 'entry-link');
  try {
    mkdirSync(real, { recursive: true });
    const entry = join(real, 'index.ts');
    writeFileSync(entry, 'export {};\n');
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const entryThroughLink = join(link, 'index.ts');
    assert.equal(isEntryPoint(entryThroughLink, pathToFileURL(entry).href), true);
    assert.equal(isEntryPoint(entry, pathToFileURL(entryThroughLink).href), true);
    assert.equal(isEntryPoint(entryThroughLink, pathToFileURL(entryThroughLink).href), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isEntryPoint stays inert for any other or unusable argv[1]', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-entry-'));
  try {
    const module = join(root, 'index.ts');
    const other = join(root, 'other.ts');
    writeFileSync(module, 'export {};\n');
    writeFileSync(other, 'export {};\n');
    const moduleUrl = pathToFileURL(module).href;
    assert.equal(isEntryPoint(module, moduleUrl), true);
    assert.equal(isEntryPoint(other, moduleUrl), false);
    assert.equal(isEntryPoint(join(root, 'missing.ts'), moduleUrl), false);
    assert.equal(isEntryPoint(undefined, moduleUrl), false);
    assert.equal(isEntryPoint('', moduleUrl), false);
    assert.equal(isEntryPoint(module, undefined), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
