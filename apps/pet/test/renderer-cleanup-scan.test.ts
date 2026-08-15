import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const scannerPath = path.join(repoRoot, 'tools', 'renderer-cleanup-scan.mjs');
const tempDirs: string[] = [];

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpet-renderer-cleanup-'));
  tempDirs.push(dir);
  return dir;
}

function writeFixture(root: string, rel: string, source: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
}

function runScannerWithArgs(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [scannerPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function runScanner(root: string) {
  return runScannerWithArgs(['--root', root]);
}

function runDefaultScanner(cwd: string) {
  return runScannerWithArgs([], cwd);
}

function expectFailureResult(result: ReturnType<typeof runScanner>, token: string) {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  const payload = JSON.parse(result.stderr.trim());
  expect(payload).toMatchObject({
    schemaVersion: 'foreman-pet-cleanup/v1',
    status: 'failed',
    token,
  });
  expect(payload.context.length).toBeLessThanOrEqual(100);
  return payload;
}

function expectFailure(root: string, token: string) {
  const result = runScanner(root);
  return expectFailureResult(result, token);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('renderer cleanup scanner', () => {
  it('passes a clean directory', () => {
    const root = makeFixture();
    writeFixture(root, 'src/ok.ts', 'export const ok = true;\n');

    const result = runScanner(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('fails on the Canvas 2D context type in a TS comment', () => {
    const root = makeFixture();
    writeFixture(root, 'src/comment.ts', '// CanvasRenderingContext2D was here\n');

    const payload = expectFailure(root, 'CanvasRenderingContext2D');

    expect(payload.line).toBe(1);
  });

  it('fails on a 2d getContext call inside a string', () => {
    const root = makeFixture();
    writeFixture(root, 'src/string.ts', 'const sample = "canvas.getContext( \\"2d\\" )";\n');

    expectFailure(root, "getContext('2d')");
  });

  it('fails on a backtick 2d getContext call', () => {
    const root = makeFixture();
    writeFixture(root, 'src/backtick.ts', 'const context = canvas.getContext(`2d`);\n');

    expectFailure(root, "getContext('2d')");
  });

  it('fails on an optional-chained 2d getContext call', () => {
    const root = makeFixture();
    writeFixture(root, 'src/optional.ts', 'const context = canvas?.getContext?.("2d");\n');

    expectFailure(root, "getContext('2d')");
  });

  it('fails on a pixi.js import outside the allowlist', () => {
    const root = makeFixture();
    writeFixture(root, 'src/outside.ts', "import { Application } from 'pixi.js';\n");

    expectFailure(root, 'pixi.js import');
  });

  it('fails on a compact pixi.js import outside the allowlist', () => {
    const root = makeFixture();
    writeFixture(root, 'src/compact.ts', "import{Application}from'pixi.js';\n");

    expectFailure(root, 'pixi.js import');
  });

  it('passes a pixi.js import inside src/render/pixi', () => {
    const root = makeFixture();
    writeFixture(root, 'src/render/pixi/inside.ts', "import { Application } from 'pixi.js';\n");

    const result = runScanner(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('fails on a src/renderer import path', () => {
    const root = makeFixture();
    writeFixture(root, 'src/path.ts', "import '../src/renderer/worker';\n");

    expectFailure(root, 'src/renderer');
  });

  it('default invocation scans tsconfig.renderer.json and fails on an old renderer path', () => {
    const root = makeFixture();
    writeFixture(root, 'tsconfig.renderer.json', '{\n  "include": ["src/renderer/**/*"]\n}\n');

    const payload = expectFailureResult(runDefaultScanner(root), 'src/renderer');

    expect(payload.file).toBe('tsconfig.renderer.json');
  });

  it('fails on a pixi.js named re-export outside the allowlist', () => {
    const root = makeFixture();
    writeFixture(root, 'src/re-export.ts', "export{Application}from'pixi.js';\n");

    expectFailure(root, 'pixi.js import');
  });

  it('fails on a pixi.js star re-export outside the allowlist', () => {
    const root = makeFixture();
    writeFixture(root, 'src/star-re-export.ts', "export*from'pixi.js';\n");

    expectFailure(root, 'pixi.js import');
  });

  it('fails on a dead symbol in a comment', () => {
    const root = makeFixture();
    writeFixture(root, 'src/dead-symbol.ts', '// drawMascotTyping has been retired\n');

    expectFailure(root, 'drawMascotTyping');
  });

  it('passes an HTML canvas element', () => {
    const root = makeFixture();
    writeFixture(root, 'src/index.html', '<main><canvas id="pet"></canvas></main>\n');

    const result = runScanner(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
