// Showcase runner: renders the built Desktop renderer against the demo
// bridges in tools/showcase/, then drives a scenario that takes screenshots
// and records clips. Source-only tooling; nothing here ships in the product.
//
//   pnpm --filter @wrenyard/desktop run build
//   pnpm --filter @wrenyard/desktop exec electron tools/showcase/run.mjs \
//     --scenario tools/showcase/scenarios/screenshots.mjs --out <dir> [--scale 2]

import { app, BrowserWindow } from 'electron';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..', '..');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const scenarioPath = resolve(option('scenario', join(here, 'scenarios', 'screenshots.mjs')));
const outDir = resolve(option('out', join(desktopRoot, '.showcase')));
const scale = Number(option('scale', '2'));
const width = Number(option('width', '1440'));
const height = Number(option('height', '900'));
const fps = Number(option('fps', '30'));

app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('hide-scrollbars');

async function bundlePreload() {
  const outfile = join(outDir, '.preload', 'showcase-preload.cjs');
  await build({
    entryPoints: [join(here, 'preload.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
  });
  return outfile;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const CURSOR_SCRIPT = `(() => {
  if (window.__showcaseCursor) return;
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 160ms ease;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))';
  el.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.4 13.8 L10.2 20 L13 18.8 L10.3 12.7 L16.4 12.7 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(el);
  const ring = document.createElement('div');
  ring.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:999px;z-index:2147483646;pointer-events:none;background:rgba(120,160,90,.35);opacity:0;transform:scale(.4)';
  document.documentElement.appendChild(ring);
  window.__showcaseCursor = {
    show(x, y) { el.style.transform = 'translate(' + x + 'px,' + y + 'px)'; el.style.opacity = '1'; },
    set(x, y) { el.style.transform = 'translate(' + x + 'px,' + y + 'px)'; },
    hide() { el.style.opacity = '0'; },
    pulse(x, y) {
      ring.style.left = x + 'px'; ring.style.top = y + 'px';
      ring.animate([{ opacity: .9, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 420, easing: 'ease-out' });
    },
  };
})();`;

class Recorder {
  constructor(win) {
    this.win = win;
    this.latest = null;
    this.ffmpeg = null;
    this.timer = null;
    win.webContents.on('paint', (_event, _dirty, image) => {
      this.latest = image;
    });
  }

  async frame() {
    this.win.webContents.invalidate();
    await sleep(120);
    return this.latest;
  }

  start(file) {
    if (this.ffmpeg) throw new Error('recording already running');
    const size = this.latest.getSize();
    mkdirSync(dirname(file), { recursive: true });
    this.ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${size.width}x${size.height}`, '-r', String(fps), '-i', 'pipe:0',
      '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', file,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolveDone, reject) => {
      this.ffmpeg.on('exit', (code) => (code === 0 ? resolveDone() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    this.ffmpeg.stdin.on('error', () => {});
    this.finished = done;
    let next = performance.now();
    const tick = () => {
      if (!this.ffmpeg) return;
      const bitmap = this.latest.toBitmap();
      this.ffmpeg.stdin.write(bitmap);
      next += 1000 / fps;
      this.timer = setTimeout(tick, Math.max(0, next - performance.now()));
    };
    tick();
  }

  async stop() {
    clearTimeout(this.timer);
    const process = this.ffmpeg;
    this.ffmpeg = null;
    process.stdin.end();
    await this.finished;
  }
}

function createContext(win, recorder) {
  const contents = win.webContents;
  let cursor = { x: width * 0.62, y: height * 0.55, visible: false };

  const evaluate = (code) => contents.executeJavaScript(code, true);

  async function rect(selector) {
    const box = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== 'hidden';
      });
      const node = nodes[0];
      if (!node) return null;
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`selector not found: ${selector}`);
    return box;
  }

  async function byText(text, scope = 'button, [role="button"], a, [data-slot="sidebar-menu-button"], [role="tab"], [role="menuitem"], [role="option"], label') {
    const box = await evaluate(`(() => {
      const wanted = ${JSON.stringify(text)};
      const nodes = [...document.querySelectorAll(${JSON.stringify(scope)})].filter((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (node.textContent || '').trim().includes(wanted);
      });
      nodes.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      const node = nodes[0];
      if (!node) return null;
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`text not found: ${text}`);
    return box;
  }

  async function target(spec) {
    if (typeof spec === 'object' && spec !== null && 'x' in spec) return spec;
    // Popovers and pages animate in; poll briefly before giving up.
    const deadline = Date.now() + 4000;
    for (;;) {
      try {
        if (typeof spec === 'object' && spec !== null && 'text' in spec) return await byText(spec.text, spec.scope);
        return await rect(spec);
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await sleep(150);
      }
    }
  }

  async function moveTo(spec, ms = 650) {
    const point = await target(spec);
    await evaluate(CURSOR_SCRIPT);
    if (!cursor.visible) {
      await evaluate(`window.__showcaseCursor.show(${cursor.x}, ${cursor.y})`);
      cursor.visible = true;
    }
    const from = { ...cursor };
    const steps = Math.max(1, Math.round((ms / 1000) * 60));
    for (let i = 1; i <= steps; i += 1) {
      const t = ease(i / steps);
      const x = from.x + (point.x - from.x) * t;
      const y = from.y + (point.y - from.y) * t;
      await evaluate(`window.__showcaseCursor.set(${x}, ${y})`);
      contents.sendInputEvent({ type: 'mouseMove', x: Math.round(x * scale), y: Math.round(y * scale) });
      await sleep(ms / steps);
    }
    cursor = { x: point.x, y: point.y, visible: true };
    return point;
  }

  async function click(spec, { move = 650, pause = 120 } = {}) {
    const point = await moveTo(spec, move);
    await sleep(pause);
    await evaluate(`window.__showcaseCursor.pulse(${point.x}, ${point.y})`);
    const x = Math.round(point.x * scale);
    const y = Math.round(point.y * scale);
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(160);
    return point;
  }

  async function type(text, { cps = 14 } = {}) {
    for (const ch of text) {
      contents.insertText(ch);
      await sleep(1000 / cps + (ch === '，' || ch === '。' ? 140 : 0));
    }
  }

  async function key(keyCode, modifiers = []) {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(120);
  }

  async function scroll(spec, deltaY, { duration = 900 } = {}) {
    const point = await target(spec);
    const steps = Math.max(1, Math.round((duration / 1000) * 60));
    for (let i = 0; i < steps; i += 1) {
      contents.sendInputEvent({ type: 'mouseWheel', x: Math.round(point.x * scale), y: Math.round(point.y * scale), deltaX: 0, deltaY: -deltaY / steps });
      await sleep(duration / steps);
    }
  }

  return {
    width,
    height,
    sleep,
    evaluate,
    rect,
    moveTo,
    click,
    type,
    key,
    scroll,
    async hideCursor() {
      if (!cursor.visible) return;
      await evaluate('window.__showcaseCursor && window.__showcaseCursor.hide()');
      cursor.visible = false;
    },
    async page(id) {
      await evaluate(`window.wrenyardShowcase.setPage(${JSON.stringify(id)})`);
      await sleep(700);
    },
    async appearance(next) {
      await evaluate(`window.wrenyardShowcase.setAppearance(${JSON.stringify(next)})`);
      await sleep(500);
    },
    async playTurn(text) {
      await evaluate(`window.wrenyardShowcase.playTurn(${JSON.stringify(text)})`);
    },
    async shot(name) {
      await sleep(250);
      const image = await recorder.frame();
      const file = join(outDir, `${name}.png`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, image.toPNG());
      console.log(`[showcase] shot ${file} ${JSON.stringify(image.getSize())}`);
    },
    async record(name, body) {
      await recorder.frame();
      const file = join(outDir, 'clips', `${name}.mp4`);
      recorder.start(file);
      try {
        await body();
      } finally {
        await recorder.stop();
      }
      console.log(`[showcase] clip ${file}`);
    },
  };
}

async function main() {
  await app.whenReady();
  mkdirSync(outDir, { recursive: true });
  const preload = await bundlePreload();
  const win = new BrowserWindow({
    width: width * scale,
    height: height * scale,
    show: false,
    useContentSize: true,
    backgroundColor: '#f7efd8',
    webPreferences: {
      preload,
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setFrameRate(60);
  const recorder = new Recorder(win);
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`[renderer] ${message}`);
  });
  // Offscreen windows render at device scale 1; a zoomed, larger window keeps
  // the 1440x900 CSS layout while producing scale-x pixels.
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(scale));
  await win.loadFile(join(desktopRoot, 'dist', 'web', 'renderer', 'index.html'));
  await sleep(1800);
  const scenario = await import(pathToFileURL(scenarioPath).href);
  await scenario.default(createContext(win, recorder));
  win.destroy();
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
