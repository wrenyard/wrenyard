#!/usr/bin/env node
// Dependency-free verifier for release-manifest.json against the suite schema
// contract. Validates the fixed shape and invariants without a generic JSON
// Schema engine and without network access.
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

const manifestPath = join(suiteRoot, 'release-manifest.json');
const schemaPath = join(suiteRoot, 'contracts', 'suite-manifest.schema.json');

// The external target artifact index emitted by the release builder (plain or
// host-qualified name) is validated separately from the embedded development
// identity below; the two are distinct documents, never one self-referencing
// the other.
const hostTriplet = `${process.platform}-${process.arch}`;
const externalIndexPaths = [
  join(suiteRoot, 'artifact-manifest.json'),
  join(suiteRoot, `artifact-manifest-${hostTriplet}.json`),
];
const externalIndexPath = externalIndexPaths.find((p) => existsSync(p));

const errors = [];
const fail = (msg) => errors.push(msg);

let manifest = null;
let schema = null;

try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`cannot read/parse release-manifest.json: ${err.message}`);
}
try {
  schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
} catch (err) {
  fail(`cannot read/parse contracts/suite-manifest.schema.json: ${err.message}`);
}

const matches = (value, pattern) => typeof pattern === 'string' && new RegExp(pattern).test(value);

const requiredComponents = ['forge', 'foreman', 'pet', 'cli', 'desktop', 'dsh_shell'];

// Artifact names must match the object-key pattern the contract schema defines.
const artifactNameRe = (() => {
  const props = schema?.properties?.platform_artifacts?.patternProperties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const patterns = Object.keys(props);
    if (patterns.length > 0) {
      try {
        return new RegExp(patterns[0]);
      } catch {
        return null;
      }
    }
  }
  return null;
})();

// A candidate path must stay under root lexically; realpath containment is
// checked at the call site so symlinked publishable content cannot point
// outside the suite.
const containedUnder = (root, candidate) => {
  const resolved = resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
};

if (manifest && schema) {
  const topLevel = ['schema_version', 'suite_version', 'protocol_version', 'release_status', 'components', 'platform_artifacts', 'publishable'];

  for (const key of topLevel) {
    if (!Object.hasOwn(manifest, key)) fail(`missing top-level key "${key}"`);
  }
  for (const key of Object.keys(manifest)) {
    if (!topLevel.includes(key)) fail(`unknown top-level key "${key}"`);
  }

  const expectedSchemaVersion = schema.properties?.schema_version?.const;
  if (expectedSchemaVersion !== undefined && manifest.schema_version !== expectedSchemaVersion) {
    fail(`schema_version ${JSON.stringify(manifest.schema_version)} does not match contract ${JSON.stringify(expectedSchemaVersion)}`);
  }

  if (typeof manifest.suite_version !== 'string' || !matches(manifest.suite_version, schema.properties?.suite_version?.pattern)) {
    fail(`suite_version must match the contract version pattern, got ${JSON.stringify(manifest.suite_version)}`);
  }

  if (typeof manifest.protocol_version !== 'string' || !matches(manifest.protocol_version, schema.properties?.protocol_version?.pattern)) {
    fail(`protocol_version must be a positive integer string, got ${JSON.stringify(manifest.protocol_version)}`);
  }

  if (!['development', 'preview', 'stable'].includes(manifest.release_status)) {
    fail(`release_status must be development|preview|stable, got ${JSON.stringify(manifest.release_status)}`);
  }

  if (typeof manifest.publishable !== 'boolean') {
    fail(`publishable must be a boolean, got ${JSON.stringify(manifest.publishable)}`);
  }

  if (manifest.release_status === 'development' && manifest.publishable) {
    fail('development manifests cannot be publishable');
  }

  if (typeof manifest.platform_artifacts !== 'object' || manifest.platform_artifacts === null || Array.isArray(manifest.platform_artifacts)) {
    fail('platform_artifacts must be an object');
  } else {
    for (const [name, artifact] of Object.entries(manifest.platform_artifacts)) {
      if (artifactNameRe !== null && !artifactNameRe.test(name)) {
        fail(`platform artifact "${name}" name must match the contract artifact-name pattern`);
      }
      if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
        fail(`platform artifact "${name}" must be an object`);
        continue;
      }
      const artKeys = ['format', 'path', 'sha256'];
      for (const key of artKeys) {
        if (!Object.hasOwn(artifact, key)) fail(`platform artifact "${name}" is missing "${key}"`);
      }
      for (const key of Object.keys(artifact)) {
        if (!artKeys.includes(key)) fail(`platform artifact "${name}" has unknown key "${key}"`);
      }
      if (typeof artifact.format !== 'string' || artifact.format.length === 0) {
        fail(`platform artifact "${name}" format must be a non-empty string`);
      }
      if (typeof artifact.path !== 'string' || artifact.path.length === 0) {
        fail(`platform artifact "${name}" path must be a non-empty string`);
      } else {
        const resolved = containedUnder(suiteRoot, artifact.path);
        if (resolved !== null && (resolved === manifestPath || (externalIndexPath !== undefined && resolved === externalIndexPath))) {
          fail(`platform artifact "${name}" must not reference the release manifest or artifact index itself (self-reference): ${artifact.path}`);
        } else if (resolved === null) {
          fail(`platform artifact "${name}" path must be contained under the suite root: ${artifact.path}`);
        } else if (!existsSync(resolved)) {
          fail(`platform artifact "${name}" does not exist: ${artifact.path}`);
        } else {
          let realInside = false;
          try {
            const realRoot = realpathSync(suiteRoot);
            const realResolved = realpathSync(resolved);
            realInside = realResolved === realRoot || realResolved.startsWith(realRoot + sep);
          } catch {
            realInside = false;
          }
          if (!realInside) {
            // Escaped targets are rejected without statting or hashing them, so
            // a symlink pointing outside the suite cannot leak its content.
            fail(`platform artifact "${name}" path escapes the suite root after realpath: ${artifact.path}`);
          } else {
            let isFile = false;
            try {
              isFile = statSync(resolved).isFile();
            } catch {
              fail(`platform artifact "${name}" could not be stat'ed: ${artifact.path}`);
            }
            if (!isFile) {
              fail(`platform artifact "${name}" must be a regular file: ${artifact.path}`);
            }
            if (typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256)) {
              let digest = null;
              try {
                digest = createHash('sha256').update(readFileSync(resolved)).digest('hex');
              } catch {
                fail(`platform artifact "${name}" could not be read to verify sha256: ${artifact.path}`);
              }
              if (digest !== null && digest !== artifact.sha256) {
                fail(`platform artifact "${name}" sha256 mismatch: manifest ${artifact.sha256}, computed ${digest}`);
              }
            }
          }
        }
      }
      if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
        fail(`platform artifact "${name}" sha256 must be exactly 64 lowercase hex chars`);
      }
    }
  }

  if (typeof manifest.components !== 'object' || manifest.components === null || Array.isArray(manifest.components)) {
    fail('components must be an object');
  } else {
    for (const key of requiredComponents) {
      if (!Object.hasOwn(manifest.components, key)) fail(`components is missing "${key}"`);
    }
    for (const key of Object.keys(manifest.components)) {
      if (!requiredComponents.includes(key)) fail(`components has unknown key "${key}"`);
    }
    for (const [name, comp] of Object.entries(manifest.components)) {
      if (typeof comp !== 'object' || comp === null || Array.isArray(comp)) {
        fail(`component "${name}" must be an object`);
        continue;
      }
      const compKeys = ['source', 'version', 'source_sha'];
      for (const key of compKeys) {
        if (!Object.hasOwn(comp, key)) fail(`component "${name}" is missing "${key}"`);
      }
      for (const key of Object.keys(comp)) {
        if (!compKeys.includes(key)) fail(`component "${name}" has unknown key "${key}"`);
      }
      if (typeof comp.source !== 'string' || comp.source.length === 0) {
        fail(`component "${name}" source must be a non-empty string`);
      } else {
        const resolved = containedUnder(suiteRoot, comp.source);
        if (resolved === null) {
          fail(`component "${name}" source must be contained under the suite root: ${comp.source}`);
        } else if (!existsSync(resolved)) {
          fail(`component "${name}" source root does not exist: ${comp.source}`);
        } else {
          let realInside = false;
          try {
            const realRoot = realpathSync(suiteRoot);
            const realResolved = realpathSync(resolved);
            realInside = realResolved === realRoot || realResolved.startsWith(realRoot + sep);
          } catch {
            realInside = false;
          }
          if (!realInside) {
            fail(`component "${name}" source escapes the suite root after realpath: ${comp.source}`);
          } else {
            let isDirectory = false;
            try {
              isDirectory = statSync(resolved).isDirectory();
            } catch {
              fail(`component "${name}" source could not be stat'ed: ${comp.source}`);
            }
            if (!isDirectory) {
              fail(`component "${name}" source must be a directory: ${comp.source}`);
            }
          }
        }
      }
      if (comp.source_sha === null) {
        if (!(manifest.release_status === 'development' && manifest.publishable === false)) {
          fail(`component "${name}" source_sha null is only allowed for a development, non-publishable manifest`);
        }
      } else if (typeof comp.source_sha !== 'string' || !/^[0-9a-f]{40}$/.test(comp.source_sha)) {
        fail(`component "${name}" source_sha must be exactly 40 lowercase hex chars or null`);
      } else if (/^0{40}$/.test(comp.source_sha)) {
        fail(`component "${name}" source_sha must not be the all-zero hash`);
      }
      if (typeof comp.version !== 'string' || !matches(comp.version, schema.$defs?.component?.properties?.version?.pattern)) {
        fail(`component "${name}" version must match the contract version pattern, got ${JSON.stringify(comp.version)}`);
      }
    }
  }

  if (manifest.publishable) {
    if (typeof manifest.components !== 'object' || manifest.components === null || Array.isArray(manifest.components)) {
      fail('publishable manifests require a components object');
    } else {
      for (const [name, comp] of Object.entries(manifest.components)) {
        if (comp && comp.source_sha == null) {
          fail(`publishable component "${name}" requires a non-null source_sha`);
        }
      }
    }
    if (!manifest.platform_artifacts || Object.keys(manifest.platform_artifacts).length === 0) {
      fail('publishable manifests require at least one platform_artifact');
    }
    const forgeGoMod = join(suiteRoot, 'runtime', 'forge', 'go.mod');
    const userNs = String.fromCharCode(100, 108, 117, 99, 107);
    const transitionalModule = ['github.com', userNs, 'forge'].join('/');
    const moduleDecl = existsSync(forgeGoMod)
      ? readFileSync(forgeGoMod, 'utf8').split('\n').map((line) => line.trim()).find((line) => line.startsWith('module '))
      : undefined;
    if (moduleDecl !== undefined && moduleDecl === `module ${transitionalModule}`) {
      fail('publishable manifests cannot use the transitional personal Forge module namespace');
    }
  }
}

// ---------------------------------------------------------------------------
// External target artifact index (artifact-manifest[.<target>].json)
//
// A release emits one index per host target listing the actual shipped files
// with sizes and SHA256 digests. This is validated as a separate document from
// the embedded development identity above: the index must describe a coherent
// current-host build (matching target, suite version and checksums) and must
// never reference itself.
// ---------------------------------------------------------------------------
if (externalIndexPath !== undefined) {
  let index = null;
  try {
    index = JSON.parse(readFileSync(externalIndexPath, 'utf8'));
  } catch (err) {
    fail(`cannot read/parse artifact index ${basename(externalIndexPath)}: ${err.message}`);
  }
  if (index !== null) {
    const indexName = basename(externalIndexPath);
    const indexKeys = ['schema', 'suite_version', 'target', 'publishable', 'artifacts'];
    for (const key of indexKeys) {
      if (!Object.hasOwn(index, key)) fail(`artifact index ${indexName} is missing "${key}"`);
    }
    for (const key of Object.keys(index)) {
      if (!indexKeys.includes(key)) fail(`artifact index ${indexName} has unknown key "${key}"`);
    }
    if (index.schema !== 'wrenyard.local-artifacts.v1') {
      fail(`artifact index ${indexName} schema ${JSON.stringify(index.schema)} does not match wrenyard.local-artifacts.v1`);
    }
    if (typeof index.suite_version !== 'string' || !matches(index.suite_version, schema?.properties?.suite_version?.pattern)) {
      fail(`artifact index ${indexName} suite_version must match the contract version pattern, got ${JSON.stringify(index.suite_version)}`);
    } else if (manifest !== null && index.suite_version !== manifest.suite_version) {
      fail(`artifact index ${indexName} suite_version ${index.suite_version} does not match the release manifest suite_version ${manifest.suite_version}`);
    }
    const targetPattern = /^(darwin|linux|win32)-(x64|arm64)$/;
    if (typeof index.target !== 'string' || !targetPattern.test(index.target)) {
      fail(`artifact index ${indexName} target must match ^(darwin|linux|win32)-(x64|arm64)$, got ${JSON.stringify(index.target)}`);
    } else if (index.target !== hostTriplet) {
      fail(`artifact index ${indexName} target ${index.target} does not match the host target ${hostTriplet}`);
    }
    if (typeof index.publishable !== 'boolean') {
      fail(`artifact index ${indexName} publishable must be a boolean, got ${JSON.stringify(index.publishable)}`);
    } else if (index.publishable && (manifest === null || manifest.release_status !== 'stable')) {
      fail(`artifact index ${indexName} is publishable but the release manifest is not stable`);
    }
    if (!Array.isArray(index.artifacts)) {
      fail(`artifact index ${indexName} artifacts must be an array`);
    } else {
      for (const artifact of index.artifacts) {
        if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
          fail(`artifact index ${indexName} entry must be an object`);
          continue;
        }
        const artKeys = ['path', 'size', 'sha256'];
        for (const key of artKeys) {
          if (!Object.hasOwn(artifact, key)) fail(`artifact index ${indexName} entry is missing "${key}"`);
        }
        for (const key of Object.keys(artifact)) {
          if (!artKeys.includes(key)) fail(`artifact index ${indexName} entry has unknown key "${key}"`);
        }
        if (typeof artifact.path !== 'string' || artifact.path.length === 0) {
          fail(`artifact index ${indexName} entry path must be a non-empty string`);
        } else {
          const resolved = containedUnder(suiteRoot, artifact.path);
          if (resolved === null) {
            fail(`artifact index ${indexName} entry path must be contained under the suite root: ${artifact.path}`);
          } else if (resolved === externalIndexPath) {
            fail(`artifact index ${indexName} must not reference itself: ${artifact.path}`);
          } else if (!existsSync(resolved)) {
            fail(`artifact index ${indexName} entry does not exist: ${artifact.path}`);
          } else {
            let realInside = false;
            try {
              const realRoot = realpathSync(suiteRoot);
              const realResolved = realpathSync(resolved);
              realInside = realResolved === realRoot || realResolved.startsWith(realRoot + sep);
            } catch {
              realInside = false;
            }
            if (!realInside) {
              fail(`artifact index ${indexName} entry path escapes the suite root after realpath: ${artifact.path}`);
            } else {
              let stat = null;
              try {
                stat = statSync(resolved);
              } catch {
                fail(`artifact index ${indexName} entry could not be stat'ed: ${artifact.path}`);
              }
              if (stat !== null) {
                if (!stat.isFile()) {
                  fail(`artifact index ${indexName} entry must be a regular file: ${artifact.path}`);
                }
                if (typeof artifact.size !== 'number' || !Number.isInteger(artifact.size) || artifact.size < 0) {
                  fail(`artifact index ${indexName} entry size must be a non-negative integer, got ${JSON.stringify(artifact.size)}`);
                } else if (stat.size !== artifact.size) {
                  fail(`artifact index ${indexName} entry size mismatch: index ${artifact.size}, actual ${stat.size}`);
                }
              }
              if (typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256)) {
                let digest = null;
                try {
                  digest = createHash('sha256').update(readFileSync(resolved)).digest('hex');
                } catch {
                  fail(`artifact index ${indexName} entry could not be read to verify sha256: ${artifact.path}`);
                }
                if (digest !== null && digest !== artifact.sha256) {
                  fail(`artifact index ${indexName} entry sha256 mismatch: index ${artifact.sha256}, computed ${digest}`);
                }
              }
            }
          }
        }
        if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
          fail(`artifact index ${indexName} entry sha256 must be exactly 64 lowercase hex chars`);
        }
      }
    }
  }
}

if (errors.length > 0) {
  for (const err of errors) console.error(`error: ${err}`);
  process.exit(1);
}

console.log(`release manifest OK: ${manifest.suite_version} (${manifest.release_status}, publishable=${manifest.publishable})`);
