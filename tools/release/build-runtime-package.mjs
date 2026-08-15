#!/usr/bin/env node
// build-runtime-package.mjs — build the current-platform Forge runtime package stage.
// Usage: node tools/release/build-runtime-package.mjs --output-dir <dir>
// Stages bin/<forge>, package.json (derived from the placeholder) and a
// deterministic runtime-manifest.json. No installation or self-update logic.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { entryFor } from "./platform.mjs";

const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(RELEASE_DIR, "../..");
const SUITE = "wrenyard";
const COMPONENT = "forge";

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.error) throw new Error(`Failed to spawn ${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

const { values } = parseArgs({ options: { "output-dir": { type: "string" } } });
if (!values["output-dir"]) throw new Error("Missing required --output-dir");

const outputDir = path.resolve(values["output-dir"]);
const target = entryFor(); // fails closed for unsupported host platforms
const platform = process.platform;
const arch = process.arch;
const binName = `forge${target.exeSuffix}`;
const stageBinDir = path.join(outputDir, "bin");
const forgeBin = path.join(stageBinDir, binName);
const placeholderPackageJson = path.join(REPO_ROOT, "packages", `runtime-${target.triplet}`, "package.json");

// 1. Compile the Forge runtime for the current platform with the local toolchain.
await rm(outputDir, { recursive: true, force: true });
await mkdir(stageBinDir, { recursive: true });
run("go", ["-C", "runtime/forge", "build", "-trimpath", "-o", forgeBin, "./cmd/forge"], { cwd: REPO_ROOT });
await chmod(forgeBin, 0o755);
run(process.execPath, [path.join(RELEASE_DIR, "sign-artifact.mjs"), forgeBin], { cwd: REPO_ROOT });

// 2. Smoke the freshly built binary.
const versionRun = run(forgeBin, ["--version"], { cwd: REPO_ROOT });
if (!versionRun.stdout.trim()) throw new Error(`${forgeBin} --version produced no output`);

// 3. SHA256 checksum of the staged binary.
const sha256 = createHash("sha256").update(await readFile(forgeBin)).digest("hex");

// 4. Suite version is taken from the root package manifest.
const rootPkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
if (!rootPkg.version) throw new Error('Root package.json is missing "version"');
const suiteVersion = rootPkg.version;

// 5. Staged package.json derived from the placeholder: private is removed,
//    license/files/wrenyard are preserved, and os/cpu/bin are normalized to
//    the current platform so the staged package matches its artifact.
const placeholder = JSON.parse(await readFile(placeholderPackageJson, "utf8"));
const stagedPackage = {
  ...placeholder,
  name: target.runtimePackage,
  version: suiteVersion,
  license: placeholder.license ?? "MIT",
  os: [platform],
  cpu: [arch],
  bin: { forge: `./bin/${binName}` },
};
delete stagedPackage.private;

const manifest = {
  component: COMPONENT,
  version: suiteVersion,
  platform,
  arch,
  binary: `bin/${binName}`,
  sha256,
};

await writeFile(path.join(outputDir, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDir, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Staged runtime package in ${outputDir}: bin/${binName} sha256=${sha256}`);
