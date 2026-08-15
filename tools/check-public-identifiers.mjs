#!/usr/bin/env node
// Candidate-file guard that rejects private/public-boundary identifiers before
// any clean public snapshot is produced from this suite. Operates on tracked
// (staged) plus new untracked non-ignored source files, and never prints
// environment or ignored machine state.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// release:check forbids the transitional github.com/dluck/forge namespace for
// publishable manifests, so only a development, non-publishable manifest may
// defer it here; any other dluck occurrence still fails the scan.
let devManifest = false;
try {
  const manifest = JSON.parse(readFileSync(join(suiteRoot, 'release-manifest.json'), 'utf8'));
  devManifest = manifest.release_status === 'development' && manifest.publishable === false;
} catch {
  // unreadable manifest -> fall back to strict scanning
}

// Paths never scanned: generated artifacts, lockfiles, binary payloads, the
// exact provenance snapshot document, and this scanner itself. Tests and
// fixtures are scanned so leaks cannot hide in them.
const SKIP_PATH = [
  /(^|\/)\.artifacts(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(lock|lockfile)/i,
  /^docs\/migration\/source-snapshots\.md$/,
  /^tools\/check-public-identifiers\.mjs$/,
  /\.(png|jpe?g|gif|ico|icns|woff2?|ttf|eot|pdf|exe|dmg|app|zip|tar|gz|dylib)$/i,
];

const PATTERNS = [
  { name: 'woa token', re: /\bwoa\b/i },
  { name: 'tokenhub token', re: /\btokenhub\b/i },
  { name: 'ioa-suffixed identifier', re: /\b[\w.-]*ioa\b/i },
  { name: 'internal endpoint fragment', re: /\.(internal|corp|intranet)\b|\.svc\.cluster\.local\b/i },
  { name: 'personal username', re: /\bdluck\b/i },
  { name: 'absolute user home path', re: /\/Users\/[A-Za-z0-9_.-]+/ },
];

let files;
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: suiteRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  console.error('error: cannot list candidate files via git ls-files');
  process.exit(1);
}

let scanned = 0;
const hits = [];

for (const file of files) {
  if (SKIP_PATH.some((re) => re.test(file))) continue;
  let content;
  try {
    const candidate = join(suiteRoot, file);
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      content = readlinkSync(candidate, 'utf8');
    } else if (stat.isFile()) {
      content = readFileSync(candidate, 'utf8');
    } else {
      continue;
    }
  } catch {
    continue;
  }
  if (content.includes('\u0000')) continue; // binary content
  scanned += 1;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // Only in development, non-publishable mode drop the exact legacy module
    // literal from every runtime/forge candidate file, including _test.go;
    // do not touch anything else.
    let line = lines[i];
    if (devManifest && file.startsWith('runtime/forge/')) {
      line = line.replaceAll('github.com/dluck/forge', '');
    }
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) {
        hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  }
}

if (hits.length > 0) {
  for (const hit of hits) console.error(`leak: ${hit}`);
  console.error(`public identifier check failed: ${hits.length} match(es) across ${scanned} scanned file(s)`);
  process.exit(1);
}

console.log(`public identifier check OK: ${scanned} candidate file(s) scanned`);
