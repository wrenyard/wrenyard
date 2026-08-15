import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { RuntimeResolutionError, platformPackageName, resolveForgeBinary } from "../src/index.js";

interface Fixture {
  dir: string;
  binaryPath: string;
}

async function makeFixture(t: TestContext, tamperSha?: string): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "runtime-resolver-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "bin"), { recursive: true });
  const binaryPath = join(dir, "bin", "forge");
  const contents = Buffer.from("fixture forge binary");
  await writeFile(binaryPath, contents);
  await chmod(binaryPath, 0o755);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  await writeFile(
    join(dir, "runtime-manifest.json"),
    JSON.stringify(
      {
        component: "forge",
        platform: process.platform,
        arch: process.arch,
        version: "0.1.0",
        sha256: tamperSha ?? sha256,
        binary: "bin/forge",
      },
      null,
      2,
    ),
  );
  return { dir, binaryPath };
}

test("platformPackageName maps supported platform/arch pairs to runtime packages", () => {
  assert.equal(platformPackageName("darwin", "arm64"), "@wrenyard/runtime-darwin-arm64");
  assert.equal(platformPackageName("darwin", "x64"), "@wrenyard/runtime-darwin-x64");
  assert.equal(platformPackageName("linux", "x64"), "@wrenyard/runtime-linux-x64");
  assert.equal(platformPackageName("win32", "x64"), "@wrenyard/runtime-win32-x64");
});

test("platformPackageName rejects unsupported platform/arch pairs", () => {
  assert.throws(() => platformPackageName("linux", "arm64"), RuntimeResolutionError);
  assert.throws(() => platformPackageName("freebsd", "x64"), RuntimeResolutionError);
});

test("WRENYARD_FORGE_BIN env var resolves an existing binary before PATH fallback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-resolver-env-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const binaryPath = join(dir, "forge");
  await writeFile(binaryPath, "#!/bin/sh\necho forge\n");
  await chmod(binaryPath, 0o755);

  const previous = process.env.WRENYARD_FORGE_BIN;
  process.env.WRENYARD_FORGE_BIN = binaryPath;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.WRENYARD_FORGE_BIN;
    } else {
      process.env.WRENYARD_FORGE_BIN = previous;
    }
  });

  const resolved = resolveForgeBinary({});
  assert.equal(resolved, binaryPath);
});

test("explicitPath option takes precedence over the env var", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-resolver-explicit-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const explicitBinary = join(dir, "explicit-forge");
  await writeFile(explicitBinary, "explicit");
  await chmod(explicitBinary, 0o755);

  const resolved = resolveForgeBinary({
    env: { WRENYARD_FORGE_BIN: join(dir, "env-forge") },
    explicitPath: explicitBinary,
  });
  assert.equal(resolved, explicitBinary);
});

test("missing explicit path throws RuntimeResolutionError", () => {
  const missing = join(tmpdir(), "runtime-resolver-does-not-exist");
  assert.throws(() => resolveForgeBinary({ explicitPath: missing }), RuntimeResolutionError);
  assert.throws(() => resolveForgeBinary({ explicitPath: missing }), /does not exist/);
});

test("resolves a checksum-verified binary from a runtime package fixture", async (t) => {
  const { dir, binaryPath } = await makeFixture(t);
  const resolved = resolveForgeBinary({ env: {}, packageResolver: () => dir });
  assert.equal(resolved, binaryPath);
});

test("rejects a runtime package whose checksum does not match the manifest", async (t) => {
  const { dir } = await makeFixture(t, "0".repeat(64));
  assert.throws(() => resolveForgeBinary({ env: {}, packageResolver: () => dir }), RuntimeResolutionError);
  assert.throws(() => resolveForgeBinary({ env: {}, packageResolver: () => dir }), /checksum mismatch/);
});

test("rejects a runtime manifest whose binary path escapes the package root", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-resolver-escape-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    join(dir, "runtime-manifest.json"),
    JSON.stringify({
      component: "forge",
      platform: process.platform,
      arch: process.arch,
      version: "0.1.0",
      sha256: "0".repeat(64),
      binary: "../outside-forge",
    }),
  );
  assert.throws(() => resolveForgeBinary({ env: {}, packageResolver: () => dir }), RuntimeResolutionError);
  assert.throws(
    () => resolveForgeBinary({ env: {}, packageResolver: () => dir }),
    /escapes the package root/,
  );
});

test("falls back to PATH only when allowPathFallback is true", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-resolver-path-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const binaryName = process.platform === "win32" ? "forge.exe" : "forge";
  const binaryPath = join(dir, binaryName);
  await writeFile(binaryPath, "forge on path");
  await chmod(binaryPath, 0o755);

  const notInstalled = () => {
    throw new Error("package not installed");
  };

  // Fallback disabled: no explicit path, no package, no PATH search -> error.
  assert.throws(
    () => resolveForgeBinary({ env: {}, packageResolver: notInstalled }),
    RuntimeResolutionError,
  );

  // Fallback enabled: PATH is searched and the forge binary is found.
  const resolved = resolveForgeBinary({
    env: { PATH: dir },
    allowPathFallback: true,
    packageResolver: notInstalled,
  });
  assert.equal(resolved, binaryPath);
});
