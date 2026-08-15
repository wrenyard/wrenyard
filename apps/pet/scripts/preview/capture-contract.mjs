import fs from 'node:fs';
import path from 'node:path';
import preloadContract from '../preview-capture-preload.cjs';
import {
  FIXTURE_VIEWPORT,
  HOUSE_FIXTURE_VIEWPORT,
  PREVIEW_FIXTURES,
  serializeFixture,
} from './fixtures.mjs';

export const SCHEMA_VERSION = 'foreman-pet-preview/v1';
export const STATIC_PREVIEW_READY_DATASET = 'previewReady';
export const STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET = 'previewWebglContextLossMarker';
export const STATIC_PREVIEW_CONTEXT_LOST_DATASET = 'previewWebglContextLost';
export const STATIC_PREVIEW_OUTPUT_KEY = '__foremanPreviewOutput';
export const NOW_MS = 10000;
export const THRESHOLD = {
  maxBoundsDelta: 1,
  channelDelta: 24,
  maxChangedRatio: 0.03,
};
export const FAILURE_REASONS = [
  'preload-error',
  'console-error',
  'missing-pet-api',
  'render-process-gone',
  'context-loss',
  'missing-output',
  'blank-roi',
  'reference-mismatch',
  'manifest-mismatch',
];
export const PET_API_METHOD_NAMES = preloadContract.METHOD_NAMES;

export function parseInjectFailure(argv) {
  const arg = argv.find((value) => value.startsWith('--inject-failure='));
  if (!arg) return undefined;
  const reason = arg.slice('--inject-failure='.length);
  assertFailureReason(reason);
  return reason;
}

export function assertFailureReason(reason) {
  if (!FAILURE_REASONS.includes(reason)) {
    throw new Error(`unsupported inject failure reason: ${reason}`);
  }
}

export function failurePayload(reason, details, caseId) {
  assertFailureReason(reason);
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'failed',
    ...(caseId ? { caseId } : {}),
    reason,
    details,
  };
}

export function serializeFailure(reason, details, caseId) {
  return `${JSON.stringify(failurePayload(reason, details, caseId))}\n`;
}

export function removeSuccessManifest(rootDir) {
  fs.rmSync(manifestAbsolutePath(rootDir), { force: true });
}

export function manifestAbsolutePath(rootDir) {
  return path.join(rootDir, 'artifacts', 'preview-capture', 'manifest.json');
}

export function captureDir(rootDir) {
  return path.join(rootDir, 'artifacts', 'preview-capture');
}

export function caseIdForFixture(fixture) {
  return fixture.file.replace(/\.png$/, '');
}

export function viewportForFixture(fixture) {
  return fixture.kind === 'house' ? HOUSE_FIXTURE_VIEWPORT : FIXTURE_VIEWPORT;
}

export function htmlPathForFixture(rootDir, fixture) {
  return path.join(rootDir, 'dist', 'renderer', fixture.kind === 'house' ? 'house.html' : 'worker.html');
}

export function outputPathForFixture(rootDir, fixture) {
  return path.join(captureDir(rootDir), fixture.file);
}

export function referencePathForFixture(rootDir, fixture) {
  return path.join(
    rootDir,
    'test',
    'visual',
    'reference',
    fixture.kind === 'house' ? 'house' : 'worker',
    fixture.file,
  );
}

export function repoRelative(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).replace(/\\/g, '/');
}

export function additionalArgumentsForFixture(fixture) {
  return [`${preloadContract.FIXTURE_ARG_PREFIX}${encodeURIComponent(serializeFixture(fixture))}`];
}

export function staticQueryForFixture(fixture) {
  const query = {
    previewStatic: '1',
    nowMs: String(NOW_MS),
    initNowMs: String(fixture.initNowMs),
  };
  if (fixture.pointer) {
    query.pointerX = String(fixture.pointer.x);
    query.pointerY = String(fixture.pointer.y);
    query.pointerInside = fixture.pointer.inside ? '1' : '0';
  }
  if (typeof fixture.dragging === 'boolean') {
    query.dragging = fixture.dragging ? '1' : '0';
  }
  return query;
}

export function buildManifest(cases) {
  return {
    schemaVersion: SCHEMA_VERSION,
    cases,
  };
}

export function buildManifestCase({
  fixture,
  rootDir,
  referenceSha256,
  outputSha256,
  compare,
}) {
  const viewport = viewportForFixture(fixture);
  return {
    id: caseIdForFixture(fixture),
    file: repoRelative(rootDir, outputPathForFixture(rootDir, fixture)),
    reference: repoRelative(rootDir, referencePathForFixture(rootDir, fixture)),
    width: viewport.width,
    height: viewport.height,
    dpr: 1,
    nowMs: NOW_MS,
    referenceSha256,
    outputSha256,
    threshold: { ...THRESHOLD },
    result: {
      status: 'passed',
      changedPixels: compare.changedPixels,
      changedRatio: compare.changedRatio,
      boundsDelta: {
        left: compare.boundsDelta.left,
        top: compare.boundsDelta.top,
        right: compare.boundsDelta.right,
        bottom: compare.boundsDelta.bottom,
      },
    },
  };
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function validateManifestShape(manifest, expectedFixtures = PREVIEW_FIXTURES) {
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.cases)) {
    return { ok: false, details: 'manifest root shape mismatch' };
  }
  if (manifest.cases.length !== expectedFixtures.length) {
    return { ok: false, details: `expected ${expectedFixtures.length} cases, saw ${manifest.cases.length}` };
  }
  const rootKeys = Object.keys(manifest);
  if (rootKeys.join(',') !== 'schemaVersion,cases') {
    return { ok: false, details: `manifest root key order mismatch: ${rootKeys.join(',')}` };
  }
  for (let i = 0; i < expectedFixtures.length; i += 1) {
    const fixture = expectedFixtures[i];
    const item = manifest.cases[i];
    const keys = Object.keys(item ?? {});
    const expectedKeys = [
      'id',
      'file',
      'reference',
      'width',
      'height',
      'dpr',
      'nowMs',
      'referenceSha256',
      'outputSha256',
      'threshold',
      'result',
    ];
    if (keys.join(',') !== expectedKeys.join(',')) {
      return { ok: false, details: `case ${i} key order mismatch: ${keys.join(',')}` };
    }
    if (item.id !== caseIdForFixture(fixture)) {
      return { ok: false, details: `case ${i} id mismatch: ${item.id}` };
    }
    if (item.file !== `artifacts/preview-capture/${fixture.file}`) {
      return { ok: false, details: `case ${item.id} file mismatch: ${item.file}` };
    }
    if (!item.reference.endsWith(`/${fixture.file}`)) {
      return { ok: false, details: `case ${item.id} reference mismatch: ${item.reference}` };
    }
    const viewport = viewportForFixture(fixture);
    if (item.width !== viewport.width || item.height !== viewport.height || item.dpr !== 1 || item.nowMs !== NOW_MS) {
      return { ok: false, details: `case ${item.id} viewport/time mismatch` };
    }
    if (JSON.stringify(item.threshold) !== JSON.stringify(THRESHOLD)) {
      return { ok: false, details: `case ${item.id} threshold mismatch` };
    }
    if (Object.keys(item.result ?? {}).join(',') !== 'status,changedPixels,changedRatio,boundsDelta') {
      return { ok: false, details: `case ${item.id} result key order mismatch` };
    }
    if (item.result.status !== 'passed') {
      return { ok: false, details: `case ${item.id} status mismatch` };
    }
    const deltaKeys = Object.keys(item.result.boundsDelta ?? {});
    if (deltaKeys.join(',') !== 'left,top,right,bottom') {
      return { ok: false, details: `case ${item.id} boundsDelta key order mismatch` };
    }
  }
  return { ok: true };
}

export function validateSerializedManifest(serialized, expectedManifest) {
  const expected = serializeManifest(expectedManifest);
  if (serialized !== expected) {
    return { ok: false, details: 'manifest serialization is not stable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    return { ok: false, details: `manifest JSON parse failed: ${error?.message ?? error}` };
  }
  return validateManifestShape(parsed);
}
