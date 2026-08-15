import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCandidateText, scanText } from './check-secrets.mjs';

const samples = {
  pemPrivateKey: '-----BEGIN ' + 'PRIVATE KEY-----',
  githubClassic: 'ghp_' + 'A'.repeat(36),
  githubFineGrained: 'github_pat_' + 'B'.repeat(30),
  awsAccessKeyId: 'AKIA' + 'C'.repeat(16),
  npmToken: 'npm_' + 'D'.repeat(36),
  slackToken: 'xoxb-' + 'E'.repeat(12),
  openaiToken: 'sk-' + 'F'.repeat(24),
  openaiProjectToken: 'sk-proj-' + 'G'.repeat(24),
  urlCredentials: 'https://' + 'user:pass@' + 'example.com',
};

const detectorCases = [
  ['pem-private-key', samples.pemPrivateKey],
  ['github-token', samples.githubClassic],
  ['github-token', samples.githubFineGrained],
  ['aws-access-key-id', samples.awsAccessKeyId],
  ['npm-token', samples.npmToken],
  ['slack-token', samples.slackToken],
  ['openai-token', samples.openaiToken],
  ['openai-token', samples.openaiProjectToken],
  ['url-credentials', samples.urlCredentials],
];

function sampleWithSecretOnLine(lineNumber, secret) {
  const lines = [];
  for (let i = 1; i < lineNumber; i += 1) {
    lines.push(`// filler line ${i}`);
  }
  lines.push(`const value = ${JSON.stringify(secret)};`);
  return lines.join('\n');
}

for (const [detector, secret] of detectorCases) {
  test(`scanText detects ${detector} and reports the 1-based line`, () => {
    const text = sampleWithSecretOnLine(3, secret);
    assert.deepEqual(scanText(text), [{ detector, line: 3 }]);
  });
}

test('safe source declarations and documentation produce no findings', () => {
  const safeText = [
    'const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;',
    '// GitHub tokens use the ghp_ prefix; keep them out of the repo',
    'const OPENAI_API_KEY = process.env.OPENAI_API_KEY;',
    'fetch("https://api.example.com/v1/data")',
    '// npm tokens live in .npmrc, never in source',
    'const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;',
  ].join('\n');
  assert.deepEqual(scanText(safeText), []);
});

test('findings contain detector names and line numbers but never secret values', () => {
  const text = detectorCases.map(([, secret]) => secret).join('\n');
  const findings = scanText(text);
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['detector', 'line']);
    assert.ok(Number.isInteger(finding.line) && finding.line >= 1);
    const serialized = JSON.stringify(finding);
    for (const [, secret] of detectorCases) {
      assert.ok(!serialized.includes(secret), 'finding disclosed a secret value');
    }
  }
});

test('the scanner itself contains no detector matches', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./check-secrets.mjs', import.meta.url)),
    'utf8',
  );
  assert.deepEqual(scanText(source), []);
});

test('candidate reads inspect a symlink value without following it outside the suite', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-secret-scan-'));
  const outside = join(root, 'outside.txt');
  const link = join(root, 'candidate-link');
  const secret = 'ghp_' + 'Z'.repeat(36);
  try {
    writeFileSync(outside, secret, 'utf8');
    symlinkSync(outside, link);
    const candidate = readCandidateText(link);
    assert.equal(candidate, outside);
    assert.deepEqual(scanText(candidate), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
