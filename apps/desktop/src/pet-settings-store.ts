import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  loadConfig as loadLegacyPetConfig,
  normalizeConfig,
  type AppConfig,
} from '@wrenyard/pet/config';

interface DesktopSettingsDocument {
  version: 1;
  pet: AppConfig;
}

export interface DesktopPetSettingsStoreOptions {
  path: string;
  loadLegacy?: () => AppConfig;
}

/** Desktop-owned persistence for the Pet module, with one-time legacy import. */
export class DesktopPetSettingsStore {
  private readonly path: string;
  private readonly loadLegacy: () => AppConfig;

  constructor(options: DesktopPetSettingsStoreOptions) {
    this.path = options.path;
    this.loadLegacy = options.loadLegacy ?? loadLegacyPetConfig;
  }

  load(): AppConfig {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && 'pet' in parsed) {
          return normalizeConfig((parsed as { pet?: unknown }).pet);
        }
        return normalizeConfig(parsed);
      } catch {
        // Fall through to the bounded legacy/default projection.
      }
    }
    const config = normalizeConfig(this.loadLegacy());
    this.save(config);
    return config;
  }

  save(config: AppConfig): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const document: DesktopSettingsDocument = { version: 1, pet: config };
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.path);
  }
}
