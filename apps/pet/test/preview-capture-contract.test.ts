import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();

describe('stdio guard contract', () => {
  it('isBrokenPipe matches only EPIPE code', async () => {
    const { isBrokenPipe } = await import('../scripts/preview/stdio-guard.mjs');
    expect(isBrokenPipe(new Error('foo'))).toBe(false);
    expect(isBrokenPipe(null)).toBe(false);
    expect(isBrokenPipe({})).toBe(false);
    const e = new Error('broken pipe');
    e.code = 'EPIPE';
    expect(isBrokenPipe(e)).toBe(true);
  });

  it('rethrowUnlessBrokenPipe rethrows non-EPIPE errors', async () => {
    const { rethrowUnlessBrokenPipe } = await import('../scripts/preview/stdio-guard.mjs');
    const epipe = new Error('epipe');
    epipe.code = 'EPIPE';
    expect(() => rethrowUnlessBrokenPipe(epipe)).not.toThrow();
    const other = new Error('other');
    expect(() => rethrowUnlessBrokenPipe(other)).toThrow('other');
  });

  it('installBrokenPipeGuard suppresses EPIPE and rethrows other errors on an evented stream', async () => {
    const { installBrokenPipeGuard, isBrokenPipe } = await import('../scripts/preview/stdio-guard.mjs');
    const stream = new EventEmitter();
    installBrokenPipeGuard(stream);

    const epipe = new Error('epipe');
    epipe.code = 'EPIPE';
    expect(() => stream.emit('error', epipe)).not.toThrow();

    const other = new Error('other');
    expect(() => stream.emit('error', other)).toThrow('other');
  });

  it('preview-capture.mjs imports and installs the guard for stdout and stderr', async () => {
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).toContain("import { installBrokenPipeGuard, rethrowUnlessBrokenPipe } from './preview/stdio-guard.mjs'");
    expect(source).toContain('installBrokenPipeGuard(process.stdout)');
    expect(source).toContain('installBrokenPipeGuard(process.stderr)');
    expect(source).toContain('rethrowUnlessBrokenPipe(error)');
  });
});

describe('final preview capture contract', () => {
  it('keeps the exact 34-case fixture order', async () => {
    const { PREVIEW_FIXTURES } = await import('../scripts/preview/fixtures.mjs');
    expect(PREVIEW_FIXTURES.map((fixture) => fixture.file)).toEqual([
      'worker-skin-classic-codebuddy.png',
      'worker-skin-classic-codex.png',
      'worker-skin-classic-claude.png',
      'worker-skin-classic-voxel-miner.png',
      'worker-skin-red-jumper.png',
      'worker-skin-green-quest.png',
      'worker-skin-blue-dash.png',
      'worker-skin-block-miner.png',
      'worker-skin-space-bounty.png',
      'worker-skin-arcade-ghost.png',
      'worker-skin-rune-mage.png',
      'worker-skin-shadow-ninja.png',
      'worker-skin-slime-king.png',
      'worker-phase-working.png',
      'worker-phase-sleeping.png',
      'worker-phase-celebrating.png',
      'worker-phase-dejected.png',
      'worker-badge-claude.png',
      'worker-badge-codebuddy.png',
      'worker-badge-codex.png',
      'worker-badge-unknown.png',
      'worker-tool-classic-voxel-miner.png',
      'worker-tool-blue-dash.png',
      'worker-bubble-cjk-reveal.png',
      'worker-bubble-cjk-fade.png',
      'house-base.png',
      'house-status-queued.png',
      'house-broadcast-sticky.png',
      'house-stats-hover.png',
      'house-active-queued.png',
      'house-high-tier.png',
      'house-mushroom-base.png',
      'house-mushroom-active-queued.png',
      'house-mushroom-high-tier.png',
    ]);
  });

  it('serializes all nine failure reasons as one failed JSON object without success fields', async () => {
    const { FAILURE_REASONS, parseInjectFailure, serializeFailure } = await import('../scripts/preview/capture-contract.mjs');
    expect(FAILURE_REASONS).toEqual([
      'preload-error',
      'console-error',
      'missing-pet-api',
      'render-process-gone',
      'context-loss',
      'missing-output',
      'blank-roi',
      'reference-mismatch',
      'manifest-mismatch',
    ]);
    for (const reason of FAILURE_REASONS) {
      expect(parseInjectFailure([`--inject-failure=${reason}`])).toBe(reason);
      const line = serializeFailure(reason, 'injected', 'case-a');
      expect(line.endsWith('\n')).toBe(true);
      const payload = JSON.parse(line);
      expect(payload).toEqual({
        schemaVersion: 'foreman-pet-preview/v1',
        status: 'failed',
        caseId: 'case-a',
        reason,
        details: 'injected',
      });
      expect(payload.cases).toBeUndefined();
      expect(payload.generatedAt).toBeUndefined();
      expect(payload.duration).toBeUndefined();
    }
  });

  it('builds stable success manifest shape, order, thresholds, and paths', async () => {
    const fixtures = await import('../scripts/preview/fixtures.mjs');
    const contract = await import('../scripts/preview/capture-contract.mjs');
    const cases = fixtures.PREVIEW_FIXTURES.map((fixture) => contract.buildManifestCase({
      fixture,
      rootDir,
      referenceSha256: 'r'.repeat(64),
      outputSha256: 'o'.repeat(64),
      compare: {
        changedPixels: 0,
        changedRatio: 0,
        boundsDelta: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    }));
    const manifest = contract.buildManifest(cases);
    const serialized = contract.serializeManifest(manifest);
    expect(serialized).toBe(contract.serializeManifest(JSON.parse(serialized)));
    expect(contract.validateManifestShape(JSON.parse(serialized), fixtures.PREVIEW_FIXTURES)).toEqual({ ok: true });
    expect(JSON.parse(serialized).cases).toHaveLength(34);
    for (const item of JSON.parse(serialized).cases) {
      expect(item.threshold).toEqual({ maxBoundsDelta: 1, channelDelta: 24, maxChangedRatio: 0.03 });
      expect(Object.keys(item.result.boundsDelta)).toEqual(['left', 'top', 'right', 'bottom']);
      expect(item).not.toHaveProperty('generatedAt');
      expect(item).not.toHaveProperty('duration');
      expect(item.file).toMatch(/^artifacts\/preview-capture\//);
      expect(item.reference).toMatch(/^test\/visual\/reference\/(worker|house)\//);
    }
    const houseFixtures = fixtures.PREVIEW_FIXTURES.filter((f) => f.kind === 'house');
    expect(houseFixtures).toHaveLength(9);
  });

  it('pins houseSkin for all 9 house fixtures', async () => {
    const { HOUSE_FIXTURES } = await import('../scripts/preview/fixtures.mjs');
    expect(HOUSE_FIXTURES).toHaveLength(9);
    // First 6 classic house fixtures default to classic
    for (let i = 0; i < 6; i++) {
      expect(HOUSE_FIXTURES[i].value.houseSkin).toBe('classic');
    }
    // Last 3 mushroom house fixtures carry mushroom
    expect(HOUSE_FIXTURES[6].file).toBe('house-mushroom-base.png');
    expect(HOUSE_FIXTURES[6].value.houseSkin).toBe('mushroom');
    expect(HOUSE_FIXTURES[7].file).toBe('house-mushroom-active-queued.png');
    expect(HOUSE_FIXTURES[7].value.houseSkin).toBe('mushroom');
    expect(HOUSE_FIXTURES[8].file).toBe('house-mushroom-high-tier.png');
    expect(HOUSE_FIXTURES[8].value.houseSkin).toBe('mushroom');
  });

  it('uses production dist HTML, fixture preload arguments, and no scoped bundling path', async () => {
    const { PREVIEW_FIXTURES } = await import('../scripts/preview/fixtures.mjs');
    const {
      additionalArgumentsForFixture,
      htmlPathForFixture,
      staticQueryForFixture,
    } = await import('../scripts/preview/capture-contract.mjs');
    expect(htmlPathForFixture(rootDir, PREVIEW_FIXTURES[0]).replace(/\\/g, '/')).toMatch(/dist\/renderer\/worker\.html$/);
    expect(htmlPathForFixture(rootDir, PREVIEW_FIXTURES[25]).replace(/\\/g, '/')).toMatch(/dist\/renderer\/house\.html$/);
    expect(additionalArgumentsForFixture(PREVIEW_FIXTURES[0])).toHaveLength(1);
    expect(additionalArgumentsForFixture(PREVIEW_FIXTURES[0])[0]).toMatch(/^--preview-fixture=/);
    expect(staticQueryForFixture(PREVIEW_FIXTURES[24])).toMatchObject({
      previewStatic: '1',
      nowMs: '10000',
      initNowMs: '0',
    });

    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).not.toContain('--scope');
    expect(source).not.toContain('esbuild');
    expect(source).not.toContain('worker-entry');
    expect(source).not.toContain('house-entry');
    expect(source).not.toContain('Promise.all(');
    expect(source).toContain('for (const fixture of PREVIEW_FIXTURES)');
  });

  it('keeps package preview capture as the production harness command', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    expect(pkg.scripts['preview:capture']).toBe('electron --force-device-scale-factor=1 --force-color-profile=srgb scripts/preview-capture.mjs');
  });

  it('guards PREVIEW_UPDATE_HOUSE_REFERENCES against worker reference writes', async () => {
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).toContain('UPDATE_HOUSE_REFS');
    expect(source).toContain("fixture.kind === 'house'");
    expect(source).toContain('UPDATE_HOUSE_REFS && fixture.kind === \'house\'');
    expect(source).toContain('fs.copyFileSync(captured.file, refPath)');
    // Worker fixtures must never enter the write branch
    const elseBranch = source.match(/} else \{[\s\S]*?compareFixture/);
    expect(elseBranch).not.toBeNull();
    const workerWrite = source.match(/copyFileSync.*worker\//);
    expect(workerWrite).toBeNull();
    // Refresh branch also compares and records manifest cases toward the 34-case total
    const houseBranch = source.match(/UPDATE_HOUSE_REFS && fixture\.kind === 'house'[\s\S]*?cases\.push\(manifestCase\)/);
    expect(houseBranch).not.toBeNull();
    const pushCount = source.match(/cases\.push\(manifestCase\)/g);
    expect(pushCount).toHaveLength(2);
  });

  it('calls capturePage with stayHidden:true for show:false BrowserWindow', async () => {
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).toContain('capturePage(undefined, { stayHidden: true })');
  });

  it('pins house-stats-hover diagnostic text to renderer two-line summary contract', async () => {
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).toContain("'1 个任务运行中 · 2 张图纸'");
    expect(source).toContain('in 191 mtok · out 2 mtok · total 193 mtok');
  });

  it('capture contract asserts quota bar diagnostics from the structured house-stats-hover fixture', async () => {
    const fixtures = await import('../scripts/preview/fixtures.mjs');
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');

    // Fixture must carry quotaTips alongside dailyStats
    const hoverFixture = fixtures.HOUSE_FIXTURES[3];
    expect(hoverFixture.file).toBe('house-stats-hover.png');
    expect(hoverFixture.value.dailyStats).toBeDefined();
    expect(hoverFixture.value.quotaTips).toBeDefined();
    expect(Array.isArray(hoverFixture.value.quotaTips)).toBe(true);

    const tips = hoverFixture.value.quotaTips;
    expect(tips.length).toBeGreaterThanOrEqual(3);

    // codex-spark: 7d-only, no expected marker
    const codex = tips.find((t: any) => t.text.includes('codex-spark'));
    expect(codex).toBeDefined();
    expect(codex.bars).toHaveLength(1);
    expect(codex.bars[0].provider.windows[0].name).toBe('7d');
    expect(codex.bars[0].provider.expectedRemainingPct).toBeNull();

    // kimi-coding: all three pools stay ordered and grouped
    const kimi = tips.find((t: any) => t.text.includes('kimi-coding'));
    expect(kimi).toBeDefined();
    expect(kimi.bars).toHaveLength(1);
    expect(kimi.bars[0].provider.windows[0].name).toBe('5h');
    expect(kimi.bars[0].provider.windows[1].name).toBe('7d');
    expect(kimi.bars[0].provider.windows[2].name).toBe('1mo');

    // super-grok: status error, colon-free text, errorRow present
    const superGrok = tips.find((t: any) => t.text.includes('super-grok'));
    expect(superGrok).toBeDefined();
    expect(superGrok.bars[0].status).toBe('error');
    expect(superGrok.bars[0].error).toBe('rate limit hit');
    expect(superGrok.text).not.toContain(':');
    expect(superGrok.errorRow).toBeDefined();
    expect(superGrok.errorRow.label).toBe('super-grok');
    expect(superGrok.errorRow.message).toBe('error — rate limit hit');

    // Dispatch/token two-line summary header assertion kept
    expect(source).toContain("'1 个任务运行中 · 2 张图纸'");
    expect(source).toContain('in 191 mtok · out 2 mtok · total 193 mtok');

    // Capture asserts provider names, error text, 7+ lines, and semantic ROI
    expect(source).toContain('diagnostics?.stats?.lines');
    expect(source).toContain('lines.length < 7');
    expect(source).toContain('codexSparkMatches.length !== 1');
    expect(source).toContain('kimiCodingMatches.length < 2');
    expect(source).toContain('rate limit hit');
    expect(source).toContain("assertSemanticRoi(ref, cap, diagnostics.stats, fixtureId, 'stats')");
  });
});
