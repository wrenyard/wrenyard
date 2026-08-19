const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

/**
 * Give preview macOS bundles a complete ad-hoc signature before zip creation.
 * electron-builder may subsequently replace it with a trusted CSC identity;
 * no credentials or identities are read or printed by this hook.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--verbose', appPath], {
    stdio: 'inherit',
  });
  // Documents/Github is Spotlight-indexed. An unpacked .app under
  // apps/desktop/release/ otherwise appears beside ~/Applications.
  for (const dir of [context.appOutDir, path.dirname(context.appOutDir)]) {
    writeFileSync(path.join(dir, '.metadata_never_index'), '');
  }
};
