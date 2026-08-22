import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const resources = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');

test('Desktop app icon is a 1024×1024 crop of the three wrens', async () => {
  const png = await readFile(join(resources, 'icon.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[25], 6, 'expected RGBA');
  assert.ok(png.length > 20_000, 'raster crop should be larger than the old vector PNG');

  const source = await readFile(join(resources, 'icon-source.png'));
  assert.equal(source.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(source.readUInt32BE(16), source.readUInt32BE(20), 'source crop must be square');

  const svg = await readFile(join(resources, 'icon.svg'), 'utf8');
  assert.match(svg, /icon\.png/);
  assert.doesNotMatch(svg, /一群小鸟工坊/);
});
