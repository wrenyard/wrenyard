#!/usr/bin/env node
/**
 * Official 啾啾工坊 Desktop icon: crop of the reference illustration.
 * Source is the cream square (no page, no squircle mask, no caption).
 * macOS applies the Dock/app squircle; do not bake rounded corners.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const outDir = join(import.meta.dirname, '..', 'resources');
const sourcePath = join(outDir, 'icon-source.png');

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(path) {
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`not a PNG: ${path}`);
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

function writePng(path, size, rgba) {
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
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

const source = decodePng(sourcePath);
if (source.w !== source.h) {
  throw new Error(`icon-source.png must be square, got ${source.w}×${source.h}`);
}

writeFileSync(
  join(outDir, 'icon.svg'),
  `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <image href="icon.png" width="1024" height="1024"/>
</svg>
`,
);
writePng(join(outDir, 'icon.png'), 1024, scaleRgba(source, 1024));
writePng(join(outDir, 'icon-256.png'), 256, scaleRgba(source, 256));

if (process.platform === 'darwin') {
  const iconset = join(outDir, 'icon.iconset');
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
    writePng(join(iconset, name), size, scaleRgba(source, size));
  }
  const icns = join(outDir, 'icon.icns');
  const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'iconutil failed');
  }
  rmSync(iconset, { recursive: true, force: true });
  console.log(`wrote ${join(outDir, 'icon.png')}, icon-256.png, icon.svg, icon.icns`);
} else {
  console.log(`wrote ${join(outDir, 'icon.png')}, icon-256.png, icon.svg`);
}
