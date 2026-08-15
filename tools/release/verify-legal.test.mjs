import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectErrors, findFirstPartyManifests } from './verify-legal.mjs';

function makeTree() {
  const root = mkdtempSync(path.join(tmpdir(), 'verify-legal-'));
  const write = (rel, content) => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };
  write('package.json', JSON.stringify({ name: 'wrenyard', license: 'MIT' }));
  write('apps/desktop/package.json', JSON.stringify({ name: 'desktop', license: 'MIT' }));
  write('packages/alpha/package.json', JSON.stringify({ name: 'alpha', license: 'MIT' }));
  write('LICENSE', 'MIT License\n');
  write('NOTICE', 'Wrenyard notice\n');
  write('THIRD_PARTY_NOTICES.md', '# Third-Party Notices\n');
  write(
    'docs/legal/asset-provenance.json',
    JSON.stringify({
      schema_version: 'wrenyard.asset-provenance.v1',
      assets: [
        {
          id: 'first-party-art',
          paths: ['packages/alpha'],
          package: null,
          origin: 'first-party',
          owner: 'Dluckxx',
          license: 'MIT',
          distribution: 'packaged',
          evidence: 'test fixture',
          notes: 'test fixture',
        },
        {
          id: 'external-dep',
          paths: [],
          package: 'example-dep',
          origin: 'external',
          owner: 'Upstream',
          license: 'MIT',
          distribution: 'not packaged',
          evidence: 'test fixture',
          notes: 'test fixture',
        },
      ],
    }),
  );
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('accepts a conforming fixture tree', () => {
  const tree = makeTree();
  assert.deepEqual(collectErrors(tree.root), []);
  tree.cleanup();
});

test('rejects a first-party manifest without license MIT', () => {
  const tree = makeTree();
  tree.write('packages/alpha/package.json', JSON.stringify({ name: 'alpha', license: 'Apache-2.0' }));
  const errors = collectErrors(tree.root);
  assert.ok(errors.some((error) => error.includes('packages/alpha/package.json') && error.includes('"MIT"')));
  tree.cleanup();
});

test('rejects duplicate asset ids and missing provenance fields', () => {
  const tree = makeTree();
  tree.write(
    'docs/legal/asset-provenance.json',
    JSON.stringify({
      schema_version: 'wrenyard.asset-provenance.v1',
      assets: [
        { id: 'dup', owner: 'Dluckxx', license: 'MIT', distribution: 'packaged' },
        { id: 'dup', owner: 'Dluckxx', license: 'MIT' },
      ],
    }),
  );
  const errors = collectErrors(tree.root);
  assert.ok(errors.some((error) => error.includes('duplicate asset id "dup"')));
  assert.ok(errors.some((error) => error.includes('missing "distribution"')));
  tree.cleanup();
});

test('rejects committed certificate and private-key material without leaking contents', () => {
  const tree = makeTree();
  tree.write('tools/release/ci.p12', 'PKCS12');
  tree.write('apps/desktop/cert.pem', '-----BEGIN CERTIFICATE-----\n');
  tree.write('packages/alpha/id_ed25519.key', 'private key material');
  const errors = collectErrors(tree.root);
  assert.ok(errors.some((error) => error.includes('ci.p12')));
  assert.ok(errors.some((error) => error.includes('cert.pem')));
  assert.ok(errors.some((error) => error.includes('id_ed25519.key')));
  assert.ok(errors.every((error) => !error.includes('PKCS12') && !error.includes('BEGIN CERTIFICATE')));
  tree.cleanup();
});

test('enumerates first-party manifests under apps, services and packages', () => {
  const tree = makeTree();
  const manifests = findFirstPartyManifests(tree.root).map((file) => path.relative(tree.root, file)).sort();
  assert.deepEqual(manifests, ['apps/desktop/package.json', 'package.json', 'packages/alpha/package.json']);
  tree.cleanup();
});
