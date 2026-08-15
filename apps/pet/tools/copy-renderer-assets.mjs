#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

fs.mkdirSync(path.join(root, 'dist', 'renderer'), { recursive: true });

const srcDir = path.join(root, 'src');
const outDir = path.join(root, 'dist', 'renderer');

// HTML files
fs.copyFileSync(path.join(srcDir, 'overlay', 'house', 'index.html'), path.join(outDir, 'house.html'));
fs.copyFileSync(path.join(srcDir, 'overlay', 'worker', 'index.html'), path.join(outDir, 'worker.html'));
fs.copyFileSync(path.join(srcDir, 'overlay', 'taskgraph-entity', 'index.html'), path.join(outDir, 'entity.html'));
fs.copyFileSync(path.join(srcDir, 'panels', 'stats', 'index.html'), path.join(outDir, 'stats.html'));
fs.copyFileSync(path.join(srcDir, 'panels', 'settings', 'index.html'), path.join(outDir, 'settings.html'));
fs.copyFileSync(path.join(srcDir, 'panels', 'transcript', 'index.html'), path.join(outDir, 'transcript.html'));
fs.copyFileSync(path.join(srcDir, 'panels', 'observatory', 'index.html'), path.join(outDir, 'graph-slip.html'));
fs.copyFileSync(path.join(srcDir, 'panels', 'panel.css'), path.join(outDir, 'panel.css'));
