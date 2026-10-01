import { bootAppearance, migrateLegacyTheme } from './lib/theme.js';

// Set `data-theme`, `dark` and `data-motion` before React mounts so the first
// paint matches the main-process-resolved appearance.
bootAppearance();

// One-time migration of the retired localStorage theme key; the key is removed
// only after the main process persisted the value.
void migrateLegacyTheme();
