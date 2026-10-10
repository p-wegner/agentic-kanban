// On-disk state of the versioned worker install (#1338): where builds live, which one is
// current, the pending-switch marker and the last failure. Plain files, so the Windows
// supervisor (ak-worker-run.ps1) can read the same pointer the daemon writes.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// --- on-disk state ---------------------------------------------------------------------------

/** `<worker-home>/versions` — beside the state file, so `--state-file` moves both together. */
export function versionsDirFor(stateFile: string): string {
  return join(dirname(stateFile), "versions");
}

/** Which build the supervisor / a relaunch should run. `ak-worker-run.ps1` reads this file. */
export interface VersionPointer {
  buildId: string;
  /** Absolute path of the `bin/worker.js` to run. */
  entry: string;
  previousBuildId?: string;
  previousEntry?: string;
}

/** Written when a switch is made, deleted when the new build connects. */
export interface PendingSwitch {
  buildId: string;
  previousEntry: string;
  previousBuildId?: string;
  startedAt: string;
  /** Starts of the new build that never reached the board. */
  attempts: number;
}

/** Why the last update failed — read by the (rolled-back) daemon so it can REPORT it. */
export interface UpdateFailure {
  buildId: string;
  reason: string;
  at: string;
  /** #1352: where it failed (manifest, download, checksum, install, no-connect…). */
  phase?: string;
  /** #1352: a network/board-busy failure — retried automatically, never pins the build as failed. */
  transient?: boolean;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export const readPointer = (dir: string): VersionPointer | null => readJson(join(dir, "current.json"));
export const writePointer = (dir: string, p: VersionPointer): void => writeJson(join(dir, "current.json"), p);
export const readPending = (dir: string): PendingSwitch | null => readJson(join(dir, "pending.json"));
export const writePending = (dir: string, p: PendingSwitch): void => writeJson(join(dir, "pending.json"), p);
export const readFailure = (dir: string): UpdateFailure | null => readJson(join(dir, "last-update.json"));
export const writeFailure = (dir: string, f: UpdateFailure): void => writeJson(join(dir, "last-update.json"), f);

export function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}
export const clearPending = (dir: string): void => removeQuietly(join(dir, "pending.json"));
export const clearFailure = (dir: string): void => removeQuietly(join(dir, "last-update.json"));

/** Where an installed build's worker entry lives inside its prefix. */
export function entryForBuild(versionsDir: string, buildId: string): string {
  return join(versionsDir, buildId, "node_modules", "agentic-kanban", "bin", "worker.js");
}
