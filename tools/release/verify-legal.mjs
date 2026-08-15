#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 'wrenyard.asset-provenance.v1';

export const REQUIRED_FILES = [
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'docs/legal/asset-provenance.json',
];

export const CERT_EXTENSIONS = new Set(['.p12', '.pfx', '.pem', '.key']);

export const SOURCE_CANDIDATE_DIRS = [
  'src', 'apps', 'packages', 'services', 'tools', 'scripts', 'forge',
  'docs', 'config', 'test', 'tests', 'electron',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache',
  '.artifacts', 'out', 'vendor', 'third_party',
]);

export function resolveSuiteRoot(fromUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), '..', '..');
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function manifestLicense(manifest) {
  if (typeof manifest.license === 'string' && manifest.license) return manifest.license;
  if (Array.isArray(manifest.licenses) && manifest.licenses[0] && typeof manifest.licenses[0].type === 'string') {
    return manifest.licenses[0].type;
  }
  return undefined;
}

export function findFirstPartyManifests(root) {
  const manifests = [];
  const rootPkg = path.join(root, 'package.json');
  if (existsSync(rootPkg)) manifests.push(rootPkg);
  for (const area of ['apps', 'services', 'packages']) {
    const dir = path.join(root, area);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = path.join(dir, entry.name, 'package.json');
      if (existsSync(pkg)) manifests.push(pkg);
    }
  }
  return manifests;
}

export function collectCertFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.isFile() && CERT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  };
  for (const dir of SOURCE_CANDIDATE_DIRS) {
    const abs = path.join(root, dir);
    if (existsSync(abs)) walk(abs);
  }
  return found;
}

export function collectErrors(root) {
  const errors = [];
  const rel = (file) => path.relative(root, file) || path.basename(file);

  for (const manifestFile of findFirstPartyManifests(root)) {
    let manifest;
    try {
      manifest = readJson(manifestFile);
    } catch (err) {
      errors.push(`${rel(manifestFile)}: invalid JSON (${err.message})`);
      continue;
    }
    const license = manifestLicense(manifest);
    if (license !== 'MIT') {
      const found = license === undefined ? 'none declared' : JSON.stringify(license);
      errors.push(`${rel(manifestFile)}: must declare license "MIT", found ${found}`);
    }
  }

  for (const file of REQUIRED_FILES) {
    if (!existsSync(path.join(root, file))) {
      errors.push(`missing required file: ${file}`);
    }
  }

  const provenanceFile = path.join(root, 'docs/legal/asset-provenance.json');
  if (existsSync(provenanceFile)) {
    try {
      const provenance = readJson(provenanceFile);
      if (provenance.schema_version !== SCHEMA_VERSION) {
        errors.push(`docs/legal/asset-provenance.json: expected schema_version "${SCHEMA_VERSION}", found ${JSON.stringify(provenance.schema_version)}`);
      }
      if (!Array.isArray(provenance.assets)) {
        errors.push('docs/legal/asset-provenance.json: "assets" must be an array');
      } else {
        const ids = new Set();
        provenance.assets.forEach((asset, index) => {
          if (!asset || typeof asset !== 'object') {
            errors.push(`docs/legal/asset-provenance.json: assets[${index}] is not an object`);
            return;
          }
          if (typeof asset.id !== 'string' || asset.id.trim() === '') {
            errors.push(`docs/legal/asset-provenance.json: assets[${index}] missing non-empty "id"`);
            return;
          }
          if (ids.has(asset.id)) {
            errors.push(`docs/legal/asset-provenance.json: duplicate asset id "${asset.id}"`);
          }
          ids.add(asset.id);
          for (const field of ['owner', 'license', 'distribution']) {
            if (typeof asset[field] !== 'string' || asset[field].trim() === '') {
              errors.push(`docs/legal/asset-provenance.json: asset "${asset.id}" missing "${field}"`);
            }
          }
        });
      }
    } catch (err) {
      errors.push(`docs/legal/asset-provenance.json: invalid JSON (${err.message})`);
    }
  }

  for (const certFile of collectCertFiles(root)) {
    errors.push(`committed certificate/private-key material must not ship: ${rel(certFile)}`);
  }

  return errors;
}

export function main() {
  const root = resolveSuiteRoot();
  const errors = collectErrors(root);
  const manifests = findFirstPartyManifests(root).length;
  if (errors.length > 0) {
    console.error('verify-legal: FAIL');
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  let assets = 0;
  try {
    assets = readJson(path.join(root, 'docs/legal/asset-provenance.json')).assets.length;
  } catch {
    // unreachable when the gate passed; keep the success line robust
  }
  console.log(`verify-legal: OK (${manifests} first-party manifests, ${assets} provenance assets)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
