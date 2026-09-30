import { rm } from 'node:fs/promises';

// A production build must never ship artifacts from an older dist layout.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
