import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOG_MAX_BYTES, LOG_MAX_FILES } from './constants.mjs';

const SECRET_LINE = /(token|secret|password|authorization|api[_-]?key|bearer\s+[a-z0-9._-]+)/iu;

export function shouldRedact(text) {
  return SECRET_LINE.test(text);
}

export function createLogger(options) {
  const dir = options.dir;
  const fileName = options.fileName ?? 'supervisor.log';
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);

  function rotateIfNeeded() {
    try {
      if (statSync(path).size < (options.maxBytes ?? LOG_MAX_BYTES)) return;
    } catch {
      return;
    }
    const max = options.maxFiles ?? LOG_MAX_FILES;
    for (let index = max - 1; index >= 1; index -= 1) {
      const from = index === 1 ? path : `${path}.${index - 1}`;
      const to = `${path}.${index}`;
      try {
        renameSync(from, to);
      } catch {
        // Missing older files are expected.
      }
    }
  }

  function write(level, event, detail = '') {
    const raw = detail ? `${event} ${detail}` : event;
    const safe = shouldRedact(raw) ? `${event} [redacted]` : raw;
    const line = `${now()} ${level} ${safe}`;
    rotateIfNeeded();
    try {
      writeFileSync(path, `${line}\n`, { flag: 'a' });
    } catch {
      // Logging must never crash the supervisor.
    }
    if (level !== 'debug') stdout(line);
    return line;
  }

  return {
    path,
    info: (event, detail) => write('info', event, detail),
    warn: (event, detail) => write('warn', event, detail),
    error: (event, detail) => write('error', event, detail),
    debug: (event, detail) => write('debug', event, detail),
  };
}

export function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}
