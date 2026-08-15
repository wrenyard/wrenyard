import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseWebUrl, prepareProfile } from '../src/profile.js';

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-profile-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeShellSource(dir: string): Promise<string> {
  const src = join(dir, 'shell-src');
  await mkdir(join(src, 'src'), { recursive: true });
  await writeFile(join(src, 'package.json'), JSON.stringify({ name: '@wrenyard/dsh-shell', version: '1.0.0-dev.0' }));
  await writeFile(join(src, 'cordis.patch.yml'), '# shell patch\n');
  await writeFile(join(src, 'src', 'index.js'), 'module.exports = {};\n');
  return src;
}

test('prepareProfile composes an isolated web profile from packaged resources', async () => {
  await withTemp(async (dir) => {
    const dshHome = join(dir, 'dsh-home');
    const src = await makeShellSource(dir);
    const profile = await prepareProfile(dshHome, src);

    assert.equal(profile.profileDir, join(dshHome, 'profiles', 'web'));
    assert.equal(await readFile(join(profile.shellModuleDir, 'src', 'index.js'), 'utf8'), 'module.exports = {};\n');

    const manifest = JSON.parse(await readFile(profile.packageJsonPath, 'utf8'));
    assert.equal(manifest.name, '@wrenyard/dsh-profile');
    assert.equal(manifest.private, true);
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@wrenyard/dsh-shell',
    ]);

    const patch = await readFile(profile.cordisPatchPath, 'utf8');
    assert.ok(patch.startsWith('# Managed by @wrenyard/desktop'));
  });
});

test('prepareProfile re-copies the managed bundle on update', async () => {
  await withTemp(async (dir) => {
    const dshHome = join(dir, 'dsh-home');
    const src = await makeShellSource(dir);
    const first = await prepareProfile(dshHome, src);

    await writeFile(join(first.shellModuleDir, 'src', 'index.js'), 'module.exports = { hacked: true };\n');
    const second = await prepareProfile(dshHome, src);

    assert.equal(await readFile(join(second.shellModuleDir, 'src', 'index.js'), 'utf8'), 'module.exports = {};\n');
  });
});

test('prepareProfile leaves unrelated profile content untouched', async () => {
  await withTemp(async (dir) => {
    const dshHome = join(dir, 'dsh-home');
    const src = await makeShellSource(dir);
    const otherDir = join(dshHome, 'profiles', 'web', 'node_modules', 'other');
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, 'keep.js'), 'keep\n');

    await prepareProfile(dshHome, src);

    assert.equal(await readFile(join(otherDir, 'keep.js'), 'utf8'), 'keep\n');
  });
});

test('prepareProfile links the packaged DeepSeek scope for profile resolution', async () => {
  await withTemp(async (dir) => {
    const src = await makeShellSource(dir);
    const modules = join(dir, 'runtime-modules');
    const deepseek = join(modules, '@deepseek-ai');
    await mkdir(join(deepseek, 'fixture'), { recursive: true });

    const profile = await prepareProfile(join(dir, 'dsh-home'), src, modules);
    assert.ok(profile.deepseekModulesLink);
    assert.equal(await realpath(profile.deepseekModulesLink), await realpath(deepseek));
  });
});

test('parseWebUrl accepts exact loopback lines', () => {
  assert.deepEqual(parseWebUrl('dsh web: http://127.0.0.1:12345'), {
    origin: 'http://127.0.0.1:12345',
    hostname: '127.0.0.1',
    port: 12345,
  });
  assert.deepEqual(parseWebUrl('dsh web: http://localhost:8080/'), {
    origin: 'http://localhost:8080',
    hostname: 'localhost',
    port: 8080,
  });
  assert.deepEqual(parseWebUrl('  dsh web: http://[::1]:9000  '), {
    origin: 'http://[::1]:9000',
    hostname: '::1',
    port: 9000,
  });
});

test('parseWebUrl rejects non-loopback and malicious lines', () => {
  const bad = [
    'dsh web: http://127.0.0.1.evil.com:80',
    'dsh web: http://127.0.0.2:80',
    'dsh web: http://192.168.0.1:80',
    'dsh web: http://10.0.0.1:80',
    'dsh web: http://0.0.0.0:80',
    'dsh web: http://[::ffff:127.0.0.1]:80',
    'dsh web: http://2130706433:80',
    'dsh web: http://127.0.0.1:80/../../etc/passwd',
    'dsh web: https://127.0.0.1:80',
    'dsh web: ftp://127.0.0.1:21',
    'dsh web: http://user' + ':pass@127.0.0.1:80',
    'dsh web: http://127.0.0.1:80 extra',
    'dsh web:',
    'dsh web: not a url',
    'garbage',
    '',
  ];
  for (const line of bad) {
    assert.equal(parseWebUrl(line), null, `expected rejection: ${JSON.stringify(line)}`);
  }
});
