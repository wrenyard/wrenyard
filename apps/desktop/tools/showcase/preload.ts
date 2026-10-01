// Showcase preload: exposes the demo bridges under the same globals as the
// product preload, plus a small control surface for the showcase runner.
import { contextBridge } from 'electron';
import { createDemoSession } from './demo-session';
import { createDemoShell, type DemoAppearanceInput } from './demo-shell';

function initialAppearance(): DemoAppearanceInput | undefined {
  const arg = process.argv.find((value) => value.startsWith('--wy-appearance='));
  if (!arg) return undefined;
  const [theme, mode] = arg.slice('--wy-appearance='.length).split(':');
  return { theme: theme || 'paper', dark: mode === 'dark' };
}

const shell = createDemoShell();
const session = createDemoSession();
const appearance = initialAppearance();
if (appearance) shell.setAppearance(appearance);

contextBridge.exposeInMainWorld('wrenyardShell', {
  ...shell.api,
  ...(appearance
    ? { initialAppearance: { ...shell.api.initialAppearance, theme: appearance.theme, dark: appearance.dark } }
    : {}),
});
contextBridge.exposeInMainWorld('wrenyardSession', session.api);
contextBridge.exposeInMainWorld('wrenyardShowcase', {
  setPage: (page: Parameters<typeof shell.setPage>[0]) => shell.setPage(page),
  setAppearance: (next: DemoAppearanceInput) => shell.setAppearance(next),
  playTurn: (text: string) => session.playTurn(text),
});
