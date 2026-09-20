import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseInstanceRecord } from './identity.mjs';

export function readInstanceFile(path, read = readFileSync) {
  try {
    return parseInstanceRecord(JSON.parse(read(path, 'utf8')));
  } catch {
    return null;
  }
}

export function writeInstanceFile(path, record, write = writeFileSync, mkdir = mkdirSync) {
  mkdir(dirname(path), { recursive: true });
  write(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Binding the control endpoint is the ownership lock.
 * A leftover instance.json is never proof that a supervisor still owns the machine.
 */
export function describePeer(record, checkout, sameCheckout) {
  if (!record) {
    return { kind: 'unknown' };
  }
  if (sameCheckout(record.checkout, checkout)) {
    return { kind: 'same-checkout', record };
  }
  return { kind: 'other-checkout', record };
}
