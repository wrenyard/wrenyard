import type { HousePreviewFixture, WorkerPreviewFixture } from './fixtures.mjs';

export type PreviewFixture = WorkerPreviewFixture | HousePreviewFixture;

export interface CaptureThreshold {
  maxBoundsDelta: number;
  channelDelta: number;
  maxChangedRatio: number;
}

export interface ManifestValidationResult {
  ok: boolean;
  details?: string;
}

export const SCHEMA_VERSION: string;
export const STATIC_PREVIEW_READY_DATASET: string;
export const STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET: string;
export const STATIC_PREVIEW_CONTEXT_LOST_DATASET: string;
export const STATIC_PREVIEW_OUTPUT_KEY: string;
export const NOW_MS: number;
export const THRESHOLD: CaptureThreshold;
export const FAILURE_REASONS: readonly string[];
export const PET_API_METHOD_NAMES: readonly string[];

export function parseInjectFailure(argv: readonly string[]): string | undefined;
export function assertFailureReason(reason: string): void;
export function failurePayload(reason: string, details: string, caseId?: string): Record<string, unknown>;
export function serializeFailure(reason: string, details: string, caseId?: string): string;
export function removeSuccessManifest(rootDir: string): void;
export function manifestAbsolutePath(rootDir: string): string;
export function captureDir(rootDir: string): string;
export function caseIdForFixture(fixture: PreviewFixture): string;
export function viewportForFixture(fixture: PreviewFixture): { width: number; height: number; dpr: number; scale: number; nowMs: number };
export function htmlPathForFixture(rootDir: string, fixture: PreviewFixture): string;
export function outputPathForFixture(rootDir: string, fixture: PreviewFixture): string;
export function referencePathForFixture(rootDir: string, fixture: PreviewFixture): string;
export function repoRelative(rootDir: string, absolutePath: string): string;
export function additionalArgumentsForFixture(fixture: PreviewFixture): string[];
export function staticQueryForFixture(fixture: PreviewFixture): Record<string, string>;
export function buildManifest(cases: readonly Record<string, unknown>[]): Record<string, unknown>;
export function buildManifestCase(input: {
  fixture: PreviewFixture;
  rootDir: string;
  referenceSha256: string;
  outputSha256: string;
  compare: {
    changedPixels: number;
    changedRatio: number;
    boundsDelta: { left: number; top: number; right: number; bottom: number };
  };
}): Record<string, unknown>;
export function serializeManifest(manifest: unknown): string;
export function validateManifestShape(manifest: unknown, expectedFixtures?: readonly PreviewFixture[]): ManifestValidationResult;
export function validateSerializedManifest(serialized: string, expectedManifest: unknown): ManifestValidationResult;
