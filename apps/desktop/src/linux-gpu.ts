/**
 * Linux GPU/WebGL failure falls back to software rendering (SwiftShader) and
 * relaunches once. The flag lives in Desktop userData so a later start skips
 * the broken GPU path.
 */

import { app } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FLAG_NAME = 'gpu-software-rendering';
let armed = false;
let relaunching = false;

function flagPath(userDataPath: string): string {
  return join(userDataPath, FLAG_NAME);
}

function applySoftwareRenderingSwitches(): void {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}

/** Call before `app.ready` so Chromium starts on the software path. */
export function enableLinuxSoftwareRenderingIfNeeded(userDataPath: string): boolean {
  if (process.platform !== 'linux') return false;
  if (!existsSync(flagPath(userDataPath))) return false;
  applySoftwareRenderingSwitches();
  return true;
}

function webglUnavailable(status: Record<string, string>): boolean {
  const webgl = `${status.webgl ?? ''} ${status.webgl2 ?? ''}`;
  return /unavailable_off|disabled_off/i.test(webgl);
}

function persistAndRelaunch(userDataPath: string): void {
  if (relaunching || existsSync(flagPath(userDataPath))) return;
  relaunching = true;
  try {
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(flagPath(userDataPath), '1\n');
  } catch {
    relaunching = false;
    return;
  }
  app.relaunch();
  app.exit(0);
}

/** Watch for GPU process crashes and WebGL `unavailable_off` after startup. */
export function armLinuxGpuFallback(userDataPath: string): void {
  if (process.platform !== 'linux' || armed) return;
  armed = true;
  const already = existsSync(flagPath(userDataPath));
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU') persistAndRelaunch(userDataPath);
  });
  const inspectWebgl = (): void => {
    if (already || relaunching) return;
    try {
      const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
      if (webglUnavailable(status)) persistAndRelaunch(userDataPath);
    } catch {
      // Feature status is best-effort; a later GPU crash still arms the flag.
    }
  };
  const scheduleInspect = (): void => {
    inspectWebgl();
    setTimeout(inspectWebgl, 2_000).unref?.();
  };
  if (app.isReady()) scheduleInspect();
  else app.once('ready', scheduleInspect);
}
