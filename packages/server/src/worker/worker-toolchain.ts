// What a worker machine has on PATH that a project's fallback install needs (#1369).
//
// The worker's fallback install (`deriveFallbackSetupCommand`) runs pnpm/yarn/bun to match the
// project's lockfile, and a machine without it fails the whole assignment as `assign_failed`.
// The doctor cannot know every project's lockfile, so the worker REPORTS what it has on every
// heartbeat and the board's placement explanation names the one a project is missing.
//
// Standalone-binary safe: node builtins only, no database, no board services.
import { execFile } from "node:child_process";
import type { WorkerPackageManagers } from "@agentic-kanban/shared/lib/worker-protocol";

/** Does `command --version` run? Never throws; ENOENT (or any spawn failure) is "absent". */
export function commandExists(command: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    // `shell: true` on Windows: pnpm/yarn/corepack are `.cmd` shims there, which execFile
    // cannot spawn directly. The command name is a fixed literal, never operator input.
    execFile(
      command,
      ["--version"],
      { timeout: timeoutMs, windowsHide: true, shell: process.platform === "win32" },
      (err) => resolve(!err),
    );
  });
}

/** Probe pnpm / yarn / bun / corepack. */
export async function detectPackageManagers(
  exists: (command: string) => Promise<boolean> = commandExists,
): Promise<WorkerPackageManagers> {
  const [pnpm, yarn, bun, corepack] = await Promise.all([
    exists("pnpm"),
    exists("yarn"),
    exists("bun"),
    exists("corepack"),
  ]);
  return { pnpm, yarn, bun, corepack };
}

/** Re-probe at most this often from the heartbeat; an install made meanwhile shows up within it. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let cached: WorkerPackageManagers | undefined;
let refreshedAtMs = 0;
let inFlight: Promise<void> | null = null;

/** The last probe result, or undefined before the first one finishes. Synchronous, for heartbeats. */
export function cachedPackageManagers(): WorkerPackageManagers | undefined {
  return cached;
}

/** Probe now (awaitable), or return immediately if a probe is already running. */
export function refreshPackageManagers(
  nowMs: number = Date.now(),
  exists?: (command: string) => Promise<boolean>,
): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = detectPackageManagers(exists)
    .then((found) => {
      cached = found;
      refreshedAtMs = nowMs;
    })
    .catch(() => {
      /* keep the previous reading; absent stays "unknown" */
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Kick a background re-probe when the reading is older than the refresh interval. */
export function refreshPackageManagersIfStale(nowMs: number = Date.now()): void {
  if (cached && nowMs - refreshedAtMs < REFRESH_INTERVAL_MS) return;
  void refreshPackageManagers(nowMs);
}

/** Test seam: forget the cached reading. */
export function resetPackageManagerCache(): void {
  cached = undefined;
  refreshedAtMs = 0;
  inFlight = null;
}
