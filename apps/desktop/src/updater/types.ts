/**
 * Shared Desktop updater contracts.
 *
 * The updater has one cross-platform flow (controller) and three platform
 * appliers. Only "apply the verified asset to the system" differs, so every
 * applier implements this interface and the controller stays platform-agnostic.
 */

import type { SpawnOptions } from 'node:child_process';

/** Spawns a detached process that outlives Desktop; the caller never waits. */
export type SpawnDetached = (command: string, args: string[], options: SpawnOptions) => void;

/** Result of one external command, mirroring the relevant spawnSync fields. */
export interface CommandResult {
  status: number | null;
  error?: Error;
  stdout: string;
  stderr: string;
}

/** Injected process runner; appliers never spawn through a shell. */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => CommandResult | Promise<CommandResult>;

/** A condition the user must acknowledge before Desktop can quit and update. */
export interface UpdateBlocker {
  message: string;
}

/** A verified download prepared by an applier, ready to be switched in. */
export interface PreparedUpdate {
  /** Absolute path of the verified asset (NSIS setup.exe / macOS zip / Linux AppImage). */
  assetPath: string;
  version: string;
  /** macOS: extracted `.app`. Linux: staged AppImage beside `$APPIMAGE`. */
  stagedAppPath?: string;
}

/** Platform-specific install/apply behavior for the shared update controller. */
export interface PlatformApplier {
  /** Startup and pre-update blocking checks; null when nothing blocks. */
  preflight(stage: 'startup' | 'update'): Promise<UpdateBlocker | null>;
  /**
   * Turns the verified asset into a state that can be switched in directly.
   * The optional `onPhase` callback lets a platform report its own preparation
   * steps (e.g. extraction) without changing the returned {@link PreparedUpdate}.
   * `verifying` is codesign plus bundle version on macOS, and a streamed
   * sha256 of the staged AppImage against the feed digest on Linux.
   * Windows does not report prepare phases.
   */
  prepare(
    assetPath: string,
    version: string,
    onPhase?: (phase: 'extracting' | 'verifying') => void,
    expectedSha256?: string,
  ): Promise<PreparedUpdate>;
  /** Starts the detached follow-up; the caller then quits Desktop. */
  apply(prepared: PreparedUpdate): void;
  /** Cleanup performed after the new version started healthy. */
  finalize(): Promise<void>;
}
