import type {
  Appearance,
  WorkerClient,
  WorkerSkin,
  WorkerSkinId,
} from '../../shared/snapshot';

// ─── Skin catalog ─────────────────────────────────────────────────────
//
// One table holds every worker skin. Categories:
//   official = native client mascots (one or more per client)
//   classic  = video-game character themes
//   original = Pet-created characters (the Lamplight crew)
//
// Selection first picks a category (native mascot vs. everything else) and
// only then a skin inside that category, so changing a pool's size never
// dilutes the 80/20 native share.

/**
 * Catalog row: a worker skin plus the client it mascots (official only).
 */
export interface WorkerSkinCatalogEntry extends WorkerSkin {
  client?: WorkerClient;
}

export const SKIN_CATALOG: readonly WorkerSkinCatalogEntry[] = [
  // official — native client mascots
  {
    kind: 'official',
    id: 'classic-codebuddy',
    name: 'CodeBuddy',
    colors: { primary: '#9AA3AA', accent: '#44D7B6', tool: '#334155' },
    client: 'codebuddy',
  },
  {
    kind: 'official',
    id: 'crew-codebuddy',
    name: 'CodeBuddy Crew',
    colors: { primary: '#9AA3AA', accent: '#44D7B6', tool: '#334155' },
    client: 'codebuddy',
  },
  {
    kind: 'official',
    id: 'classic-codex',
    name: 'Codex',
    colors: { primary: '#111827', accent: '#38BDF8', tool: '#1B2440' },
    client: 'codex',
  },
  {
    kind: 'official',
    id: 'crew-codex',
    name: 'Codex Crew',
    colors: { primary: '#111827', accent: '#38BDF8', tool: '#1B2440' },
    client: 'codex',
  },
  {
    kind: 'official',
    id: 'classic-claude',
    name: 'Claude Crab',
    colors: { primary: '#D97757', accent: '#F6C7A9', tool: '#4B2C24' },
    client: 'claude',
  },
  {
    kind: 'official',
    id: 'crew-claude',
    name: 'Claude Crew',
    colors: { primary: '#D97757', accent: '#F6C7A9', tool: '#4B2C24' },
    client: 'claude',
  },
  {
    kind: 'official',
    id: 'native-dsh-fish',
    name: 'DeepSeek Big Fish',
    colors: { primary: '#4D6BFE', accent: '#F7EFD8', tool: '#2E3FA8' },
    client: 'dsh',
  },

  // classic — video-game character themes
  {
    kind: 'classic',
    id: 'classic-voxel-miner',
    name: 'Voxel Miner',
    colors: { primary: '#2A93B5', accent: '#41DDE8', tool: '#118A9A' },
  },
  {
    kind: 'classic',
    id: 'red-jumper',
    name: 'Red Jumper',
    colors: { primary: '#D33A2C', accent: '#2F5DA8', tool: '#FFC94D' },
  },
  {
    kind: 'classic',
    id: 'green-quest',
    name: 'Green Quest',
    colors: { primary: '#3E9B4F', accent: '#E8C36A', tool: '#A9B4BC' },
  },
  {
    kind: 'classic',
    id: 'blue-dash',
    name: 'Blue Dash',
    colors: { primary: '#2F6FD6', accent: '#E2483D', tool: '#F2D2A9' },
  },
  {
    kind: 'classic',
    id: 'block-miner',
    name: 'Block Miner',
    colors: { primary: '#8A5A2E', accent: '#FFC94D', tool: '#5A6B7A' },
  },
  {
    kind: 'classic',
    id: 'space-bounty',
    name: 'Space Bounty',
    colors: { primary: '#E07A2E', accent: '#7BD389', tool: '#C44E3A' },
  },
  {
    kind: 'classic',
    id: 'arcade-ghost',
    name: 'Arcade Ghost',
    colors: { primary: '#E5484D', accent: '#F7EFD8', tool: '#2F5DA8' },
  },
  {
    kind: 'classic',
    id: 'rune-mage',
    name: 'Rune Mage',
    colors: { primary: '#5B4BA8', accent: '#FFC94D', tool: '#8A5A2E' },
  },
  {
    kind: 'classic',
    id: 'shadow-ninja',
    name: 'Shadow Ninja',
    colors: { primary: '#2B2D42', accent: '#C44E3A', tool: '#A9B4BC' },
  },
  {
    kind: 'classic',
    id: 'slime-king',
    name: 'Slime King',
    colors: { primary: '#4A90D9', accent: '#FFC94D', tool: '#C44E3A' },
  },

  // original — the Lamplight crew (b10e22a8 drawings). Colors are inherited
  // from the pre-existing entries those drawings were authored against.
  {
    kind: 'original',
    id: 'crew-headlamp',
    name: 'Headlamp Worker',
    colors: { primary: '#2A93B5', accent: '#41DDE8', tool: '#118A9A' },
  },
  {
    kind: 'original',
    id: 'crew-carpenter',
    name: 'Carpenter',
    colors: { primary: '#4A6FA5', accent: '#FFC94D', tool: '#2E2018' },
  },
  {
    kind: 'original',
    id: 'crew-gardener',
    name: 'Gardener',
    colors: { primary: '#B5653A', accent: '#FFC94D', tool: '#2E2018' },
  },
  {
    kind: 'original',
    id: 'crew-runner',
    name: 'Runner',
    colors: { primary: '#7BA05B', accent: '#FFC94D', tool: '#2E2018' },
  },
  {
    kind: 'original',
    id: 'crew-mason',
    name: 'Mason',
    colors: { primary: '#C99A3C', accent: '#FFC94D', tool: '#2E2018' },
  },
  {
    kind: 'original',
    id: 'crew-welder',
    name: 'Welder',
    colors: { primary: '#7D5A7A', accent: '#FFC94D', tool: '#2E2018' },
  },
  {
    kind: 'original',
    id: 'crew-night-watch',
    name: 'Night Watch',
    colors: { primary: '#5A6B7A', accent: '#FFC94D', tool: '#2E2018' },
  },
  {
    kind: 'original',
    id: 'crew-surveyor',
    name: 'Surveyor',
    colors: { primary: '#2F8F83', accent: '#FFC94D', tool: '#2E2018' },
  },
  {
    kind: 'original',
    id: 'crew-roofer',
    name: 'Roofer',
    colors: { primary: '#A8523F', accent: '#FFC94D', tool: '#2E2018' },
  },
  {
    kind: 'original',
    id: 'crew-foreman',
    name: 'Foreman',
    colors: { primary: '#8A8A4A', accent: '#FFC94D', tool: '#2E2018' },
  },
];

const SKIN_BY_ID = new Map<WorkerSkinId, WorkerSkinCatalogEntry>(
  SKIN_CATALOG.map((skin) => [skin.id, skin] as const),
);

export const OFFICIAL_SKIN_IDS: readonly WorkerSkinId[] = SKIN_CATALOG.filter(
  (skin) => skin.kind === 'official',
).map((skin) => skin.id);

export const CLASSIC_SKIN_IDS: readonly WorkerSkinId[] = SKIN_CATALOG.filter(
  (skin) => skin.kind === 'classic',
).map((skin) => skin.id);

export const ORIGINAL_SKIN_IDS: readonly WorkerSkinId[] = SKIN_CATALOG.filter(
  (skin) => skin.kind === 'original',
).map((skin) => skin.id);

/** Catalog lookup by skin id. */
export function skinById(id: WorkerSkinId): WorkerSkinCatalogEntry | undefined {
  return SKIN_BY_ID.get(id);
}

/** Official skins that mascot the given client ("unknown" has none). */
export function nativeSkinIds(client: WorkerClient): WorkerSkinId[] {
  if (client === 'unknown') return [];
  return SKIN_CATALOG.filter((skin) => skin.client === client).map((skin) => skin.id);
}

/** Every non-official skin: all classic and all original roles. */
export function nonNativeSkinIds(): WorkerSkinId[] {
  return SKIN_CATALOG.filter((skin) => skin.kind !== 'official').map((skin) => skin.id);
}

// ─── Stable selection ─────────────────────────────────────────────────

/** Native category share, in basis points (8000 = 80%). */
export const NATIVE_SHARE_BASIS_POINTS = 8000;

const FALLBACK_SKIN_ID: WorkerSkinId = 'crew-runner';

/**
 * Stable unsigned 32-bit hash: FNV-1a over the UTF-16 code units followed by
 * the murmur3 `fmix32` finalizer for good bit distribution.
 */
function stableHash(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Pick a skin from a native pool and a non-native pool.
 *
 * The category is chosen first: when both pools are non-empty the native pool
 * wins `NATIVE_SHARE_BASIS_POINTS` out of 10000, so pool sizes never dilute the
 * split. A single non-empty pool is used directly; two empty pools return null.
 */
export function pickSkinId(
  nativePool: readonly WorkerSkinId[],
  nonNativePool: readonly WorkerSkinId[],
  seedKey: string,
): WorkerSkinId | null {
  if (nativePool.length === 0 && nonNativePool.length === 0) return null;

  let pool: readonly WorkerSkinId[];
  if (nativePool.length === 0) {
    pool = nonNativePool;
  } else if (nonNativePool.length === 0) {
    pool = nativePool;
  } else {
    const native = stableHash(`${seedKey}:category`) % 10000 < NATIVE_SHARE_BASIS_POINTS;
    pool = native ? nativePool : nonNativePool;
  }
  return pool[stableHash(`${seedKey}:skin`) % pool.length];
}

function compactProfileLabel(profile: string): string {
  const trimmed = profile.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

/**
 * Generate appearance from profile, worker identity, and client.
 *
 * `foremanTaskRunID` (when present) is preferred as the per-run seed so the
 * selected skin follows the task run; otherwise the worker identity key is
 * used. The client picks the native mascot pool; when neither pool yields a
 * skin the crew-runner fallback is used.
 */
export function getAppearance(
  profile: string,
  workerIdentityKey: string,
  client: WorkerClient,
  foremanTaskRunID?: string,
): Appearance {
  const seedKey = foremanTaskRunID ?? workerIdentityKey;
  const id = pickSkinId(nativeSkinIds(client), nonNativeSkinIds(), seedKey) ?? FALLBACK_SKIN_ID;
  const skin = skinById(id) ?? skinById(FALLBACK_SKIN_ID)!;
  return {
    profile,
    profileLabel: compactProfileLabel(profile),
    skin,
  };
}
