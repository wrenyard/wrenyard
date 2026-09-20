import { watch } from 'node:fs';
import { relative, resolve } from 'node:path';
import { DEBOUNCE_MS } from './constants.mjs';
import { classifyPath, shouldIgnore } from './graph.mjs';

const WATCH_ROOTS = [
  'apps',
  'packages',
  'services',
  'runtime',
  'tools/dev',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

export function createWatcher(options) {
  const checkout = options.checkout;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const watchImpl = options.watch ?? watch;
  const onChange = options.onChange;
  const watchers = [];
  let timer = null;
  let queued = new Map();
  let closed = false;

  function flush() {
    timer = null;
    if (queued.size === 0) return;
    const files = [...queued.keys()];
    const components = [...new Set(files.flatMap((file) => classifyPath(file)))];
    queued = new Map();
    if (components.length === 0 && files.length === 0) return;
    onChange({ files, components });
  }

  function note(relativePath, event) {
    if (closed) return;
    const normalized = relativePath.split('\\').join('/');
    if (shouldIgnore(normalized)) return;
    queued.set(normalized, event);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  for (const root of options.roots ?? WATCH_ROOTS) {
    const full = resolve(checkout, root);
    try {
      const watcher = watchImpl(full, { recursive: true }, (event, filename) => {
        const rel = filename
          ? relative(checkout, resolve(full, filename.toString())).split('\\').join('/')
          : root;
        note(rel, event);
      });
      watcher.on?.('error', () => {
        // Directory may vanish during rebuilds; ignore.
      });
      watchers.push(watcher);
    } catch {
      // Files like package.json use non-recursive file watches.
      try {
        const watcher = watchImpl(full, (event) => note(root, event));
        watchers.push(watcher);
      } catch {
        // Missing optional roots are skipped.
      }
    }
  }

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
    },
  };
}
