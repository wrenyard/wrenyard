import { app, BrowserWindow, nativeImage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIEW_FIXTURES } from './preview/fixtures.mjs';
import { installBrokenPipeGuard, rethrowUnlessBrokenPipe } from './preview/stdio-guard.mjs';
import {
  FAILURE_REASONS,
  PET_API_METHOD_NAMES,
  STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET,
  STATIC_PREVIEW_CONTEXT_LOST_DATASET,
  STATIC_PREVIEW_OUTPUT_KEY,
  STATIC_PREVIEW_READY_DATASET,
  THRESHOLD,
  additionalArgumentsForFixture,
  buildManifest,
  buildManifestCase,
  captureDir,
  caseIdForFixture,
  htmlPathForFixture,
  manifestAbsolutePath,
  outputPathForFixture,
  parseInjectFailure,
  referencePathForFixture,
  removeSuccessManifest,
  serializeFailure,
  serializeManifest,
  staticQueryForFixture,
  validateSerializedManifest,
  viewportForFixture,
} from './preview/capture-contract.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preloadPath = path.join(rootDir, 'scripts', 'preview-capture-preload.cjs');
const manifestPath = manifestAbsolutePath(rootDir);
const electronDataDir = path.join(captureDir(rootDir), 'electron-user-data');
const electronCacheDir = path.join(captureDir(rootDir), 'electron-cache');

const WORKER_VIEWPORT = { width: 640, height: 360, scale: 5, dpr: 1 };
const HOUSE_VIEWPORT = { width: 360, height: 460, scale: 5, dpr: 1 };
const POLL_MS = 25;
const CASE_TIMEOUT_MS = 20000;

let failureWritten = false;
const UPDATE_HOUSE_REFS = process.env.PREVIEW_UPDATE_HOUSE_REFERENCES === '1';

installBrokenPipeGuard(process.stdout);
installBrokenPipeGuard(process.stderr);

class PreviewFailure extends Error {
  constructor(reason, details, caseId) {
    super(details);
    this.reason = reason;
    this.details = details;
    this.caseId = caseId;
  }
}

function emitFailure(reason, details, caseId) {
  if (failureWritten) return;
  failureWritten = true;
  removeSuccessManifest(rootDir);
  try {
    fs.writeSync(process.stderr.fd, serializeFailure(reason, details, caseId));
  } catch (error) {
    rethrowUnlessBrokenPipe(error);
  }
}

try {
  const injected = parseInjectFailure(process.argv.slice(2));
  if (injected) {
    emitFailure(injected, `injected ${injected}`);
    process.exit(1);
  }
} catch (error) {
  emitFailure('manifest-mismatch', error?.message ?? String(error));
  process.exit(1);
}

app.commandLine.appendSwitch('force-color-profile', 'srgb');
fs.mkdirSync(electronDataDir, { recursive: true });
fs.mkdirSync(electronCacheDir, { recursive: true });
app.setPath('userData', electronDataDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disk-cache-dir', electronCacheDir);

function workerLayout() {
  const logicalWidth = WORKER_VIEWPORT.width / WORKER_VIEWPORT.scale;
  const logicalHeight = WORKER_VIEWPORT.height / WORKER_VIEWPORT.scale;
  const x = Math.max(0, Math.floor((logicalWidth - 40) / 2));
  const y = Math.max(0, logicalHeight - 32);
  return { x, y, scale: WORKER_VIEWPORT.scale };
}

function houseLayout() {
  const logicalWidth = HOUSE_VIEWPORT.width / HOUSE_VIEWPORT.scale;
  const logicalHeight = HOUSE_VIEWPORT.height / HOUSE_VIEWPORT.scale;
  const x = Math.max(0, Math.floor((logicalWidth - 48) / 2));
  const y = Math.max(0, logicalHeight - 40);
  return { x, y, scale: HOUSE_VIEWPORT.scale };
}

function roi(x, y, width, height) {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function workerSubjectRoi() {
  const { x, y, scale } = workerLayout();
  return roi(x * scale, y * scale, 40 * scale, 32 * scale);
}

function houseSubjectRoi() {
  const { x, y, scale } = houseLayout();
  return roi(x * scale, y * scale, 48 * scale, 40 * scale);
}

function ageLabelRoi() {
  const { x, y, scale } = workerLayout();
  const footY = Math.round(y * scale + 32 * scale);
  const top = Math.max(0, footY - 12 - 2);
  const workerRight = Math.round((x + Math.min(25, 40)) * scale);
  return roi(workerRight + 4, top, 88, 12);
}

function badgeRoi() {
  const { x, y, scale } = workerLayout();
  return roi((x + 29) * scale, (y + 2) * scale, 10 * scale, 10 * scale);
}

function toolRoi(fixtureId) {
  const { x, y, scale } = workerLayout();
  const miner = fixtureId.includes('classic-voxel-miner');
  const gx = Math.round((x + 31) * scale);
  const gy = Math.round((y + (miner ? 10 : 17)) * scale);
  return roi(gx, gy, (miner ? 30 : 26) * scale, (miner ? 12 : 8) * scale);
}

function bubbleRoi() {
  const subject = workerSubjectRoi();
  return roi(0, 0, WORKER_VIEWPORT.width, subject.y);
}

function decode(pngFile) {
  const buffer = fs.readFileSync(pngFile);
  const image = nativeImage.createFromBuffer(buffer, { scaleFactor: 1 });
  if (image.isEmpty()) throw new PreviewFailure('missing-output', `${pngFile} decoded empty`);
  const size = image.getSize();
  const buf = image.toBitmap();
  if (buf.length !== size.width * size.height * 4) {
    throw new PreviewFailure(
      'missing-output',
      `${pngFile} decode stride mismatch: expected ${size.width * size.height * 4}, got ${buf.length}`,
    );
  }
  return { width: size.width, height: size.height, buf };
}

function hasNontransparent(decoded) {
  for (let i = 3; i < decoded.buf.length; i += 4) {
    if (decoded.buf[i] !== 0) return true;
  }
  return false;
}

function clampRoi(r, width, height) {
  const x0 = Math.max(0, Math.min(width, r.x));
  const y0 = Math.max(0, Math.min(height, r.y));
  const x1 = Math.max(x0, Math.min(width, r.x + r.width));
  const y1 = Math.max(y0, Math.min(height, r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function containsPoint(r, x, y) {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

function isExcluded(excludes, x, y) {
  return excludes.some((r) => containsPoint(r, x, y));
}

function alphaBounds(decoded, subject, excludes = []) {
  const { width, height, buf } = decoded;
  const r = clampRoi(subject, width, height);
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = r.y; y < r.y + r.height; y += 1) {
    for (let x = r.x; x < r.x + r.width; x += 1) {
      if (isExcluded(excludes, x, y)) continue;
      const a = buf[(y * width + x) * 4 + 3];
      if (a !== 0) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  return { left, right, top, bottom };
}

function diffPixelAt(rbuf, cbuf, offset) {
  return (
    Math.abs(rbuf[offset] - cbuf[offset]) > THRESHOLD.channelDelta ||
    Math.abs(rbuf[offset + 1] - cbuf[offset + 1]) > THRESHOLD.channelDelta ||
    Math.abs(rbuf[offset + 2] - cbuf[offset + 2]) > THRESHOLD.channelDelta ||
    Math.abs(rbuf[offset + 3] - cbuf[offset + 3]) > THRESHOLD.channelDelta
  );
}

function exactDiffPixelAt(abuf, bbuf, offset) {
  return (
    abuf[offset] !== bbuf[offset] ||
    abuf[offset + 1] !== bbuf[offset + 1] ||
    abuf[offset + 2] !== bbuf[offset + 2] ||
    abuf[offset + 3] !== bbuf[offset + 3]
  );
}

function nonblankPixelCount(decoded, subject, excludes = []) {
  const { width, height, buf } = decoded;
  const r = clampRoi(subject, width, height);
  let count = 0;
  for (let y = r.y; y < r.y + r.height; y += 1) {
    for (let x = r.x; x < r.x + r.width; x += 1) {
      if (isExcluded(excludes, x, y)) continue;
      if (buf[(y * width + x) * 4 + 3] !== 0) count += 1;
    }
  }
  return count;
}

function exactChangedPixels(a, b, subject, excludes = []) {
  const r = clampRoi(subject, a.width, a.height);
  let changed = 0;
  for (let y = r.y; y < r.y + r.height; y += 1) {
    for (let x = r.x; x < r.x + r.width; x += 1) {
      if (isExcluded(excludes, x, y)) continue;
      const offset = (y * a.width + x) * 4;
      if (exactDiffPixelAt(a.buf, b.buf, offset)) changed += 1;
    }
  }
  return changed;
}

function foregroundMetrics(ref, cap, subject, excludes = []) {
  const r = clampRoi(subject, ref.width, ref.height);
  let foregroundCount = 0;
  let changedPixels = 0;
  for (let y = r.y; y < r.y + r.height; y += 1) {
    for (let x = r.x; x < r.x + r.width; x += 1) {
      if (isExcluded(excludes, x, y)) continue;
      const offset = (y * ref.width + x) * 4;
      const isFg = ref.buf[offset + 3] !== 0 || cap.buf[offset + 3] !== 0;
      if (!isFg) continue;
      foregroundCount += 1;
      if (diffPixelAt(ref.buf, cap.buf, offset)) changedPixels += 1;
    }
  }
  const ratio = foregroundCount > 0 ? changedPixels / foregroundCount : 0;
  return { changedPixels, foregroundCount, ratio };
}

function alphaBoundsDelta(refBounds, capBounds) {
  if (!refBounds || !capBounds) return null;
  return {
    left: Math.abs(refBounds.left - capBounds.left),
    top: Math.abs(refBounds.top - capBounds.top),
    right: Math.abs(refBounds.right - capBounds.right),
    bottom: Math.abs(refBounds.bottom - capBounds.bottom),
  };
}

function logicalBoundsDelta(delta, scale) {
  if (!delta) return null;
  return {
    left: Number((delta.left / scale).toFixed(6)),
    top: Number((delta.top / scale).toFixed(6)),
    right: Number((delta.right / scale).toFixed(6)),
    bottom: Number((delta.bottom / scale).toFixed(6)),
  };
}

function maxDelta(delta) {
  return Math.max(delta.left, delta.top, delta.right, delta.bottom);
}

function metricResult(ref, cap, subject, excludes, scale, fixtureId, label) {
  const refBounds = alphaBounds(ref, subject, excludes);
  const capBounds = alphaBounds(cap, subject, excludes);
  if (!refBounds) throw new PreviewFailure('blank-roi', `fixture ${fixtureId} reference ${label} ROI is blank`, fixtureId);
  if (!capBounds) throw new PreviewFailure('blank-roi', `fixture ${fixtureId} capture ${label} ROI is blank`, fixtureId);

  const deltaCss = alphaBoundsDelta(refBounds, capBounds);
  const delta = logicalBoundsDelta(deltaCss, scale);
  const metrics = foregroundMetrics(ref, cap, subject, excludes);
  const changedRatio = Number(metrics.ratio.toFixed(6));
  if (maxDelta(delta) > THRESHOLD.maxBoundsDelta) {
    throw new PreviewFailure(
      'reference-mismatch',
      `fixture ${fixtureId} ${label} alpha bounds differ by ${JSON.stringify(delta)} logical px`,
      fixtureId,
    );
  }
  if (metrics.foregroundCount > 0 && metrics.ratio > THRESHOLD.maxChangedRatio) {
    throw new PreviewFailure(
      'reference-mismatch',
      `fixture ${fixtureId} ${label} ${(metrics.ratio * 100).toFixed(2)}% foreground pixels exceed channel delta`,
      fixtureId,
    );
  }
  return {
    changedPixels: metrics.changedPixels,
    changedRatio,
    boundsDelta: delta,
    foregroundCount: metrics.foregroundCount,
  };
}

function assertSameDimensions(ref, cap, fixtureId) {
  if (ref.width !== cap.width || ref.height !== cap.height) {
    throw new PreviewFailure(
      'reference-mismatch',
      `fixture ${fixtureId} image dimensions differ (${ref.width}x${ref.height} vs ${cap.width}x${cap.height})`,
      fixtureId,
    );
  }
}

function assertNonblankImages(ref, cap, fixtureId) {
  if (!hasNontransparent(ref)) {
    throw new PreviewFailure('blank-roi', `fixture ${fixtureId} reference is blank`, fixtureId);
  }
  if (!hasNontransparent(cap)) {
    throw new PreviewFailure('blank-roi', `fixture ${fixtureId} capture is blank`, fixtureId);
  }
}

function isStrictWorkerFixture(fixtureId) {
  return /^worker-(skin|phase|badge)-/.test(fixtureId);
}

function matchingNoToolCapture(fixtureId) {
  if (fixtureId.includes('classic-voxel-miner')) {
    return path.join(captureDir(rootDir), 'worker-skin-classic-voxel-miner.png');
  }
  if (fixtureId.includes('blue-dash')) {
    return path.join(captureDir(rootDir), 'worker-skin-blue-dash.png');
  }
  return undefined;
}

function compareWorkerCapture(capturedPng, refPng, fixtureId) {
  const ref = decode(refPng);
  const cap = decode(capturedPng);
  assertNonblankImages(ref, cap, fixtureId);
  assertSameDimensions(ref, cap, fixtureId);

  const labelRoi = ageLabelRoi();
  if (nonblankPixelCount(cap, labelRoi) === 0) {
    throw new PreviewFailure('blank-roi', `fixture ${fixtureId} age-label ROI is blank`, fixtureId);
  }

  if (!isStrictWorkerFixture(fixtureId)) {
    const bodyExcludes = [labelRoi];
    if (/^worker-tool-/.test(fixtureId)) {
      const subject = toolRoi(fixtureId);
      if (nonblankPixelCount(ref, subject) === 0) {
        throw new PreviewFailure('blank-roi', `fixture ${fixtureId} reference tool ROI is blank`, fixtureId);
      }
      if (nonblankPixelCount(cap, subject) === 0) {
        throw new PreviewFailure('blank-roi', `fixture ${fixtureId} capture tool ROI is blank`, fixtureId);
      }
      const baselinePath = matchingNoToolCapture(fixtureId);
      if (!baselinePath || !fs.existsSync(baselinePath)) {
        throw new PreviewFailure('missing-output', `fixture ${fixtureId} missing no-tool baseline capture`, fixtureId);
      }
      const changedFromBaseline = exactChangedPixels(cap, decode(baselinePath), subject);
      if (changedFromBaseline === 0) {
        throw new PreviewFailure(
          'reference-mismatch',
          `fixture ${fixtureId} tool ROI does not differ from matching no-tool capture`,
          fixtureId,
        );
      }
      bodyExcludes.push(subject);
    } else if (/^worker-bubble-/.test(fixtureId)) {
      const subject = bubbleRoi();
      if (nonblankPixelCount(ref, subject) === 0) {
        throw new PreviewFailure('blank-roi', `fixture ${fixtureId} reference bubble ROI is blank`, fixtureId);
      }
      if (nonblankPixelCount(cap, subject) === 0) {
        throw new PreviewFailure('blank-roi', `fixture ${fixtureId} capture bubble ROI is blank`, fixtureId);
      }
    }
    return metricResult(ref, cap, workerSubjectRoi(), bodyExcludes, WORKER_VIEWPORT.scale, fixtureId, 'body-sanity');
  }

  const result = metricResult(ref, cap, workerSubjectRoi(), [labelRoi], WORKER_VIEWPORT.scale, fixtureId, 'subject');
  if (fixtureId === 'worker-badge-unknown') {
    const baselinePath = path.join(captureDir(rootDir), 'worker-skin-classic-voxel-miner.png');
    if (!fs.existsSync(baselinePath)) {
      throw new PreviewFailure('missing-output', `fixture ${fixtureId} missing no-badge baseline capture`, fixtureId);
    }
    const changed = exactChangedPixels(cap, decode(baselinePath), badgeRoi());
    if (changed > 0) {
      throw new PreviewFailure(
        'reference-mismatch',
        `fixture ${fixtureId} badge ROI differs from no-badge classic-voxel-miner baseline`,
        fixtureId,
      );
    }
  }
  return result;
}

function compareHouseCapture(capturedPng, refPng, fixtureId, diagnostics) {
  const ref = decode(refPng);
  const cap = decode(capturedPng);
  assertNonblankImages(ref, cap, fixtureId);
  assertSameDimensions(ref, cap, fixtureId);

  const result = metricResult(ref, cap, houseSubjectRoi(), [], HOUSE_VIEWPORT.scale, fixtureId, 'house-body');
  const exactChanged = exactChangedPixels(ref, cap, houseSubjectRoi());
  if (exactChanged > 0) {
    throw new PreviewFailure(
      'reference-mismatch',
      `fixture ${fixtureId} house-body exact pixel identity differs (${exactChanged} pixels)`,
      fixtureId,
    );
  }

  if (fixtureId === 'house-status-queued') {
    if (diagnostics?.status) {
      const r = roi(diagnostics.status.x, diagnostics.status.y, diagnostics.status.width, diagnostics.status.height);
      if (nonblankPixelCount(cap, r) > 0) {
        throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} status should be hidden`, fixtureId);
      }
    }
  } else if (fixtureId === 'house-broadcast-sticky') {
    if (diagnostics?.broadcast?.text !== '» Pixi migration ready') {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} broadcast text mismatch`, fixtureId);
    }
    if (!diagnostics?.broadcast || !diagnostics?.closeRect) {
      throw new PreviewFailure('blank-roi', `fixture ${fixtureId} missing broadcast close diagnostics`, fixtureId);
    }
    assertSemanticRoi(ref, cap, diagnostics.broadcast, fixtureId, 'broadcast');
    assertSemanticRoi(ref, cap, diagnostics.closeRect, fixtureId, 'close');
    const close = roi(
      diagnostics.closeRect.x,
      diagnostics.closeRect.y,
      diagnostics.closeRect.width,
      diagnostics.closeRect.height,
    );
    const closeHit = diagnostics.hitRects?.find((rect) => rect.target === 'broadcast-close');
    if (
      !closeHit ||
      Math.round(closeHit.x) !== close.x ||
      Math.round(closeHit.y) !== close.y ||
      Math.round(closeHit.width) !== close.width ||
      Math.round(closeHit.height) !== close.height
    ) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} broadcast-close hit rect mismatch`, fixtureId);
    }
    if (!diagnostics.hitRects?.some((rect) => rect.target === 'house')) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} missing house hit rect`, fixtureId);
    }
  } else if (fixtureId === 'house-stats-hover') {
    if (!(diagnostics?.stats?.text || '').startsWith('1 个任务运行中 · 2 张图纸')) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} stats text mismatch`, fixtureId);
    }
    const lines = diagnostics?.stats?.lines;
    if (!Array.isArray(lines) || lines.length < 7) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} stats lines missing or too few`, fixtureId);
    }
    // First line: Chinese activity (running + graph count) from the same snapshot
    if (!lines[0].startsWith('1 个任务运行中 · 2 张图纸')) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} first summary line mismatch`, fixtureId);
    }
    // Second line: token in/out/total
    if (!/^in 191 mtok · out 2 mtok · total 193 mtok$/.test(lines[1])) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} second summary line mismatch`, fixtureId);
    }
    const allText = lines.join(' ');
    const codexSparkMatches = allText.match(/codex-spark/g) || [];
    if (codexSparkMatches.length !== 1) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} expected codex-spark exactly once, got ${codexSparkMatches.length}`, fixtureId);
    }
    const kimiCodingMatches = allText.match(/kimi-coding/g) || [];
    if (kimiCodingMatches.length < 2) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} expected kimi-coding at least twice, got ${kimiCodingMatches.length}`, fixtureId);
    }
    if (!/super-grok/.test(allText)) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} stats lines missing super-grok provider`, fixtureId);
    }
    if (!/rate limit hit/.test(allText)) {
      throw new PreviewFailure('reference-mismatch', `fixture ${fixtureId} stats lines missing error text`, fixtureId);
    }
    assertSemanticRoi(ref, cap, diagnostics.stats, fixtureId, 'stats');
  }

  return result;
}

function assertSemanticRoi(ref, cap, subject, fixtureId, label) {
  if (!subject) {
    throw new PreviewFailure('blank-roi', `fixture ${fixtureId} missing ${label} layout diagnostics`, fixtureId);
  }
  const r = roi(subject.x, subject.y, subject.width, subject.height);
  if (nonblankPixelCount(ref, r) === 0) {
    throw new PreviewFailure('blank-roi', `fixture ${fixtureId} reference ${label} ROI is blank`, fixtureId);
  }
  if (nonblankPixelCount(cap, r) === 0) {
    throw new PreviewFailure('blank-roi', `fixture ${fixtureId} capture ${label} ROI is blank`, fixtureId);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStaticReady(win, fixture) {
  const caseId = caseIdForFixture(fixture);
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < CASE_TIMEOUT_MS) {
    lastState = await readRendererState(win).catch((error) => {
      throw new PreviewFailure('missing-output', `fixture ${caseId} renderer state read failed: ${error?.message ?? error}`, caseId);
    });
    if (lastState.contextLost === '1' || lastState.canvasContextLost === '1') {
      throw new PreviewFailure('context-loss', `fixture ${caseId} WebGL context lost`, caseId);
    }
    if (lastState.ready === '1') return lastState;
    await delay(POLL_MS);
  }
  throw new PreviewFailure(
    'missing-output',
    `fixture ${caseId} timed out waiting for static ready marker: ${JSON.stringify(lastState)}`,
    caseId,
  );
}

function readRendererState(win) {
  return win.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('scene');
    const api = window.petApi;
    return {
      ready: document.documentElement.dataset.${STATIC_PREVIEW_READY_DATASET} || '',
      contextLost: document.documentElement.dataset.${STATIC_PREVIEW_CONTEXT_LOST_DATASET} || '',
      canvasContextLost: canvas && canvas.dataset.${STATIC_PREVIEW_CONTEXT_LOST_DATASET} || '',
      contextMarker: canvas && canvas.dataset.${STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET} || '',
      apiMethods: api && typeof api === 'object' ? Object.keys(api) : null,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      output: window.${STATIC_PREVIEW_OUTPUT_KEY} || null
    };
  })()`, true);
}

function verifyRendererState(state, fixture) {
  const caseId = caseIdForFixture(fixture);
  const expectedApi = PET_API_METHOD_NAMES.join(',');
  if (!Array.isArray(state.apiMethods) || state.apiMethods.join(',') !== expectedApi) {
    throw new PreviewFailure(
      'missing-pet-api',
      `fixture ${caseId} petApi methods mismatch: ${JSON.stringify(state.apiMethods)}`,
      caseId,
    );
  }
  const viewport = viewportForFixture(fixture);
  if (state.width !== viewport.width || state.height !== viewport.height || state.dpr !== 1) {
    throw new PreviewFailure(
      'manifest-mismatch',
      `fixture ${caseId} viewport/DPR mismatch: ${state.width}x${state.height} DPR ${state.dpr}`,
      caseId,
    );
  }
  if (state.contextMarker !== '1') {
    throw new PreviewFailure('context-loss', `fixture ${caseId} missing WebGL context-loss marker`, caseId);
  }
  if (state.contextLost === '1' || state.canvasContextLost === '1') {
    throw new PreviewFailure('context-loss', `fixture ${caseId} WebGL context lost`, caseId);
  }
}

function createWindow(fixture, rejectOnce) {
  const viewport = viewportForFixture(fixture);
  const caseId = caseIdForFixture(fixture);
  const win = new BrowserWindow({
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    frame: false,
    transparent: true,
    show: false,
    backgroundColor: '#00000000',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
      backgroundThrottling: false,
      additionalArguments: additionalArgumentsForFixture(fixture),
      preload: preloadPath,
    },
  });

  win.webContents.on('preload-error', (_event, preload, error) => {
    rejectOnce(new PreviewFailure('preload-error', `fixture ${caseId} preload ${preload}: ${error?.message ?? error}`, caseId));
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) {
      rejectOnce(new PreviewFailure('console-error', `fixture ${caseId} renderer console error: ${message}`, caseId));
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    rejectOnce(new PreviewFailure('render-process-gone', `fixture ${caseId} render process gone: ${JSON.stringify(details)}`, caseId));
  });

  return win;
}

async function closeWindow(win) {
  if (!win || win.isDestroyed()) return;
  await new Promise((resolve) => {
    win.once('closed', resolve);
    win.close();
    setTimeout(resolve, 1000);
  });
}

async function captureFixture(fixture) {
  const caseId = caseIdForFixture(fixture);
  const htmlPath = htmlPathForFixture(rootDir, fixture);
  const outFile = outputPathForFixture(rootDir, fixture);
  if (!fs.existsSync(htmlPath)) {
    throw new PreviewFailure('missing-output', `fixture ${caseId} missing production HTML: ${htmlPath}`, caseId);
  }

  let win;
  let rejectAsync;
  let settled = false;
  const asyncFailure = new Promise((_, reject) => {
    rejectAsync = reject;
  });
  const rejectOnce = (error) => {
    if (settled) return;
    settled = true;
    rejectAsync(error);
  };

  try {
    win = createWindow(fixture, rejectOnce);
    const captureWork = (async () => {
      await win.loadFile(htmlPath, { query: staticQueryForFixture(fixture) });
      const state = await waitForStaticReady(win, fixture);
      verifyRendererState(state, fixture);
      const image = await win.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) {
        throw new PreviewFailure('missing-output', `fixture ${caseId} capturePage returned empty image`, caseId);
      }
      fs.writeFileSync(outFile, image.toPNG());
      if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
        throw new PreviewFailure('missing-output', `fixture ${caseId} output image was not written`, caseId);
      }
      const afterCapture = await readRendererState(win);
      verifyRendererState(afterCapture, fixture);
      return { file: outFile, diagnostics: state.output };
    })();
    return await Promise.race([captureWork, asyncFailure]);
  } catch (error) {
    if (error instanceof PreviewFailure) throw error;
    throw new PreviewFailure('missing-output', `fixture ${caseId} capture failed: ${error?.message ?? error}`, caseId);
  } finally {
    settled = true;
    await closeWindow(win);
  }
}

function compareFixture(fixture, captured) {
  const caseId = caseIdForFixture(fixture);
  const reference = referencePathForFixture(rootDir, fixture);
  if (!fs.existsSync(reference)) {
    throw new PreviewFailure('reference-mismatch', `fixture ${caseId} missing reference: ${reference}`, caseId);
  }
  const compare = fixture.kind === 'house'
    ? compareHouseCapture(captured.file, reference, caseId, captured.diagnostics)
    : compareWorkerCapture(captured.file, reference, caseId);
  return buildManifestCase({
    fixture,
    rootDir,
    referenceSha256: sha256(reference),
    outputSha256: sha256(captured.file),
    compare,
  });
}

function validateManifestHashes(manifest) {
  for (const item of manifest.cases) {
    const output = path.join(rootDir, item.file);
    const reference = path.join(rootDir, item.reference);
    if (!fs.existsSync(output) || !fs.existsSync(reference)) {
      throw new PreviewFailure('manifest-mismatch', `manifest hash path missing for ${item.id}`, item.id);
    }
    if (sha256(output) !== item.outputSha256 || sha256(reference) !== item.referenceSha256) {
      throw new PreviewFailure('manifest-mismatch', `manifest hash mismatch for ${item.id}`, item.id);
    }
  }
}

async function run() {
  if (PREVIEW_FIXTURES.length !== 34) {
    throw new PreviewFailure('manifest-mismatch', `expected 34 fixtures, saw ${PREVIEW_FIXTURES.length}`);
  }
  fs.mkdirSync(captureDir(rootDir), { recursive: true });
  removeSuccessManifest(rootDir);

  const cases = [];
  const refreshedFixtures = [];
  for (const fixture of PREVIEW_FIXTURES) {
    const caseId = caseIdForFixture(fixture);
    const captured = await captureFixture(fixture);
    const refPath = referencePathForFixture(rootDir, fixture);

    if (UPDATE_HOUSE_REFS && fixture.kind === 'house') {
      fs.mkdirSync(path.dirname(refPath), { recursive: true });
      fs.copyFileSync(captured.file, refPath);
      console.log(`[refresh] ${caseId} reference updated`);
      refreshedFixtures.push(caseId);
      const manifestCase = compareFixture(fixture, captured);
      cases.push(manifestCase);
      console.log(`[capture] ${caseId} passed`);
    } else {
      const manifestCase = compareFixture(fixture, captured);
      cases.push(manifestCase);
      console.log(`[capture] ${caseId} passed`);
    }
  }

  const manifest = buildManifest(cases);
  const serialized = serializeManifest(manifest);
  fs.writeFileSync(manifestPath, serialized);
  const reread = fs.readFileSync(manifestPath, 'utf8');
  const validation = validateSerializedManifest(reread, manifest);
  if (!validation.ok) {
    throw new PreviewFailure('manifest-mismatch', validation.details);
  }
  const parsed = JSON.parse(reread);
  if (!UPDATE_HOUSE_REFS) {
    validateManifestHashes(parsed);
  }
  if (UPDATE_HOUSE_REFS) {
    const refreshedPath = path.join(captureDir(rootDir), 'refreshed-house-fixtures.json');
    fs.writeFileSync(refreshedPath, JSON.stringify({ refreshed: refreshedFixtures }, null, 2));
    console.log(`[refresh] wrote ${refreshedPath} with ${refreshedFixtures.length} refreshed house fixtures`);
  }
  console.log(`[capture] all ${PREVIEW_FIXTURES.length} fixtures passed`);
}

app.whenReady().then(() => {
  run()
    .then(() => app.quit())
    .catch((error) => {
      const reason = FAILURE_REASONS.includes(error?.reason) ? error.reason : 'manifest-mismatch';
      emitFailure(reason, error?.details ?? error?.message ?? String(error), error?.caseId);
      app.exit(1);
    });
});

app.on('window-all-closed', () => app.quit());
