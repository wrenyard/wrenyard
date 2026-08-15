import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { main, isDevelopmentSuite } from './index.js';
import suitePackage from '../../../package.json' with { type: 'json' };
import componentVersions from '../../../contracts/versions.json' with { type: 'json' };

// Dedicated SEA entry point. It is bundled by esbuild to CommonJS
// (dist/wrenyard-sea.cjs) with the root package.json and contracts/versions.json
// values inlined, so it reports versions standalone without any on-disk layout.
// The suite root and the bundled runtime/node are derived from process.execPath
// when no env is injected, so the SEA runs without a system Node.
const suiteRoot =
  typeof process.env.WRENYARD_ROOT === 'string' && process.env.WRENYARD_ROOT.length > 0
    ? process.env.WRENYARD_ROOT
    : dirname(process.execPath);

// Prefer the bundled runtime inside the suite; only fall back to a PATH node
// for a verified source checkout. A packaged suite without the bundled node
// keeps the bundled path so the spawn error surfaces clearly instead of
// silently using an arbitrary system node.
function resolveNodeExecutable(root: string): string {
  const injected = process.env.WRENYARD_NODE_BIN;
  if (typeof injected === 'string' && injected.length > 0) {
    return injected;
  }
  const bundled = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  if (existsSync(bundled)) {
    return bundled;
  }
  if (isDevelopmentSuite(root)) {
    return 'node';
  }
  return bundled;
}

const nodeExecutable = resolveNodeExecutable(suiteRoot);

process.exitCode = main(process.argv.slice(2), {
  suiteRoot,
  nodeExecutable,
  suiteVersion: suitePackage.version,
  componentVersions,
});
