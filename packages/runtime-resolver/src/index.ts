import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Resolve optional platform packages from the consumer project. This also
// remains valid when the resolver is bundled into a CommonJS Node SEA, where
// import.meta.url is intentionally unavailable.
const require = createRequire(resolve(process.cwd(), "package.json"));

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class RuntimeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeResolutionError";
  }
}

export interface PlatformRuntime {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  packageName: string;
  binaryName: string;
}

const PLATFORM_RUNTIMES: readonly PlatformRuntime[] = [
  { platform: "darwin", arch: "arm64", packageName: "@wrenyard/runtime-darwin-arm64", binaryName: "forge" },
  { platform: "darwin", arch: "x64", packageName: "@wrenyard/runtime-darwin-x64", binaryName: "forge" },
  { platform: "linux", arch: "x64", packageName: "@wrenyard/runtime-linux-x64", binaryName: "forge" },
  { platform: "win32", arch: "x64", packageName: "@wrenyard/runtime-win32-x64", binaryName: "forge.exe" },
];

export function platformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const runtime = PLATFORM_RUNTIMES.find((r) => r.platform === platform && r.arch === arch);
  if (runtime === undefined) {
    throw new RuntimeResolutionError(
      `No prebuilt Forge runtime package exists for ${platform}-${arch}; refusing to build from source`,
    );
  }
  return runtime.packageName;
}

function currentPlatformRuntime(): PlatformRuntime {
  const runtime = PLATFORM_RUNTIMES.find(
    (r) => r.platform === process.platform && r.arch === process.arch,
  );
  if (runtime === undefined) {
    throw new RuntimeResolutionError(
      `No prebuilt Forge runtime package exists for ${process.platform}-${process.arch}; refusing to build from source`,
    );
  }
  return runtime;
}

export interface RuntimeManifest {
  component: string;
  platform: string;
  arch: string;
  version: string;
  sha256: string;
  binary: string;
}

function assertRegularFile(path: string, source: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new RuntimeResolutionError(`Forge binary from ${source} does not exist: ${path}`);
  }
  if (!stat.isFile()) {
    throw new RuntimeResolutionError(`Forge binary from ${source} is not a regular file: ${path}`);
  }
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function loadVerifiedBinary(manifestPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new RuntimeResolutionError(`Unable to read runtime manifest: ${manifestPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RuntimeResolutionError(`runtime-manifest.json at ${manifestPath} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new RuntimeResolutionError(`runtime-manifest.json at ${manifestPath} must be a JSON object`);
  }
  const manifest = parsed as RuntimeManifest;

  if (manifest.component !== "forge") {
    throw new RuntimeResolutionError(
      `runtime-manifest.json at ${manifestPath} has component ${JSON.stringify(manifest.component)}; expected "forge"`,
    );
  }
  if (manifest.platform !== process.platform) {
    throw new RuntimeResolutionError(
      `runtime-manifest.json at ${manifestPath} platform ${JSON.stringify(manifest.platform)} does not match ${process.platform}`,
    );
  }
  if (manifest.arch !== process.arch) {
    throw new RuntimeResolutionError(
      `runtime-manifest.json at ${manifestPath} arch ${JSON.stringify(manifest.arch)} does not match ${process.arch}`,
    );
  }
  const version = manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new RuntimeResolutionError(`runtime-manifest.json at ${manifestPath} must declare a nonempty version`);
  }
  const sha256 = manifest.sha256;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw new RuntimeResolutionError(`runtime-manifest.json at ${manifestPath} must declare a 64-hex sha256`);
  }
  const binary = manifest.binary;
  if (typeof binary !== "string" || binary.length === 0) {
    throw new RuntimeResolutionError(`runtime-manifest.json at ${manifestPath} must declare a relative binary path`);
  }
  if (isAbsolute(binary)) {
    throw new RuntimeResolutionError(
      `runtime-manifest.json at ${manifestPath} declares an absolute binary path; expected a path relative to the package root`,
    );
  }
  const packageRoot = dirname(manifestPath);
  const binaryPath = resolve(packageRoot, binary);
  const relativeBinaryPath = relative(packageRoot, binaryPath);
  if (
    relativeBinaryPath === ".." ||
    relativeBinaryPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeBinaryPath)
  ) {
    throw new RuntimeResolutionError(
      `runtime-manifest.json at ${manifestPath} binary path escapes the package root; refusing to load ${binary}`,
    );
  }
  assertRegularFile(binaryPath, "runtime package");
  const actualSha256 = sha256File(binaryPath);
  if (actualSha256 !== sha256) {
    throw new RuntimeResolutionError(
      `Forge binary checksum mismatch at ${binaryPath}: expected ${sha256}, got ${actualSha256}`,
    );
  }
  return binaryPath;
}

export interface ResolveForgeBinaryOptions {
  env?: NodeJS.ProcessEnv;
  explicitPath?: string;
  allowPathFallback?: boolean;
  packageResolver?: (packageName: string) => string;
}

function defaultPackageResolver(packageName: string): string {
  return dirname(require.resolve(`${packageName}/package.json`));
}

function findOnPath(env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH;
  if (pathValue === undefined || pathValue === "") {
    return undefined;
  }
  const binaryName = process.platform === "win32" ? "forge.exe" : "forge";
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, binaryName);
    if (!existsSync(candidate)) {
      continue;
    }
    assertRegularFile(candidate, "PATH");
    return candidate;
  }
  return undefined;
}

export function resolveForgeBinary(options: ResolveForgeBinaryOptions = {}): string {
  const env = options.env ?? process.env;

  // 1. Explicit path option or WRENYARD_FORGE_BIN env var.
  const explicitPath = options.explicitPath ?? env.WRENYARD_FORGE_BIN;
  if (explicitPath !== undefined) {
    assertRegularFile(explicitPath, "explicit path");
    return explicitPath;
  }

  // 2. Installed @wrenyard/runtime-<platform> package, checksum-verified.
  const runtime = currentPlatformRuntime();
  const resolvePackage = options.packageResolver ?? defaultPackageResolver;
  let packageRoot: string | undefined;
  try {
    packageRoot = resolvePackage(runtime.packageName);
  } catch {
    packageRoot = undefined;
  }
  if (packageRoot !== undefined) {
    return loadVerifiedBinary(join(packageRoot, "runtime-manifest.json"));
  }

  // 3. PATH fallback only when explicitly allowed.
  if (options.allowPathFallback === true) {
    const fromPath = findOnPath(env);
    if (fromPath !== undefined) {
      return fromPath;
    }
  }

  throw new RuntimeResolutionError(
    `Unable to resolve a Forge binary for ${process.platform}-${process.arch}. ` +
      `Install ${runtime.packageName} or set WRENYARD_FORGE_BIN`,
  );
}
