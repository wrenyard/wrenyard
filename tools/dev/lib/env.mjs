import { SOURCE_DEV_FLAG } from './constants.mjs';

/**
 * Build the child environment for source-dev processes.
 * Inherited install-path variables are overwritten; user data/config paths are preserved.
 */
export function sourceChildEnv(baseEnv, resolved) {
  const env = { ...baseEnv };
  env.WRENYARD_SOURCE_DEV = SOURCE_DEV_FLAG;
  env.WRENYARD_DEV_SUPERVISED = SOURCE_DEV_FLAG;
  env.WRENYARD_DEV_INSTANCE_ID = resolved.instanceId;
  if (resolved.launchId) env.WRENYARD_DEV_LAUNCH_ID = resolved.launchId;
  env.WRENYARD_SOURCE_CHECKOUT = resolved.checkout;
  env.WRENYARD_ROOT = resolved.checkout;
  env.WRENYARD_CLI = resolved.cli;
  env.WRENYARD_NODE_BIN = resolved.nodeBin;
  env.WRENYARD_RUNTIME_BIN = resolved.runtimeBin;
  env.WRENYARD_DESKTOP_BIN = resolved.desktopBin;
  env.WRENYARD_DEV_CONTROL = resolved.controlEndpoint;
  env.WRENYARD_DESKTOP_USER_DATA = resolved.userData;
  if (resolved.ipcPath) env.WRENYARD_IPC_PATH = resolved.ipcPath;
  return env;
}

export function inheritedInstallHijack(env = {}) {
  return {
    WRENYARD_CLI: env.WRENYARD_CLI,
    WRENYARD_RUNTIME_BIN: env.WRENYARD_RUNTIME_BIN,
    WRENYARD_NODE_BIN: env.WRENYARD_NODE_BIN,
    WRENYARD_DESKTOP_BIN: env.WRENYARD_DESKTOP_BIN,
  };
}

export function isSourceDevelopment(env = process.env) {
  return env.WRENYARD_SOURCE_DEV === SOURCE_DEV_FLAG;
}

export function isSupervised(env = process.env) {
  return env.WRENYARD_DEV_SUPERVISED === SOURCE_DEV_FLAG;
}
