/** Browser asset entry; never imported by sandboxed preloads or native consumers. */
import { paperTheme } from './paper/theme.ts';
import { neutralTheme } from './neutral/theme.ts';

export const THEME_ICON_URLS: Readonly<Record<string, string>> = {
  [paperTheme.id]: new URL('./paper/assets/icon-256.png', import.meta.url).href,
  [neutralTheme.id]: new URL('./neutral/assets/icon-256.png', import.meta.url).href,
};
