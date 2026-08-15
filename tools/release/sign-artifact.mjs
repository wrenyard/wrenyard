#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: node sign-artifact.mjs <path> [--verify-only]';

export function isMacAppBundle(target) {
  return typeof target === 'string' && target.endsWith('.app') && existsSync(target) && statSync(target).isDirectory();
}

export function resolveSigntool() {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['signtool'], { stdio: 'ignore' });
    return 'signtool';
  } catch {
    return null;
  }
}

export function buildPlan(target, platform = process.platform) {
  if (platform === 'darwin') {
    const identity = process.env.WRENYARD_MAC_SIGN_IDENTITY || '-';
    const signArgs = ['--force', '--sign', identity];
    if (isMacAppBundle(target)) signArgs.push('--deep');
    signArgs.push(target);
    // An ad-hoc identity ('-') is inherently preview-grade: it proves the
    // binary is self-consistent but provides no developer trust chain. A real
    // identity (WRENYARD_MAC_SIGN_IDENTITY) is a trusted codesign.
    const adhoc = identity === '-';
    return {
      kind: 'codesign',
      signCmd: '/usr/bin/codesign',
      signArgs,
      verifyCmd: '/usr/bin/codesign',
      verifyArgs: ['--verify', '--verbose', target],
      ...(adhoc
        ? { message: `codesign-adhoc-preview: ad-hoc signature (identity "-") is preview-grade, not trusted` }
        : {}),
    };
  }
  if (platform === 'win32') {
    const sha1 = process.env.WRENYARD_WINDOWS_CERT_SHA1;
    const timestampUrl = process.env.WRENYARD_WINDOWS_TIMESTAMP_URL;
    if (sha1 && timestampUrl && resolveSigntool()) {
      // Trusted Windows signing must stamp the SHA256 digest and a timestamp;
      // without a timestamp the signature is not verifiable after the cert
      // expires. An explicitly configured WRENYARD_WINDOWS_CERT_SHA1 without
      // WRENYARD_WINDOWS_TIMESTAMP_URL is refused rather than silently signed.
      return {
        kind: 'signtool',
        signCmd: 'signtool',
        signArgs: ['sign', '/sha1', sha1, '/fd', 'sha256', '/tr', timestampUrl, '/td', 'sha256', target],
        verifyCmd: 'signtool',
        verifyArgs: ['verify', '/pa', target],
      };
    }
    if (sha1 && !timestampUrl) {
      return {
        kind: 'unsigned-preview',
        message: `unsigned-preview: trusted Windows signing requires WRENYARD_WINDOWS_TIMESTAMP_URL for a SHA256 digest timestamp; ${target} left unsigned`,
      };
    }
    return {
      kind: 'unsigned-preview',
      message: `unsigned-preview: no signtool identity (WRENYARD_WINDOWS_CERT_SHA1) available; ${target} left unsigned`,
    };
  }
  return {
    kind: 'checksum-only',
    message: `checksum-only: ${target}; integrity is verified via artifact checksums`,
  };
}

export function main(argv = process.argv.slice(2)) {
  const verifyOnly = argv.includes('--verify-only');
  const targetArg = argv.find((arg) => !arg.startsWith('--'));
  if (!targetArg) {
    console.error(USAGE);
    return 2;
  }
  const target = path.resolve(targetArg);
  if (!existsSync(target)) {
    console.error(`sign-artifact: no such file: ${target}`);
    return 2;
  }
  if (!statSync(target).isFile() && !isMacAppBundle(target)) {
    console.error(`sign-artifact: not a regular file or macOS .app directory: ${target}`);
    return 2;
  }

  const plan = buildPlan(target);
  try {
    if (plan.kind === 'codesign' || plan.kind === 'signtool') {
      if (plan.message) console.log(plan.message);
      if (!verifyOnly) execFileSync(plan.signCmd, plan.signArgs, { stdio: 'inherit' });
      execFileSync(plan.verifyCmd, plan.verifyArgs, { stdio: 'inherit' });
      const verb = verifyOnly ? 'verified' : 'signed and verified';
      console.log(`sign-artifact: ${verb} ${target}`);
      return 0;
    }
    console.log(plan.message);
    return 0;
  } catch (err) {
    console.error(`sign-artifact: FAILED: ${String(err.message).split('\n')[0]}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
