#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(TOOL_DIR, 'renderer-forbidden-tokens.json');
const PROJECT_ROOT = process.cwd();
const TOKEN_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function usage() {
  return [
    'Usage: node tools/renderer-cleanup-scan.mjs [--root PATH ...]',
    '',
    'Without --root, scans exactly: src/**, scripts/**, test/**, package.json, tsconfig.json, tsconfig.main.json, tsconfig.renderer.json.',
    'Repeat --root PATH to scan custom roots for tests or focused checks.',
  ].join('\n');
}

function parseArgs(argv) {
  const roots = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root requires a path');
      roots.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      roots.push(arg.slice('--root='.length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return roots.length > 0 ? roots : TOKEN_CONFIG.defaultRoots;
}

function toSlash(value) {
  return value.replace(/\\/g, '/');
}

function displayPath(filePath) {
  const relative = path.relative(PROJECT_ROOT, filePath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return toSlash(relative);
  return toSlash(path.resolve(filePath));
}

function isSameOrInside(candidate, excluded) {
  return candidate === excluded || candidate.startsWith(`${excluded}/`);
}

function isExcluded(filePath) {
  const absolute = toSlash(path.resolve(filePath));
  const relative = toSlash(path.relative(PROJECT_ROOT, filePath));
  return TOKEN_CONFIG.excludedPaths.some((excludedPath) => {
    const excluded = toSlash(excludedPath).replace(/\/$/, '');
    if (isSameOrInside(relative, excluded)) return true;
    return absolute.includes(`/${excluded}/`) || absolute.endsWith(`/${excluded}`);
  });
}

function walkRoot(root) {
  const absoluteRoot = path.resolve(PROJECT_ROOT, root);
  if (!fs.existsSync(absoluteRoot)) return [];
  const stat = fs.statSync(absoluteRoot);
  if (stat.isFile()) return isExcluded(absoluteRoot) ? [] : [absoluteRoot];
  if (!stat.isDirectory()) return [];

  const files = [];
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir || isExcluded(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const full = path.join(dir, entry.name);
      if (isExcluded(full)) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function collectFiles(roots) {
  const seen = new Set();
  const files = [];
  for (const root of roots) {
    for (const file of walkRoot(root)) {
      const absolute = path.resolve(file);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      files.push(absolute);
    }
  }
  files.sort((a, b) => displayPath(a).localeCompare(displayPath(b), 'en'));
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const exactRules = TOKEN_CONFIG.exactTokens.map((token) => ({
  token,
  regex: new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(token)}(?![A-Za-z0-9_$])`, 'g'),
}));

const patternRules = TOKEN_CONFIG.patterns.map((rule) => ({
  token: rule.token,
  regex: new RegExp(rule.source, 'g'),
}));

const pixiRules = TOKEN_CONFIG.pixiImportPatterns.map((rule) => ({
  token: rule.token,
  regex: new RegExp(rule.source, 'g'),
}));

function isPixiImportAllowed(filePath) {
  const normalized = toSlash(path.resolve(filePath));
  const allowlist = toSlash(TOKEN_CONFIG.pixiImportAllowlist).replace(/\/$/, '');
  return normalized.includes(`/${allowlist}/`);
}

function lineNumberFor(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function contextFor(source, index) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const nextLineBreak = source.indexOf('\n', index);
  const lineEnd = nextLineBreak === -1 ? source.length : nextLineBreak;
  const line = source.slice(lineStart, lineEnd).replace(/\r/g, '');
  if (line.length <= 100) return line;

  const offset = index - lineStart;
  const start = Math.max(0, Math.min(offset - 45, line.length - 100));
  return line.slice(start, start + 100);
}

function violationsForRule(source, rule) {
  const violations = [];
  rule.regex.lastIndex = 0;
  for (let match = rule.regex.exec(source); match !== null; match = rule.regex.exec(source)) {
    violations.push({ token: rule.token, index: match.index });
    if (match.index === rule.regex.lastIndex) rule.regex.lastIndex += 1;
  }
  return violations;
}

function firstViolation(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const rules = [...exactRules, ...patternRules];
  if (!isPixiImportAllowed(filePath)) rules.push(...pixiRules);

  const violations = rules.flatMap((rule) => violationsForRule(source, rule));
  if (violations.length === 0) return null;
  violations.sort((a, b) => a.index - b.index || a.token.localeCompare(b.token, 'en'));
  const violation = violations[0];
  return {
    schemaVersion: TOKEN_CONFIG.schemaVersion,
    status: 'failed',
    token: violation.token,
    file: displayPath(filePath),
    line: lineNumberFor(source, violation.index),
    context: contextFor(source, violation.index),
  };
}

function fail(error) {
  const payload = error?.schemaVersion ? error : {
    schemaVersion: TOKEN_CONFIG.schemaVersion,
    status: 'failed',
    token: 'scanner',
    file: 'tools/renderer-cleanup-scan.mjs',
    line: 1,
    context: String(error?.message ?? error).slice(0, 100),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(1);
}

try {
  const roots = parseArgs(process.argv.slice(2));
  for (const file of collectFiles(roots)) {
    const violation = firstViolation(file);
    if (violation) fail(violation);
  }
} catch (error) {
  fail(error);
}
