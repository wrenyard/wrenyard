#!/usr/bin/env node
// Focused tests for the bounded staged-payload security gate in
// build-local-release.mjs. They build throwaway staged trees under the OS temp
// directory, exercise the exported validator, and assert the reports name only
// the artifact + rule (never a matched secret value). No real credentials,
// network, or release/push is required.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSafeReleasePayload } from './build-local-release.mjs';

function makeStage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrenyard-payload-test-'));
}

function writeFile(stage, rel, contents) {
  const file = path.join(stage, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function runGate(stage) {
  // Use /tmp-style temp roots as both buildTmp and worktree so the developer
  // path rule is exercised intentionally, then cleared per-test as needed.
  try {
    assertSafeReleasePayload(stage, 'test', os.tmpdir(), os.tmpdir());
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

test('accepts ordinary first-party source with runtime credential field names and localhost placeholders', () => {
  const stage = makeStage();
  try {
    writeFile(stage, 'bin/wrenyard.mjs', [
      'const config = {',
      '  apiKey: process.env.WRENYARD_API_KEY,',
      '  api_key: null,',
      "  databaseUrl: 'postgres://user:pass@localhost:5432/dev',",
      "  token: '${WRENYARD_TOKEN}',",
      "  password: '',",
      '};',
      "console.log('http://127.0.0.1:8787/health');",
      'export default config;',
    ].join('\n'));
    writeFile(stage, 'package.json', '{"name":"@wrenyard/cli","private":true}\n');
    const result = runGate(stage);
    assert.equal(result.ok, true, result.message);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('accepts normal node_modules runtime that is not a credential/database artifact', () => {
  const stage = makeStage();
  try {
    writeFile(stage, 'node_modules/some-dep/README.md', 'See https://example.com for setup docs.\n');
    writeFile(stage, 'node_modules/some-dep/index.js', 'module.exports = require("./lib/impl.js");\n');
    const result = runGate(stage);
    assert.equal(result.ok, true, result.message);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('rejects a synthetic secret signature assembled from parts', () => {
  const stage = makeStage();
  try {
    // Assemble a detectable signature at runtime so no literal secret-shaped
    // string lives in this repository or in test logs.
    const prefix = 'AKIA';
    const body = 'A'.repeat(16);
    writeFile(stage, 'dist/wrenyard.mjs', `const k = '${prefix}${body}';\n`);
    const result = runGate(stage);
    assert.equal(result.ok, false, 'expected the synthetic secret to be rejected');
    assert.match(result.message, /secret signature detected/);
    assert.match(result.message, /aws-access-key-id/);
    // The report must never include the matched value itself.
    assert.equal(result.message.includes(`${prefix}${body}`), false, 'report leaked the matched secret value');
    assert.equal(result.message.includes(body), false, 'report leaked secret body bytes');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('rejects a synthetic private-key signature without echoing it', () => {
  const stage = makeStage();
  try {
    const banner = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    writeFile(stage, 'contracts/material.pem', `${banner}\nMIIabc\n`);
    const result = runGate(stage);
    assert.equal(result.ok, false, 'expected the synthetic private key to be rejected');
    assert.match(result.message, /forbidden credential\/secret/);
    assert.equal(result.message.includes('PRIVATE KEY'), false, 'report leaked key banner text');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('rejects a developer absolute path embedded in first-party bytes', () => {
  const stage = makeStage();
  const stageRoot = makeStage();
  try {
    const devPath = path.join(stageRoot, 'src', 'dev-checkout');
    writeFile(stage, 'dist/wrenyard.mjs', `export const builtFrom = ${JSON.stringify(devPath)};\n`);
    try {
      assertSafeReleasePayload(stage, 'test', stageRoot, stageRoot);
      assert.fail('expected developer absolute path to be rejected');
    } catch (error) {
      assert.match(error.message, /local developer\/home\/checkout absolute path/);
      assert.match(error.message, /dist[\\/]wrenyard\.mjs/);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test('rejects a JSON-escaped Windows developer path embedded in first-party bytes', () => {
  const stage = makeStage();
  const stageRoot = makeStage();
  try {
    // Simulate a Windows build host: a backslash absolute path serialized into
    // JSON doubles every separator. The gate must still catch it regardless of
    // the platform actually running the test.
    const windowsRoot = path.join(stageRoot, 'build', 'checkout');
    const windowsPath = windowsRoot.replace(/\//gu, '\\');
    const jsonEscaped = windowsPath.replace(/\\/gu, '\\\\');
    writeFile(stage, 'bin/wrenyard.mjs', `export const builtFrom = "${jsonEscaped}";\n`);
    try {
      assertSafeReleasePayload(stage, 'test', windowsPath, windowsRoot);
      assert.fail('expected escaped Windows developer path to be rejected');
    } catch (error) {
      assert.match(error.message, /local developer\/home\/checkout absolute path/);
      assert.match(error.message, /bin[\\/]wrenyard\.mjs/);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test('accepts a safe upstream dependency source map and public certificate example', () => {
  const stage = makeStage();
  try {
    writeFile(stage, 'node_modules/some-dep/dist/impl.js.map', '{"version":3,"sources":["impl.ts"],"mappings":""}');
    writeFile(
      stage,
      'node_modules/some-dep/docs/tls.pem',
      '-----BEGIN CERTIFICATE-----\nMIIBpublic-example\n-----END CERTIFICATE-----\n',
    );
    const result = runGate(stage);
    assert.equal(result.ok, true, result.message);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('still rejects a bundled credential container inside a dependency', () => {
  const stage = makeStage();
  try {
    writeFile(stage, 'node_modules/some-dep/private.key', 'placeholder\n');
    const result = runGate(stage);
    assert.equal(result.ok, false);
    assert.match(result.message, /forbidden credential\/secret\/database\/log file/);
    assert.match(result.message, /node_modules[\\/]some-dep[\\/]private\.key/);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('rejects forbidden user database/config files and private workspace payloads', () => {
  const stage = makeStage();
  try {
    writeFile(stage, 'services/foreman/data/app.db', 'not-a-real-db');
    writeFile(stage, 'services/foreman/.npmrc', '//registry.npmjs.org/:_authToken=placeholder\n');
    writeFile(stage, '.git/config', '[core]\n\trepositoryformatversion = 0\n');
    const result = runGate(stage);
    assert.equal(result.ok, false);
    assert.match(result.message, /forbidden credential\/secret\/database\/log file/);
    assert.match(result.message, /forbidden user credential\/config file/);
    assert.match(result.message, /forbidden private\/workspace payload directory/);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('rejects source map payloads', () => {
  const stage = makeStage();
  try {
    writeFile(stage, 'dist/wrenyard.mjs.map', '{"version":3,"sources":["wrenyard.ts"],"mappings":""}');
    const result = runGate(stage);
    assert.equal(result.ok, false);
    assert.match(result.message, /source map payload forbidden/);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
