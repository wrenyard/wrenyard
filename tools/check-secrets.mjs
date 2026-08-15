#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DETECTORS = [
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: 'github-token',
    pattern: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APAO|AROA)[A-Z0-9]{16}\b/g,
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'openai-token',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'url-credentials',
    pattern: /https?:\/\/[^\s/]+:[^\s/@]+@/g,
  },
];

const SKIPPED_DIR_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
]);

const SKIPPED_NAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'go.sum',
  'Cargo.lock',
  'composer.lock',
  'poetry.lock',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar',
  '.bin', '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.obj', '.lib',
  '.class', '.jar', '.war', '.pyc', '.pyo', '.node', '.wasm',
  '.mp3', '.mp4', '.mov', '.webm', '.avi', '.mkv', '.wav', '.ogg',
  '.db', '.sqlite', '.sqlite3',
]);

export function scanText(text) {
  const findings = [];
  const lines = String(text).split('\n');
  for (let line = 0; line < lines.length; line += 1) {
    for (const detector of DETECTORS) {
      detector.pattern.lastIndex = 0;
      if (detector.pattern.test(lines[line])) {
        findings.push({ detector: detector.name, line: line + 1 });
      }
    }
  }
  return findings;
}

export function readCandidateText(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return readlinkSync(path, 'utf8');
  }
  if (!stat.isFile()) {
    return null;
  }
  const text = readFileSync(path, 'utf8');
  return text.includes('\u0000') ? null : text;
}

function isSkipped(relativePath) {
  const segments = relativePath.split('/');
  if (segments.some((segment) => SKIPPED_DIR_SEGMENTS.has(segment))) {
    return true;
  }
  const base = segments[segments.length - 1];
  if (SKIPPED_NAMES.has(base)) {
    return true;
  }
  return BINARY_EXTENSIONS.has(extname(base).toLowerCase());
}

function listGitFiles() {
  return execFileSync(
    'git',
    ['-C', SUITE_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => path.replaceAll('\\', '/'));
}

function main() {
  let files;
  try {
    files = listGitFiles();
  } catch (error) {
    console.error(`check-secrets: failed to enumerate git files: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let findingCount = 0;
  for (const relativePath of files) {
    if (isSkipped(relativePath)) {
      continue;
    }
    const absolutePath = resolve(SUITE_ROOT, relativePath);
    let text;
    try {
      text = readCandidateText(absolutePath);
    } catch {
      continue;
    }
    if (text === null) {
      continue;
    }
    for (const finding of scanText(text)) {
      console.error(`${relativePath}:${finding.line}: ${finding.detector}`);
      findingCount += 1;
    }
  }

  if (findingCount > 0) {
    process.exitCode = 1;
  }
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
