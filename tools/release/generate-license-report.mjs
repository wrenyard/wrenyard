#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function resolveSuiteRoot(fromUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), '..', '..');
}

export function resolvePnpmCli(root, requireFn = createRequire(path.join(root, 'package.json'))) {
  // pnpm exports "." as its package.json, so pnpm/package.json is blocked by the
  // exports map. Resolve the package root via require.resolve("pnpm") (which
  // yields the manifest path), load the manifest, and resolve the bin relative to it.
  const manifestFile = requireFn.resolve('pnpm');
  const pnpmPkgJson = requireFn('pnpm');
  const bin = pnpmPkgJson && pnpmPkgJson.bin && pnpmPkgJson.bin.pnpm;
  if (!bin) {
    throw new Error('generate-license-report: could not resolve repository-pinned "pnpm" bin entry from pnpm package.json');
  }
  return path.resolve(path.dirname(manifestFile), bin);
}

export function runLicensesCommand(root, execFileSyncFn = execFileSync, resolvePnpm = resolvePnpmCli) {
  try {
    const pnpmCli = resolvePnpm(root);
    return execFileSyncFn(process.execPath, [pnpmCli, 'licenses', 'list', '--prod', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split('\n')[0];
    throw new Error(`generate-license-report: "pnpm licenses list --prod --json" failed: ${detail}`);
  }
}

export function normalizeEntries(parsed) {
  if (Array.isArray(parsed)) return parsed.filter((entry) => entry && typeof entry === 'object');
  if (parsed && typeof parsed === 'object') {
    const entries = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === 'object') entries.push({ ...entry, group: key });
          else if (typeof entry === 'string') entries.push({ name: entry, group: key });
        }
      } else if (value && typeof value === 'object') {
        entries.push({ name: key, ...value });
      } else if (typeof value === 'string') {
        entries.push({ name: value, group: key });
      }
    }
    return entries;
  }
  throw new Error('generate-license-report: unexpected licenses output shape');
}

export function parseLicensesOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    throw new Error(`generate-license-report: pnpm licenses output is not valid JSON: ${err.message}`);
  }
  return normalizeEntries(parsed);
}

export function stripAbsolutePaths(entry) {
  const out = { ...entry };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string' && (value.startsWith('/') || value.includes(homedir()) || /^[A-Za-z]:[\\/]/.test(value))) {
      delete out[key];
    }
  }
  return out;
}

export function compareVersions(a, b) {
  const split = (value) => value.split(/[.+_-]/).map((part) => (Number.isNaN(Number(part)) ? part : Number(part)));
  const pa = split(a);
  const pb = split(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function buildReport(entries) {
  const byLicense = new Map();
  for (const raw of entries) {
    const entry = stripAbsolutePaths(raw);
    const license = String(entry.license ?? 'UNKNOWN').trim() || 'UNKNOWN';
    const name = String(entry.name ?? 'unknown').trim() || 'unknown';
    if (!byLicense.has(license)) byLicense.set(license, new Map());
    const byName = byLicense.get(license);
    if (!byName.has(name)) byName.set(name, { ...entry, versions: [] });
    const slot = byName.get(name);
    const version = String(entry.version ?? '').trim();
    if (version && !slot.versions.includes(version)) slot.versions.push(version);
  }
  const licenseGroups = [...byLicense.entries()]
    .map(([license, byName]) => ({
      license,
      packages: [...byName.values()]
        .map((pkg) => ({ ...pkg, versions: [...pkg.versions].sort(compareVersions) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.license.localeCompare(b.license));
  return {
    generatedBy: 'pnpm licenses list --prod --json',
    generatedAt: new Date().toISOString(),
    licenseGroups,
  };
}

export function main(argv = process.argv.slice(2)) {
  const root = resolveSuiteRoot();
  const outputFlag = argv.indexOf('--output');
  const outputRel = outputFlag !== -1 && argv[outputFlag + 1] ? argv[outputFlag + 1] : '.artifacts/release/third-party-licenses.json';
  try {
    const entries = parseLicensesOutput(runLicensesCommand(root));
    const report = buildReport(entries);
    const outputFile = path.resolve(root, outputRel);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`generate-license-report: wrote ${path.relative(root, outputFile)} (${entries.length} packages, ${report.licenseGroups.length} license groups)`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
