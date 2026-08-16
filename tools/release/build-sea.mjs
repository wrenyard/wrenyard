#!/usr/bin/env node
// build-sea.mjs — build the unified Wrenyard CLI executable via Node SEA.
// Usage: node tools/release/build-sea.mjs --output <file> [--cli <cjs-entry>]
// Local only: no network access, no cross-build. The blob is generated with the
// exact running Node binary, which is copied and postjected in place.

import { chmod, copyFile, access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(RELEASE_DIR, "../..");
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const rootRequire = createRequire(path.join(REPO_ROOT, "package.json"));

// node-bin-setup rewrites the node package manifest to `bin/node.exe` on
// Windows and deliberately leaves `bin/node` as a non-executable placeholder.
// Resolve the installed package's effective bin entry instead of resolving the
// extensionless subpath, otherwise postject receives the placeholder rather
// than a PE executable.
function pinnedNodeBinary() {
  const manifestFile = rootRequire.resolve("node/package.json");
  const manifest = rootRequire(manifestFile);
  const bin = manifest.bin ?? {};
  const entry = process.platform === "win32" ? (bin["node.exe"] ?? bin.node) : bin.node;
  const relative = entry ?? Object.values(bin)[0];
  if (typeof relative !== "string" || relative.length === 0) {
    throw new Error("root node package declares no binary in package.json bin");
  }
  return path.resolve(path.dirname(manifestFile), relative);
}

const seaNode = process.env.WRENYARD_SEA_NODE
  ? path.resolve(process.env.WRENYARD_SEA_NODE)
  : pinnedNodeBinary();

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.error) throw new Error(`Failed to spawn ${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

const { values } = parseArgs({ options: { output: { type: "string" }, cli: { type: "string" } } });
if (!values.output) throw new Error("Missing required --output");

let outputPath = path.resolve(values.output);
if (process.platform === "win32" && !outputPath.toLowerCase().endsWith(".exe")) outputPath += ".exe";
await mkdir(path.dirname(outputPath), { recursive: true });

const rootPkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
const suiteVersion = rootPkg.version;
if (!suiteVersion) throw new Error(`Root package.json is missing "version"`);

// SEA requires a CommonJS main module.
function resolveCliEntry(cliArg) {
  if (cliArg) return path.resolve(cliArg);
  // Default to the built CLI bundle so `release:sea` works after a build.
  return path.resolve(REPO_ROOT, "apps", "cli", "dist", "wrenyard-sea.cjs");
}

const cliEntry = resolveCliEntry(values.cli);
await access(cliEntry);
if (cliEntry.endsWith(".mjs")) throw new Error(`SEA entry must be CommonJS, got .mjs: ${cliEntry}`);
if (rootPkg.type === "module" && cliEntry.endsWith(".js")) {
  throw new Error(`SEA entry must be CommonJS, but package type=module makes .js ESM: ${cliEntry}`);
}

const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wrenyard-sea-"));
try {
  const blobPath = path.join(tmpDir, "sea-prep.blob");
  const seaConfigPath = path.join(tmpDir, "sea-config.json");

  // The SEA must discover its suite root and the suite's bundled runtime/node
  // on its own so status/update never need a PATH node. Prepend a small
  // prologue to the bundled CLI entry that sets WRENYARD_ROOT and
  // WRENYARD_NODE_BIN from the SEA's own location (dirname(process.execPath))
  // before the entry module evaluates; the entry reads those env vars at module
  // load time. A packaged SEA is authoritative for its own identity: source-mode
  // overrides are never honored once the SEA is assembled.
  const cliSource = await readFile(cliEntry, "utf8");
  const wrappedEntry = path.join(tmpDir, "sea-main.cjs");
  await writeFile(
    wrappedEntry,
    `'use strict';
const { dirname, join } = require('node:path');
// The packaged SEA is authoritative for its own identity: the suite root is
// always the directory containing this executable, and the bundled node binary
// always lives at runtime/node under that root. Values are set unconditionally
// so stale suite-pinned environment variables cannot redirect a new SEA at its
// installed location.
process.env.WRENYARD_ROOT = dirname(process.execPath);
process.env.WRENYARD_NODE_BIN = join(process.env.WRENYARD_ROOT, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
${cliSource}
`,
    "utf8"
  );

  const seaNodeVersion = run(seaNode, ["--version"]).stdout.trim().replace(/^v/, "");
  const [nodeMajor, nodeMinor] = seaNodeVersion.split(".").map(Number);
  const hasBuiltInBuilder = nodeMajor > 25 || (nodeMajor === 25 && nodeMinor >= 5);
  await writeFile(
    seaConfigPath,
    JSON.stringify(
      {
        main: wrappedEntry,
        output: hasBuiltInBuilder ? outputPath : blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2
    ),
    "utf8"
  );

  if (hasBuiltInBuilder) {
    await rm(outputPath, { force: true });
    run(seaNode, ["--build-sea", seaConfigPath], { cwd: REPO_ROOT });
  } else {
    let postjectCli;
    try {
      postjectCli = path.join(path.dirname(rootRequire.resolve("postject/package.json")), "dist", "cli.js");
    } catch {
      throw new Error("postject not found in local node_modules; install it as a devDependency");
    }
    run(seaNode, ["--experimental-sea-config", seaConfigPath], { cwd: REPO_ROOT });
    await copyFile(seaNode, outputPath);
    await chmod(outputPath, 0o755);
    if (process.platform === "darwin") {
      // postject cannot inject a new Mach-O segment into a signed binary.
      run("codesign", ["--remove-signature", outputPath]);
    }
    const postjectArgs = [postjectCli, outputPath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SENTINEL_FUSE];
    if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
    run(process.execPath, postjectArgs);
  }

  await chmod(outputPath, 0o755);

  if (process.platform === "darwin") await adhocSign(outputPath);

  const versionRun = run(outputPath, ["--version"]);
  const versionOutput = `${versionRun.stdout}${versionRun.stderr}`;
  if (!versionOutput.includes(suiteVersion)) {
    throw new Error(`CLI --version output did not include suite version "${suiteVersion}": ${JSON.stringify(versionOutput)}`);
  }
  run(outputPath, ["--help"]);

  console.log(`Built SEA CLI ${outputPath} (${suiteVersion})`);
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

async function adhocSign(binaryPath) {
  const signArtifact = path.join(RELEASE_DIR, "sign-artifact.mjs");
  try {
    const mod = await import(pathToFileURL(signArtifact).href);
    if (typeof mod.sign === "function") {
      await mod.sign(binaryPath);
      return;
    }
  } catch {
    // No module export; fall back to CLI invocation.
  }
  run(process.execPath, [signArtifact, binaryPath]);
}
