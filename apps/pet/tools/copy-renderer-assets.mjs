#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

fs.mkdirSync(path.join(root, 'dist', 'renderer'), { recursive: true });

const srcDir = path.join(root, 'src');
const outDir = path.join(root, 'dist', 'renderer');

// Remove renderer assets from product surfaces that now belong to Desktop.
for (const retired of ['settings.html', 'settings.js', 'stats.html', 'stats.js', 'panel.css']) {
  fs.rmSync(path.join(outDir, retired), { force: true });
}

// HTML files
fs.copyFileSync(path.join(srcDir, 'overlay', 'house', 'index.html'), path.join(outDir, 'house.html'));
fs.copyFileSync(path.join(srcDir, 'overlay', 'worker', 'index.html'), path.join(outDir, 'worker.html'));
fs.copyFileSync(path.join(srcDir, 'overlay', 'taskgraph-entity', 'index.html'), path.join(outDir, 'entity.html'));
fs.copyFileSync(path.join(srcDir, 'panels', 'transcript', 'index.html'), path.join(outDir, 'transcript.html'));
fs.copyFileSync(path.join(srcDir, 'panels', 'observatory', 'index.html'), path.join(outDir, 'graph-slip.html'));
