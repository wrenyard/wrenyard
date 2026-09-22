#!/usr/bin/env node
/**
 * Offline Desktop settings conversion: version 1 (Desktop-wrapped Pet document
 * or a raw legacy Pet config) to the version 2 `DesktopSettings` document.
 *
 * The product never migrates at runtime: `DesktopSettingsStore` rejects a
 * document that is not exactly version 2 and preserves the original file, so
 * this tool is the only supported upgrade path. Run it with Desktop and the dev
 * supervisor stopped, then start the new Desktop.
 *
 * Usage:
 *   node tools/convert-settings.mjs --in <source.json> --out <settings.json> [--force]
 *
 * `--in`  is the existing document to read: either the previous Desktop
 *         `settings.json` (`{ version: 1, pet, update }`) or, when the Desktop
 *         document is absent, the legacy Pet config file an operator names
 *         explicitly. There is no directory guessing or recursive search.
 * `--out` is the version 2 document to write; it may be the same path as
 *         `--in` for an in-place upgrade.
 *
 * Every existing file that is read or overwritten is copied to an exclusive,
 * timestamped `.bak` sibling (created with O_EXCL, so a backup is never
 * overwritten) before anything is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETTINGS_VERSION = 2;

const DEFAULT_PROVIDER_IDS = [
  'chatgpt',
  'cursor',
  'deepseek',
  'zhipu-coding',
  'kimi-coding',
  'super-grok',
];

function usage() {
  return [
    'Usage: node tools/convert-settings.mjs --in <source.json> --out <settings.json> [--force]',
    '',
    'Converts a version 1 Desktop settings document (or a raw legacy Pet config)',
    'into the version 2 Desktop settings document. Both paths are required;',
    'explicit input/output keeps the conversion auditable and repeatable.',
    '',
    '  --in <path>   Existing document to convert (required).',
    '  --out <path>  Version 2 document to write; may equal --in (required).',
    '  --force       Rewrite even when the input is already version 2.',
    '  --help        Show this message.',
  ].join('\n');
}

export function parseArgs(argv) {
  const options = { help: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--in' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      options[arg === '--in' ? 'input' : 'output'] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--in=')) {
      options.input = arg.slice('--in='.length);
      continue;
    }
    if (arg.startsWith('--out=')) {
      options.output = arg.slice('--out='.length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function optionalFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rangeNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value < min || value > max ? fallback : value;
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Extract the Pet partition plus the update channel from any supported input. */
export function readInputDocument(parsed, source) {
  if (!isRecord(parsed)) {
    throw new Error(`${source}: expected a JSON object at the document root`);
  }
  const version = parsed.version;
  if (version !== undefined && version !== 1) {
    if (version === SETTINGS_VERSION) {
      return { pet: parsed.pet, update: parsed.update, alreadyVersion2: true };
    }
    throw new Error(`${source}: unsupported settings version ${JSON.stringify(version)}; expected 1`);
  }
  // A version 1 Desktop document wraps the Pet partition under `pet`; a raw
  // legacy Pet config has no wrapper and no version marker.
  if (isRecord(parsed.pet)) {
    return { pet: parsed.pet, update: parsed.update, alreadyVersion2: false };
  }
  return { pet: parsed, update: undefined, alreadyVersion2: false };
}

/**
 * Promote legacy `quota.pools` string ids to provider entries, or keep existing
 * provider entries exactly as they are: order, ids and enabled flags are the
 * user's preference and are never reinterpreted. Returns `undefined` when the
 * document carries no provider preference, so empty stays empty.
 */
export function convertProviders(pet) {
  const quota = isRecord(pet.quota) ? pet.quota : undefined;
  if (quota && Array.isArray(quota.providers)) {
    const providers = [];
    const seen = new Set();
    for (const entry of quota.providers) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      providers.push({ id, enabled: booleanOr(entry.enabled, true) });
    }
    return providers;
  }
  if (quota && Array.isArray(quota.pools)) {
    const providers = [];
    const seen = new Set();
    for (const rawId of quota.pools) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      providers.push({ id, enabled: true });
    }
    return providers;
  }
  return undefined;
}

function convertGeometry(value) {
  if (!isRecord(value)) return undefined;
  const geometry = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const raw = optionalFinite(value[key]);
    if (raw !== undefined) geometry[key] = raw;
  }
  return Object.keys(geometry).length > 0 ? geometry : undefined;
}

/**
 * Convert one legacy document into the version 2 shape. Warnings describe
 * legacy fields that have no version 2 representation so the handoff can record
 * exactly what changed.
 */
export function convertSettingsDocument(parsed, source) {
  const { pet, update, alreadyVersion2 } = readInputDocument(parsed, source);
  const warnings = [];
  if (alreadyVersion2) return { document: structuredClone(parsed), warnings, alreadyVersion2 };
  if (!isRecord(pet)) {
    throw new Error(`${source}: expected an object Pet partition to convert`);
  }

  const house = isRecord(pet.house) ? pet.house : {};
  const entities = isRecord(pet.entities) ? pet.entities : {};
  const appearance = isRecord(pet.appearance) ? pet.appearance : {};
  const windows = isRecord(pet.windows) ? pet.windows : {};
  const skin = appearance.houseSkin === 'mushroom' ? 'mushroom' : 'classic';

  const legacyCarrier = optionalFinite(house.x) !== undefined || optionalFinite(house.y) !== undefined;
  if (legacyCarrier && (optionalFinite(house.entityX) === undefined || optionalFinite(house.entityY) === undefined)) {
    throw new Error(`${source}: legacy house position has no visible-house anchor; save the position with the previous Desktop before conversion. Input was not changed.`);
  }
  if (legacyCarrier) {
    warnings.push(
      'legacy pet.house.x/y carrier origin dropped: version 2 keeps only the visible-house anchor (house.entityX/entityY)',
    );
  }
  if (pet.providerMigration !== undefined) {
    warnings.push('legacy pet.providerMigration marker dropped: runtime provider migration no longer exists');
  }

  const displayId = optionalInteger(house.displayId) ?? optionalInteger(pet.displayId);
  const entityX = optionalFinite(house.entityX);
  const entityY = optionalFinite(house.entityY);
  const petSettings = {
    visible: booleanOr(pet.enabled, true),
    scale: rangeNumber(pet.scale, 3, 1, 6),
    bubbleSeconds: rangeNumber(pet.bubbleSeconds, 6, 1, 60),
    bottomOffset: rangeNumber(pet.bottomOffset, 0, 512),
    entities: {
      house: booleanOr(entities.house, true),
      workers: booleanOr(entities.workers, true),
      taskgraphs: booleanOr(entities.taskgraphs, true),
    },
    appearance: { houseSkin: skin },
  };
  if (displayId !== undefined) petSettings.displayId = displayId;
  if (entityX !== undefined || entityY !== undefined) {
    petSettings.layout = {
      ...(entityX !== undefined ? { entityX } : {}),
      ...(entityY !== undefined ? { entityY } : {}),
    };
  }

  const providers = convertProviders(pet);
  const graphSlip = convertGeometry(windows.graphSlip);
  const updateRecord = isRecord(update) ? update : {};
  const channel = updateRecord.channel === 'dev' ? 'dev' : 'stable';

  const document = {
    version: SETTINGS_VERSION,
    window: graphSlip ? { graphSlip } : {},
    tray: {},
    providers: { providers: providers ?? DEFAULT_PROVIDER_IDS.map((id) => ({ id, enabled: true })) },
    pet: petSettings,
    update: { channel },
  };
  return { document, warnings, alreadyVersion2 };
}

/** Timestamped, exclusive backup path for a file that is about to change. */
export function backupPathFor(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.${stamp}.bak`;
}

/**
 * Copy an existing file to an exclusive timestamped sibling. `wx` fails when
 * the target exists, so an earlier rollback copy is never overwritten.
 */
export function backupExclusive(file) {
  if (!fs.existsSync(file)) return undefined;
  const bytes = fs.readFileSync(file);
  const base = backupPathFor(file);
  for (let attempt = 0; ; attempt += 1) {
    const target = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      fs.writeFileSync(target, bytes, { flag: 'wx' });
      return target;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
}

export function convertFile({ input, output, force = false }) {
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `input document not found: ${inputPath}. Stop Desktop, then point --in at the existing settings.json or the legacy Pet config file named by the operator.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(`${inputPath}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  const { document, warnings, alreadyVersion2 } = convertSettingsDocument(parsed, inputPath);
  if (alreadyVersion2 && !force) {
    throw new Error(
      `${inputPath}: already a version ${SETTINGS_VERSION} document; pass --force to rewrite it`,
    );
  }

  // Back up every file this run reads or overwrites before writing anything.
  const backups = [];
  const inputBackup = backupExclusive(inputPath);
  if (inputBackup) backups.push(inputBackup);
  if (outputPath !== inputPath) {
    const outputBackup = backupExclusive(outputPath);
    if (outputBackup) backups.push(outputBackup);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return { input: inputPath, output: outputPath, backups, warnings, alreadyVersion2, document };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.input || !options.output) {
    throw new Error(`--in and --out are both required\n\n${usage()}`);
  }
  const result = convertFile({
    input: options.input,
    output: options.output,
    force: options.force,
  });
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
  for (const backup of result.backups) console.log(`backup: ${backup}`);
  console.log(
    `converted ${result.input} -> ${result.output} (version ${SETTINGS_VERSION}, ${result.document.providers.providers.length} providers, update channel ${result.document.update.channel})`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`convert-settings: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
