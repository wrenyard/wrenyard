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
  update?: {
    channel?: 'stable' | 'dev';
  };
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
    const parsed = this.read();
    if (parsed !== undefined) {
      if (parsed && typeof parsed === 'object' && 'pet' in parsed) {
        return normalizeConfig((parsed as { pet?: unknown }).pet);
      }
      return normalizeConfig(parsed);
    }
    const config = normalizeConfig(this.loadLegacy());
    this.save(config);
    return config;
  }

  save(config: AppConfig): void {
    const current = this.read();
    const update = current && typeof current === 'object' && 'update' in current
      ? (current as DesktopSettingsDocument).update
      : undefined;
    this.write({ version: 1, pet: config, ...(update ? { update } : {}) });
  }

  loadUpdateChannel(fallback: 'stable' | 'dev'): 'stable' | 'dev' {
    const current = this.read();
    if (!current || typeof current !== 'object' || !('update' in current)) return fallback;
    const channel = (current as DesktopSettingsDocument).update?.channel;
    return channel === 'stable' || channel === 'dev' ? channel : fallback;
  }

  saveUpdateChannel(channel: 'stable' | 'dev'): void {
    const current = this.read();
    const pet = current && typeof current === 'object' && 'pet' in current
      ? normalizeConfig((current as { pet?: unknown }).pet)
      : this.load();
    this.write({ version: 1, pet, update: { channel } });
  }

  private read(): unknown | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  private write(document: DesktopSettingsDocument): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.path);
  }
}
