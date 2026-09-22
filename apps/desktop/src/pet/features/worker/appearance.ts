import type {
  Appearance,
  WorkerClient,
  WorkerSkin,
  WorkerSkinColors,
  WorkerSkinId,
} from '../../shared/snapshot';

// ─── Role categories ──────────────────────────────────────────────────
//
//   official = classic-codebuddy, classic-codex, classic-claude
//   classic  = classic-voxel-miner
//   original = the nine generated per-run-themed skins
//
// For each Foreman task/run, exactly one candidate list is constructed:
// one official role (selected from client_family, with profile regex as a
// legacy fallback when client_family is missing/unknown), all classic roles,
// and all original roles — each appearing exactly once. A stable hash seed
// picks one candidate uniformly.

type OfficialSkinId = 'classic-codebuddy' | 'classic-codex' | 'classic-claude';
type ClassicSkinId = 'classic-voxel-miner';
type OriginalSkinId = Exclude<WorkerSkinId, OfficialSkinId | ClassicSkinId>;

export const OFFICIAL_SKIN_IDS: readonly OfficialSkinId[] = [
  'classic-codebuddy',
  'classic-codex',
  'classic-claude',
];

export const CLASSIC_SKIN_IDS: readonly ClassicSkinId[] = ['classic-voxel-miner'];

export const ORIGINAL_SKIN_IDS: readonly OriginalSkinId[] = [
  'red-jumper',
  'green-quest',
  'blue-dash',
  'block-miner',
  'space-bounty',
  'arcade-ghost',
  'rune-mage',
  'shadow-ninja',
  'slime-king',
];

const ORIGINAL_SKIN_NAMES: Record<OriginalSkinId, string> = {
  'red-jumper': 'Carpenter',
  'green-quest': 'Gardener',
  'blue-dash': 'Runner',
  'block-miner': 'Mason',
  'space-bounty': 'Welder',
  'arcade-ghost': 'Night Watch',
  'rune-mage': 'Surveyor',
  'shadow-ninja': 'Roofer',
  'slime-king': 'Foreman',
};

// Fixed authored color sets for every original role using the Lamplight
// workshop palette: primary = role color, accent = lamp #FFC94D, tool = ink #2E2018.
const ORIGINAL_SKIN_COLORS: Record<OriginalSkinId, WorkerSkinColors> = {
  'red-jumper': { primary: '#4A6FA5', accent: '#FFC94D', tool: '#2E2018' },
  'green-quest': { primary: '#B5653A', accent: '#FFC94D', tool: '#2E2018' },
  'blue-dash': { primary: '#7BA05B', accent: '#FFC94D', tool: '#2E2018' },
  'block-miner': { primary: '#C99A3C', accent: '#FFC94D', tool: '#2E2018' },
  'space-bounty': { primary: '#7D5A7A', accent: '#FFC94D', tool: '#2E2018' },
  'arcade-ghost': { primary: '#5A6B7A', accent: '#FFC94D', tool: '#2E2018' },
  'rune-mage': { primary: '#2F8F83', accent: '#FFC94D', tool: '#2E2018' },
  'shadow-ninja': { primary: '#A8523F', accent: '#FFC94D', tool: '#2E2018' },
  'slime-king': { primary: '#8A8A4A', accent: '#FFC94D', tool: '#2E2018' },
};

const OFFICIAL_SKINS: Record<OfficialSkinId, WorkerSkin> = {
  'classic-codebuddy': {
    kind: 'official',
    id: 'classic-codebuddy',
    name: 'Classic CodeBuddy',
    colors: { primary: '#9AA3AA', accent: '#44D7B6', tool: '#334155' },
  },
  'classic-codex': {
    kind: 'official',
    id: 'classic-codex',
    name: 'Classic Codex',
    colors: { primary: '#111827', accent: '#38BDF8', tool: '#1B2440' },
  },
  'classic-claude': {
    kind: 'official',
    id: 'classic-claude',
    name: 'Classic Claude',
    colors: { primary: '#D97757', accent: '#F6C7A9', tool: '#4B2C24' },
  },
};

const CLASSIC_SKINS: Record<ClassicSkinId, WorkerSkin> = {
  'classic-voxel-miner': {
    kind: 'classic',
    id: 'classic-voxel-miner',
    name: 'Classic Voxel Miner',
    colors: { primary: '#2A93B5', accent: '#41DDE8', tool: '#118A9A' },
  },
};

// Legacy profile-regex fallback for the official role. Used only when
// client_family is missing or unknown.
const OFFICIAL_PROFILE_SKINS: Array<{ pattern: RegExp; id: OfficialSkinId }> = [
  { pattern: /codex(?:-mini|-lite|-high|-xhigh|-spark)?/i, id: 'classic-codex' },
  { pattern: /claude|anthropic/i, id: 'classic-claude' },
  { pattern: /(?:^|[^a-z0-9])(?:steve|voxel-miner|classic-voxel-miner)(?:$|[^a-z0-9])/i, id: 'classic-codebuddy' },
  { pattern: /(?:^|[^a-z0-9])(?:cb-dsf|cb-ds|ccb-ds|ccb-dsf|ccb-hy|ccg|ccds|codebuddy)(?:$|[^a-z0-9])/i, id: 'classic-codebuddy' },
];

function officialSkinForClient(client: WorkerClient): OfficialSkinId | null {
  if (client === 'codebuddy') return 'classic-codebuddy';
  if (client === 'codex') return 'classic-codex';
  if (client === 'claude') return 'classic-claude';
  return null;
}

function officialSkinForProfile(profile: string): OfficialSkinId | null {
  for (const { pattern, id } of OFFICIAL_PROFILE_SKINS) {
    if (pattern.test(profile)) return id;
  }
  return null;
}

function stableHash(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function compactProfileLabel(profile: string): string {
  const trimmed = profile.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function originalSkin(id: OriginalSkinId, _seedKey: string): WorkerSkin {
  return {
    kind: 'original',
    id,
    name: ORIGINAL_SKIN_NAMES[id],
    colors: ORIGINAL_SKIN_COLORS[id],
  };
}

/**
 * Build the role candidate list for a single Foreman task/run:
 * exactly one official role (from client_family, falling back to profile
 * regex when the family is unknown), all classic roles, and all original
 * roles — each appearing exactly once.
 */
export function roleCandidates(client: WorkerClient, profile: string): WorkerSkinId[] {
  const officialId = officialSkinForClient(client) ?? officialSkinForProfile(profile);
  const candidates: WorkerSkinId[] = [];
  if (officialId) candidates.push(officialId);
  candidates.push(...CLASSIC_SKIN_IDS);
  candidates.push(...ORIGINAL_SKIN_IDS);
  return candidates;
}

function resolveSkin(client: WorkerClient, profile: string, seedKey: string): WorkerSkin {
  const candidates = roleCandidates(client, profile);
  const id = candidates[stableHash(`${seedKey}:role`) % candidates.length];
  if (id in OFFICIAL_SKINS) return OFFICIAL_SKINS[id as OfficialSkinId];
  if (id in CLASSIC_SKINS) return CLASSIC_SKINS[id as ClassicSkinId];
  return originalSkin(id as OriginalSkinId, seedKey);
}

/**
 * Generate appearance from profile, worker identity, and client family.
 *
 * `foremanTaskRunID` (when present) is preferred as the per-run seed so the
 * original-role theme follows the task run; otherwise the worker identity
 * key is used. `client` (already classified) selects the official role
 * candidate; profile regex is a legacy fallback only when the family is
 * unknown.
 */
export function getAppearance(
  profile: string,
  workerIdentityKey: string,
  client: WorkerClient,
  foremanTaskRunID?: string,
): Appearance {
  const seedKey = foremanTaskRunID ?? workerIdentityKey;
  return {
    profile,
    profileLabel: compactProfileLabel(profile),
    skin: resolveSkin(client, profile, seedKey),
  };
}
