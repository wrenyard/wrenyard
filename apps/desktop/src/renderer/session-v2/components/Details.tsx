import type { ReactNode } from 'react';

/** Stable React keys let native details retain expansion across event updates. */
export function Details({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <details><summary>{label}</summary>{children}</details>;
}

export function JsonValue({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
