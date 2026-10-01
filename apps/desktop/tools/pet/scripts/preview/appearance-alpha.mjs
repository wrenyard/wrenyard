// Appearance alpha smoke for the Pet transparency fix (P0).
//
// This module is deliberately separate from `preview-capture.mjs`, whose
// contract forbids bundling: it must use the production `dist/web` HTML only.
// The alpha check needs the real Electron window factory and appearance
// controller instead, so it bundles those two main-process sources (the same
// esbuild approach the TaskGraph harness uses) and runs them for real.

import { nativeImage } from 'electron';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  STATIC_PREVIEW_READY_DATASET,
  additionalArgumentsForFixture,
  captureDir,
  caseIdForFixture,
  htmlPathForFixture,
  staticQueryForFixture,
  viewportForFixture,
} from './capture-contract.mjs';
import { PREVIEW_FIXTURES } from './fixtures.mjs';

const require = createRequire(import.meta.url);

const POLL_MS = 25;
const CASE_TIMEOUT_MS = 20000;
const ALPHA_CORNER_SIZE = 8;

class AppearanceAlphaFailure extends Error {
  constructor(reason, details, caseId) {
    super(details);
    this.reason = reason;
    this.details = details;
    this.caseId = caseId;
  }
}

/** Bundle the production overlay factory and appearance controller. */
async function loadAppearanceHarness(rootDir) {
  const { build } = await import('esbuild');
  const outdir = path.join(captureDir(rootDir), 'appearance-harness');
  fs.mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints: {
      'overlay-window': path.join(rootDir, 'src', 'pet', 'main', 'windows', 'overlay-window.ts'),
      appearance: path.join(rootDir, 'src', 'main', 'appearance.ts'),
    },
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'silent',
  });
  return {
    createOverlayWindow: require(path.join(outdir, 'overlay-window.cjs')).createOverlayWindow,
    DesktopAppearanceController: require(path.join(outdir, 'appearance.cjs')).DesktopAppearanceController,
  };
}

function decode(pngFile) {
  const buffer = fs.readFileSync(pngFile);
  const image = nativeImage.createFromBuffer(buffer, { scaleFactor: 1 });
  if (image.isEmpty()) throw new Error(`${pngFile} decoded empty`);
  const size = image.getSize();
  const buf = image.toBitmap();
  if (buf.length !== size.width * size.height * 4) {
    throw new Error(`${pngFile} decode stride mismatch`);
  }
  return { width: size.width, height: size.height, buf };
}

/** True when at least one pixel is non-transparent (the scene actually painted). */
function hasNontransparent(decoded) {
  const { buf } = decoded;
  for (let i = 3; i < buf.length; i += 4) {
    if (buf[i] !== 0) return true;
  }
  return false;
}

/** First non-zero-alpha pixel in any window corner, or null when all are clear. */
function opaqueCornerPixel(decoded, size) {
  const { width, height, buf } = decoded;
  const origins = [
    [0, 0],
    [width - size, 0],
    [0, height - size],
    [width - size, height - size],
  ];
  for (const [ox, oy] of origins) {
    for (let y = oy; y < oy + size; y += 1) {
      for (let x = ox; x < ox + size; x += 1) {
        if (buf[(y * width + x) * 4 + 3] !== 0) return { x, y };
      }
    }
  }
  return null;
}

async function waitForPreviewReady(win, caseId) {
  const deadline = Date.now() + CASE_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await win.webContents
      .executeJavaScript(`document.documentElement.dataset.${STATIC_PREVIEW_READY_DATASET} || ''`, true)
      .catch(() => '');
    if (last === '1') return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new AppearanceAlphaFailure('missing-output', `appearance smoke ${caseId} timed out waiting for preview ready`, caseId);
}

/**
 * The only check that directly proves overlay transparency. `getBackgroundColor`
 * cannot be used: it drops the alpha channel, which is exactly the bug being
 * guarded here. A real overlay window is created through the production factory,
 * a real `AppearanceController.refresh()` runs, and the four window corners must
 * stay fully transparent in both light and dark.
 */
export async function runAppearanceAlphaSmoke({ rootDir, preloadPath }) {
  const { createOverlayWindow, DesktopAppearanceController } = await loadAppearanceHarness(rootDir);
  const fixture = PREVIEW_FIXTURES.find((candidate) => candidate.kind === 'house');
  if (!fixture) {
    throw new AppearanceAlphaFailure('manifest-mismatch', 'appearance smoke requires a house fixture');
  }
  const viewport = viewportForFixture(fixture);
  const htmlPath = htmlPathForFixture(rootDir, fixture);
  if (!fs.existsSync(htmlPath)) {
    throw new AppearanceAlphaFailure('missing-output', `appearance smoke missing house HTML: ${htmlPath}`);
  }

  const outputs = [];
  for (const colorMode of ['light', 'dark']) {
    const caseId = `${caseIdForFixture(fixture)}-alpha-${colorMode}`;
    // Minimal store: the smoke only needs the resolved appearance, not persistence.
    const store = {
      load: () => ({ appearance: { theme: 'paper', colorMode, motion: 'reduce', zoom: 100 } }),
      patch: () => undefined,
    };
    const controller = new DesktopAppearanceController({ store });
    controller.init();
    let win;
    try {
      win = createOverlayWindow({
        width: viewport.width,
        height: viewport.height,
        preloadPath,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          offscreen: false,
          backgroundThrottling: false,
          additionalArguments: additionalArgumentsForFixture(fixture),
        },
      });
      await win.loadFile(htmlPath, { query: staticQueryForFixture(fixture) });
      await waitForPreviewReady(win, caseId);
      // The regression: refresh must never paint a transparent overlay.
      controller.refresh();
      const image = await win.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) {
        throw new AppearanceAlphaFailure('missing-output', `appearance smoke ${caseId} capturePage returned empty image`, caseId);
      }
      const outFile = path.join(captureDir(rootDir), `appearance-alpha-${colorMode}.png`);
      fs.writeFileSync(outFile, image.toPNG());
      const decoded = decode(outFile);
      if (decoded.width !== viewport.width || decoded.height !== viewport.height) {
        throw new AppearanceAlphaFailure(
          'manifest-mismatch',
          `appearance smoke ${caseId} unexpected size ${decoded.width}x${decoded.height}`,
          caseId,
        );
      }
      if (!hasNontransparent(decoded)) {
        throw new AppearanceAlphaFailure(
          'blank-roi',
          `appearance smoke ${caseId} window painted nothing; corner check would be vacuous`,
          caseId,
        );
      }
      const opaque = opaqueCornerPixel(decoded, ALPHA_CORNER_SIZE);
      if (opaque) {
        throw new AppearanceAlphaFailure(
          'reference-mismatch',
          `appearance smoke ${caseId} corner pixel alpha != 0 at ${opaque.x},${opaque.y}`,
          caseId,
        );
      }
      outputs.push(outFile);
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
      controller.dispose();
    }
  }
  return outputs;
}
