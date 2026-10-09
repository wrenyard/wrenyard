/**
 * Public surface of `@wrenyard/paths`: pure filesystem path resolution for the
 * Wrenyard config root, state root, per-client state dirs, diagnostic logs and
 * the `config.json` locators. No IPC and no runtime dependencies.
 */
export {
  resolveWrenyardConfigRoot,
  resolveWrenyardStateRoot,
  resolveWrenyardClientStateDir,
  resolveWrenyardLogsDir,
  resolveWrenyardDesktopDataDir,
} from './paths.ts'

export {
  WRENYARD_CONFIG_FILE_NAME,
  resolvePrimaryWrenyardConfigPath,
  resolveDefaultWrenyardConfigPath,
  resolveWrenyardConfigPath,
  resolveWriteWrenyardConfigPath,
} from './config-path.ts'
