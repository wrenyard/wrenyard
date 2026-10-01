#!/usr/bin/env electron
/**
 * Theme icon pipeline.
 *
 * - paper: crop of the reference illustration (cream square, no page, no
 *   caption). The cropped 1024/256 PNGs feed the theme package and the Windows
 *   icons. macOS shows an image verbatim, so a separate `icon-mac-1024.png`
 *   bakes the squircle and the transparent margin; the same macOS composition
 *   drives the native installer `.icns`.
 * - neutral: hand-authored SVG (`packages/themes/src/neutral/assets/icon.svg`)
 *   captured through an Electron offscreen window at 1024 and 256, then given
 *   the same macOS squircle treatment.
 *
 * Run through Electron (see the `icon` package script) because the SVG capture
 * needs a Chromium surface.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { BrowserWindow, app } from 'electron';

const toolsDir = import.meta.dirname;
const rootDir = join(toolsDir, '..', '..', '..');
const resourcesDir = join(toolsDir, '..', 'resources');
const sourcePath = join(resourcesDir, 'icon-source.png');
const paperAssetsDir = join(rootDir, 'packages', 'themes', 'src', 'paper', 'assets');
const neutralAssetsDir = join(rootDir, 'packages', 'themes', 'src', 'neutral', 'assets');
const neutralSvgPath = join(neutralAssetsDir, 'icon.svg');

const CAPTURE_FALLBACK_MS = 400;

// macOS app-icon grid: an 824×824 rounded square (radius 185) centered on a
// 1024×1024 canvas, leaving a transparent margin around it.
const MAC_CANVAS_SIZE = 1024;
const MAC_RECT_SIZE = 824;
const MAC_CORNER_RADIUS = 185;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePngBuffer(buf, label = 'buffer') {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`not a PNG: ${label}`);
  }
  let off = 8;
  let w;
  let h;
  let ctype;
  const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    off += 4;
    const type = buf.subarray(off, off + 4).toString();
    off += 4;
    const data = buf.subarray(off, off + len);
    off += len + 4;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ctype = data[9];
    }
    if (type === 'IDAT') idats.push(data);
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : 4;
  const stride = w * ch;
  let i = 0;
  let prev = Buffer.alloc(stride);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const ft = raw[i++];
    const row = Buffer.alloc(stride);
    raw.copy(row, 0, i, i + stride);
    i += stride;
    if (ft === 1) {
      for (let x = 0; x < stride; x++) row[x] = (row[x] + (x >= ch ? row[x - ch] : 0)) & 255;
    } else if (ft === 2) {
      for (let x = 0; x < stride; x++) row[x] = (row[x] + prev[x]) & 255;
    } else if (ft === 3) {
      for (let x = 0; x < stride; x++) {
        row[x] = (row[x] + Math.floor(((x >= ch ? row[x - ch] : 0) + prev[x]) / 2)) & 255;
      }
    } else if (ft === 4) {
      for (let x = 0; x < stride; x++) {
        row[x] = (row[x] + paeth(x >= ch ? row[x - ch] : 0, prev[x], x >= ch ? prev[x - ch] : 0)) & 255;
      }
    } else if (ft !== 0) {
      throw new Error(`unsupported PNG filter ${ft}`);
    }
    rows.push(row);
    prev = row;
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = x * ch;
      const di = (y * w + x) * 4;
      rgba[di] = rows[y][si];
      rgba[di + 1] = rows[y][si + 1];
      rgba[di + 2] = rows[y][si + 2];
      rgba[di + 3] = ch === 4 ? rows[y][si + 3] : 255;
    }
  }
  return { w, h, rgba };
}

function decodePng(path) {
  return decodePngBuffer(readFileSync(path), path);
}

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(path, size, rgba) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(size, rgba));
}

function sample(img, x, y) {
  const ix = Math.max(0, Math.min(img.w - 1, x));
  const iy = Math.max(0, Math.min(img.h - 1, y));
  const i = (iy * img.w + ix) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}

function lanczos(x, a = 2) {
  if (x === 0) return 1;
  if (Math.abs(x) >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

function scaleRgba(img, size) {
  const rgba = Buffer.alloc(size * size * 4);
  const a = 2;
  for (let y = 0; y < size; y++) {
    const sy = ((y + 0.5) * img.h) / size - 0.5;
    for (let x = 0; x < size; x++) {
      const sx = ((x + 0.5) * img.w) / size - 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      const x0 = Math.floor(sx) - a + 1;
      const y0 = Math.floor(sy) - a + 1;
      const x1 = Math.floor(sx) + a;
      const y1 = Math.floor(sy) + a;
      for (let iy = y0; iy <= y1; iy++) {
        const wy = lanczos(sy - iy, a);
        if (wy === 0) continue;
        for (let ix = x0; ix <= x1; ix++) {
          const wx = lanczos(sx - ix, a);
          const w = wx * wy;
          if (w === 0) continue;
          const p = sample(img, ix, iy);
          r += p[0] * w;
          g += p[1] * w;
          b += p[2] * w;
          wsum += w;
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = Math.max(0, Math.min(255, Math.round(r / wsum)));
      rgba[i + 1] = Math.max(0, Math.min(255, Math.round(g / wsum)));
      rgba[i + 2] = Math.max(0, Math.min(255, Math.round(b / wsum)));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** Source-over a straight-alpha color onto an RGBA buffer. */
function blendPixel(dst, index, r, g, b, a) {
  if (a <= 0) return;
  const dstA = dst[index + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  dst[index] = Math.round((r * a + dst[index] * dstA * (1 - a)) / outA);
  dst[index + 1] = Math.round((g * a + dst[index + 1] * dstA * (1 - a)) / outA);
  dst[index + 2] = Math.round((b * a + dst[index + 2] * dstA * (1 - a)) / outA);
  dst[index + 3] = Math.round(outA * 255);
}

/** Separable box blur; two passes approximate a Gaussian falloff. */
function blurAlpha(source, width, height, radius, passes) {
  const a = Float32Array.from(source);
  const b = new Float32Array(source.length);
  const norm = 1 / (radius * 2 + 1);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[row + Math.max(0, Math.min(width - 1, k))];
      for (let x = 0; x < width; x++) {
        b[row + x] = sum * norm;
        sum += a[row + Math.min(width - 1, x + radius + 1)] - a[row + Math.max(0, x - radius)];
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += b[Math.max(0, Math.min(height - 1, k)) * width + x];
      for (let y = 0; y < height; y++) {
        a[y * width + x] = sum * norm;
        sum += b[Math.min(height - 1, y + radius + 1) * width + x] - b[Math.max(0, y - radius) * width + x];
      }
    }
  }
  return a;
}

/**
 * Compose a macOS app icon at `size`: the scene is scaled into a rounded square
 * (824×824, radius 185 at 1024) centered on a transparent canvas, with a faint
 * drop shadow. macOS shows this image verbatim, so the squircle and the
 * transparent margin must be part of the pixels.
 */
function composeMacIcon(scene, size) {
  const rect = Math.max(1, Math.round((size * MAC_RECT_SIZE) / MAC_CANVAS_SIZE));
  const radius = (size * MAC_CORNER_RADIUS) / MAC_CANVAS_SIZE;
  const inset = Math.round((size - rect) / 2);
  const inner = scaleRgba(scene, rect);
  const out = Buffer.alloc(size * size * 4);

  // Rounded-rect coverage with ~1px antialiasing (signed distance field).
  const coverage = new Float32Array(size * size);
  const center = size / 2;
  const straight = rect / 2 - radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x + 0.5 - center) - straight;
      const dy = Math.abs(y + 0.5 - center) - straight;
      const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2);
      const inside = Math.min(Math.max(dx, dy), 0);
      coverage[y * size + x] = Math.max(0, Math.min(1, 0.5 - (outside + inside - radius)));
    }
  }

  // Faint drop shadow behind the squircle, matching the system icon look.
  const shadowRadius = Math.max(1, Math.round(size * 0.014));
  const shadowOffset = Math.round(size * 0.012);
  const shadow = blurAlpha(coverage, size, size, shadowRadius, 2);
  for (let y = 0; y < size; y++) {
    const sy = Math.max(0, Math.min(size - 1, y - shadowOffset));
    for (let x = 0; x < size; x++) {
      const alpha = shadow[sy * size + x] * 0.16;
      if (alpha > 0) blendPixel(out, (y * size + x) * 4, 0, 0, 0, alpha);
    }
  }

  // Scene clipped to the squircle.
  for (let y = 0; y < size; y++) {
    const iy = y - inset;
    if (iy < 0 || iy >= rect) continue;
    for (let x = 0; x < size; x++) {
      const cover = coverage[y * size + x];
      if (cover <= 0) continue;
      const ix = x - inset;
      if (ix < 0 || ix >= rect) continue;
      const si = (iy * rect + ix) * 4;
      blendPixel(out, (y * size + x) * 4, inner[si], inner[si + 1], inner[si + 2], (inner[si + 3] / 255) * cover);
    }
  }
  return out;
}

function renderPaper() {
  const source = decodePng(sourcePath);
  if (source.w !== source.h) {
    throw new Error(`icon-source.png must be square, got ${source.w}×${source.h}`);
  }

  writeFileSync(
    join(resourcesDir, 'icon.svg'),
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <image href="icon.png" width="1024" height="1024"/>
</svg>
`,
  );
  writePng(join(resourcesDir, 'icon.png'), 1024, scaleRgba(source, 1024));
  writePng(join(resourcesDir, 'icon-256.png'), 256, scaleRgba(source, 256));

  // Feed the paper theme package with the same crop plus the macOS squircle
  // variant that the Dock renders verbatim.
  mkdirSync(paperAssetsDir, { recursive: true });
  writePng(join(paperAssetsDir, 'icon-1024.png'), 1024, scaleRgba(source, 1024));
  writePng(join(paperAssetsDir, 'icon-256.png'), 256, scaleRgba(source, 256));
  writePng(join(paperAssetsDir, 'icon-mac-1024.png'), MAC_CANVAS_SIZE, composeMacIcon(source, MAC_CANVAS_SIZE));

  if (process.platform === 'darwin') {
    const iconset = join(resourcesDir, 'icon.iconset');
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset, { recursive: true });
    const sizes = [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ];
    for (const [size, name] of sizes) {
      writePng(join(iconset, name), size, composeMacIcon(source, size));
    }
    const icns = join(resourcesDir, 'icon.icns');
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || 'iconutil failed');
    }
    rmSync(iconset, { recursive: true, force: true });
  }
}

function waitForPaint(win, fallbackMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    win.webContents.once('paint', finish);
    setTimeout(finish, fallbackMs);
  });
}

async function captureSvg(svgPath, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    frame: false,
    transparent: true,
    show: false,
    backgroundColor: '#00000000',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await win.loadFile(svgPath);
    await waitForPaint(win, CAPTURE_FALLBACK_MS);
    const image = await win.capturePage();
    if (image.isEmpty()) {
      throw new Error(`offscreen capture of ${svgPath} returned an empty image`);
    }
    const actual = image.getSize();
    if (actual.width !== actual.height || actual.width < size) {
      throw new Error(`offscreen capture of ${svgPath} is ${actual.width}×${actual.height}, expected at least ${size}×${size} square`);
    }
    return image;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function renderNeutral() {
  // Physical pixels depend on the display scale factor; normalize to 1024.
  const captured = await captureSvg(neutralSvgPath, 1024);
  mkdirSync(neutralAssetsDir, { recursive: true });
  const icon1024 = captured.resize({ width: 1024, height: 1024, quality: 'best' });
  writeFileSync(join(neutralAssetsDir, 'icon-1024.png'), icon1024.toPNG());
  writeFileSync(join(neutralAssetsDir, 'icon-256.png'), icon1024.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  const scene = decodePngBuffer(icon1024.toPNG(), 'neutral capture');
  writeFileSync(
    join(neutralAssetsDir, 'icon-mac-1024.png'),
    encodePng(MAC_CANVAS_SIZE, composeMacIcon(scene, MAC_CANVAS_SIZE)),
  );
  return join(neutralAssetsDir, 'icon-256.png');
}

async function main() {
  renderPaper();
  const neutral256 = await renderNeutral();
  console.log(`wrote ${join(resourcesDir, 'icon.png')}, icon-256.png, icon.svg${process.platform === 'darwin' ? ', icon.icns' : ''}`);
  console.log(`wrote ${join(paperAssetsDir, 'icon-1024.png')}, ${join(paperAssetsDir, 'icon-256.png')}, ${join(paperAssetsDir, 'icon-mac-1024.png')}`);
  console.log(`wrote ${neutral256} (256), ${join(neutralAssetsDir, 'icon-1024.png')} (1024), ${join(neutralAssetsDir, 'icon-mac-1024.png')} (1024)`);
}

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    app.exit(1);
  });

app.on('window-all-closed', () => app.quit());
