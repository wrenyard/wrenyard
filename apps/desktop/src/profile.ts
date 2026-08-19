import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const PROFILE_NAME = 'web';
const MANAGED_PACKAGE = '@wrenyard/dsh-shell';
const MANAGED_PACKAGE_BASENAME = 'dsh-shell';
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@wrenyard/dsh-shell'];

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost']);

export interface PreparedProfile {
  dshHome: string;
  profileDir: string;
  shellModuleDir: string;
  packageJsonPath: string;
  cordisPatchPath: string;
  deepseekModulesLink?: string;
}

export interface ParsedWebUrl {
  origin: string;
  hostname: string;
  port: number;
}

/**
 * Prepare an isolated DSH web profile under the supplied DSH_HOME.
 *
 * Only the managed `@wrenyard/dsh-shell` bundle copy inside the web profile is
 * ever replaced; no user profile content is mutated. Copies are made to a temp
 * directory and atomically renamed into place.
 */
export async function prepareProfile(
  dshHome: string,
  shellSourceDir: string,
  runtimeModulesDir?: string,
): Promise<PreparedProfile> {
  const profileDir = join(dshHome, 'profiles', PROFILE_NAME);
  const modulesDir = join(profileDir, 'node_modules');
  const scopedDir = join(profileDir, 'node_modules', '@wrenyard');
  const shellModuleDir = join(scopedDir, MANAGED_PACKAGE_BASENAME);
  const packageJsonPath = join(profileDir, 'package.json');
  const cordisPatchPath = join(profileDir, 'cordis.patch.yml');

  await fs.rm(shellModuleDir, { recursive: true, force: true });
  await fs.mkdir(scopedDir, { recursive: true });

  let deepseekModulesLink: string | undefined;
  if (runtimeModulesDir) {
    const deepseekSource = join(runtimeModulesDir, '@deepseek-ai');
    await fs.access(deepseekSource);
    deepseekModulesLink = join(modulesDir, '@deepseek-ai');
    await fs.rm(deepseekModulesLink, { recursive: true, force: true });
    await fs.symlink(
      deepseekSource,
      deepseekModulesLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  const tmpShell = join(scopedDir, `.${MANAGED_PACKAGE_BASENAME}.tmp-${randomBytes(6).toString('hex')}`);
  try {
    await fs.cp(shellSourceDir, tmpShell, { recursive: true });
    await fs.rename(tmpShell, shellModuleDir);
  } catch (error) {
    await fs.rm(tmpShell, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const presetSource = join(shellSourceDir, 'presets', 'wrenyard');
  const presetDest = join(dshHome, '.agent-presets', 'wrenyard');
  try {
    await fs.access(join(presetSource, 'agent.cordis.yml'));
  } catch {
    throw new Error('Wrenyard agent preset missing from dsh-shell (expected presets/wrenyard/agent.cordis.yml).');
  }
  await fs.rm(presetDest, { recursive: true, force: true });
  await fs.mkdir(join(dshHome, '.agent-presets'), { recursive: true });
  const tmpPreset = join(dshHome, '.agent-presets', `.wrenyard.tmp-${randomBytes(6).toString('hex')}`);
  try {
    await fs.cp(presetSource, tmpPreset, { recursive: true });
    await fs.rename(tmpPreset, presetDest);
  } catch (error) {
    await fs.rm(tmpPreset, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const manifest = {
    name: '@wrenyard/dsh-profile',
    version: '1.0.0-dev.9',
    private: true,
    type: 'module',
    dsh: {
      profile: {
        bundles: BUNDLES,
      },
    },
  };
  await atomicWrite(packageJsonPath, JSON.stringify(manifest, null, 2) + '\n');

  const cordisPatch = [
    '# Managed by @wrenyard/desktop. Regenerated deterministically on each launch.',
    '# DSH runs with the isolated "web" profile; keep user overrides minimal here.',
    '[]',
  ].join('\n') + '\n';
  await atomicWrite(cordisPatchPath, cordisPatch);

  return { dshHome, profileDir, shellModuleDir, packageJsonPath, cordisPatchPath, deepseekModulesLink };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, target);
}

/**
 * Parse the exact `dsh web: http://127.0.0.1:<port>` line emitted by the DSH
 * CLI. Accepts loopback targets only and rejects anything else, including
 * DNS-rebinding style and malformed/malicious input.
 */
export function parseWebUrl(line: string): ParsedWebUrl | null {
  const match = /^dsh web:\s*(\S+)\s*$/.exec(line.trim());
  if (!match) return null;

  let url: URL;
  try {
    url = new URL(match[1]);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:') return null;
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  if (url.port === '') return null;

  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { origin: url.origin, hostname, port };
}
