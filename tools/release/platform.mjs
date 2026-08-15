// platform.mjs — single source of truth for Wrenyard artifact naming.
// Maps Node process.platform/arch to release artifact names. Fails closed
// for anything outside darwin arm64/x64, linux x64 and win32 x64.

const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    platform: "darwin",
    arch: "arm64",
    triplet: "darwin-arm64",
    runtimePackage: "@wrenyard/runtime-darwin-arm64",
    exeSuffix: "",
    installerLabel: "macos-arm64",
  }),
  "darwin-x64": Object.freeze({
    platform: "darwin",
    arch: "x64",
    triplet: "darwin-x64",
    runtimePackage: "@wrenyard/runtime-darwin-x64",
    exeSuffix: "",
    installerLabel: "macos-x64",
  }),
  "linux-x64": Object.freeze({
    platform: "linux",
    arch: "x64",
    triplet: "linux-x64",
    runtimePackage: "@wrenyard/runtime-linux-x64",
    exeSuffix: "",
    installerLabel: "linux-x64",
  }),
  "win32-x64": Object.freeze({
    platform: "win32",
    arch: "x64",
    triplet: "win32-x64",
    runtimePackage: "@wrenyard/runtime-win32-x64",
    exeSuffix: ".exe",
    installerLabel: "windows-x64",
  }),
});

function entryFor(platform = process.platform, arch = process.arch) {
  const entry = TARGETS[`${platform}-${arch}`];
  if (!entry) {
    throw new Error(
      `Unsupported Wrenyard target platform=${platform} arch=${arch}; expected one of ${Object.keys(TARGETS).join(", ")}`
    );
  }
  return entry;
}

export function triplet(platform, arch) {
  return entryFor(platform, arch).triplet;
}

export function runtimePackageName(platform, arch) {
  return entryFor(platform, arch).runtimePackage;
}

export function executableSuffix(platform, arch) {
  return entryFor(platform, arch).exeSuffix;
}

export function installerLabel(platform, arch) {
  return entryFor(platform, arch).installerLabel;
}

export function supportedTargets() {
  return Object.values(TARGETS);
}

export { entryFor };
