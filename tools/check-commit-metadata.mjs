#!/usr/bin/env node
// Unpushed-commit guard: every commit not yet on a remote-tracking ref must use
// a GitHub noreply author/committer email and carry no internal task trailers.
// Never prints the offending email itself.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOREPLY = /@users\.noreply\.github\.com$|^noreply@github\.com$/i;
const TRAILER = /^\s*Refs:\s*things:/im;

let log;
try {
  log = execFileSync('git', ['log', 'HEAD', '--not', '--remotes', '--format=%H%x00%ae%x00%ce%x00%B%x01'], { cwd: root, encoding: 'utf8' });
} catch {
  console.error('error: cannot list unpushed commits via git log');
  process.exit(1);
}

const hits = [];
for (const record of log.split('\x01')) {
  const [sha, author, committer, message] = record.replace(/^\n/, '').split('\x00');
  if (!sha) continue;
  if (!NOREPLY.test(author)) hits.push(`${sha.slice(0, 12)}: author email is not a GitHub noreply address`);
  if (!NOREPLY.test(committer)) hits.push(`${sha.slice(0, 12)}: committer email is not a GitHub noreply address`);
  if (TRAILER.test(message ?? '')) hits.push(`${sha.slice(0, 12)}: message carries an internal task trailer`);
}

if (hits.length > 0) {
  for (const hit of hits) console.error(`leak: ${hit}`);
  console.error(`commit metadata check failed: ${hits.length} problem(s)`);
  process.exit(1);
}

console.log('commit metadata check OK');
