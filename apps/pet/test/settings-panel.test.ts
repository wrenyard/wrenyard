import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const htmlPath = resolve(__dirname, '../src/panels/settings/index.html');

describe('Settings panel — HTML contract', () => {
  const html = readFileSync(htmlPath, 'utf-8');

  it('has a house-skin select with exactly two options', () => {
    const match = html.match(/<select[^>]*id="house-skin"[^>]*>[\s\S]*?<\/select>/);
    expect(match).not.toBeNull();

    const selectHtml = match![0];
    const options = selectHtml.match(/<option[^>]*>.*?<\/option>/g);
    expect(options).not.toBeNull();
    expect(options!).toHaveLength(2);
  });

  it('has classic/Classic Lodge and mushroom/Mushroom Hut options', () => {
    expect(html).toContain('<option value="classic">Classic Lodge</option>');
    expect(html).toContain('<option value="mushroom">Mushroom Hut</option>');
  });

  it('retains all critical settings control IDs', () => {
    const ids = [
      'house-skin',
      'scale',
      'bubble-seconds',
      'bottom-offset',
      'show-house',
      'show-workers',
      'quota-providers',
      'save-btn',
      'save-restart-btn',
    ];
    for (const id of ids) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('has title Workshop Settings', () => {
    expect(html).toContain('<title>Workshop Settings</title>');
  });
});
