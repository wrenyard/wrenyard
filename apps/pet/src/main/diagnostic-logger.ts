import * as fs from 'node:fs';
import * as path from 'node:path';
import { stateDir } from './xdg';

export interface DiagnosticLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  readonly path: string | null;
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 500 ? value.slice(0, 500) + '...' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    const safe: unknown[] = [];
    for (let i = 0; i < Math.min(value.length, 20); i++) {
      const item = value[i];
      if (typeof item === 'string') {
        safe.push(item.length > 200 ? item.slice(0, 200) + '...' : item);
      } else if (typeof item === 'number' || typeof item === 'boolean' || item === null) {
        safe.push(item);
      } else if (item instanceof Error) {
        safe.push({ name: item.name, message: item.message });
      } else if (typeof item === 'object') {
        safe.push({});
      } else {
        safe.push(null);
      }
    }
    return safe;
  }
  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= 20) break;
      obj[k] = sanitizeValue(v);
    }
    return obj;
  }
  return null;
}

export function createDiagnosticLogger(name: string): DiagnosticLogger {
  const logDir = path.join(stateDir(), 'logs');
  const logFile = path.join(logDir, `${name}.log`);

  let logPath: string | null = logFile;

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    logPath = null;
  }

  function write(level: string, event: string, fields?: Record<string, unknown>): void {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
    };
    if (fields !== undefined && Object.keys(fields).length > 0) {
      entry.fields = sanitizeFields(fields);
    }

    const line = JSON.stringify(entry) + '\n';

    if (logPath !== null) {
      try {
        fs.appendFileSync(logPath, line, 'utf-8');
      } catch {
        console.warn('[diagnostic-logger] failed to write log line:', event);
      }
    } else {
      console.warn('[diagnostic-logger] no log path available:', event);
    }
  }

  return {
    info(event: string, fields?: Record<string, unknown>): void {
      write('info', event, fields);
    },
    warn(event: string, fields?: Record<string, unknown>): void {
      write('warn', event, fields);
    },
    error(event: string, fields?: Record<string, unknown>): void {
      write('error', event, fields);
    },
    get path(): string | null {
      return logPath;
    },
  };
}
