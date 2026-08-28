import { app } from 'electron';
import * as path from 'node:path';
import { loadConfig, saveConfig } from './config';
import { DesktopPetRuntime } from './runtime';

let runtime: DesktopPetRuntime | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

void app.whenReady().then(async () => {
  // Standalone execution is retained only for renderer development and visual
  // captures. Product lifecycle is owned by Wrenyard Desktop.
  app.dock?.hide();
  const config = loadConfig();
  if (!config.enabled) return;
  runtime = new DesktopPetRuntime({
    config,
    rendererDir: path.join(__dirname, '..', '..', 'renderer'),
    preloadDir: __dirname,
    onConfigChange: saveConfig,
    debugRenderer: process.env.PET_DEBUG === '1' || process.env.PET_DEBUG === 'true',
  });
  await runtime.start();
});

app.on('window-all-closed', () => {
  // Standalone visual-development mode remains headless.
});

app.on('before-quit', () => {
  void runtime?.stop();
});
