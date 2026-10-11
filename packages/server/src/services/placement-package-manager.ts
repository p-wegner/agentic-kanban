// Placement's view of "does this worker have the package manager the project's lockfile
// needs" (#1369). Explanatory only: it never changes who is eligible, because the resolver
// does not read it - the worker's setup would fail as `assign_failed`, and `worker explain`
// is where an operator learns why, BEFORE dispatching instead of from that failure.
import { deriveFallbackSetupCommand } from "../worker/worker-repo.js";
import type { WorkerEligibility } from "../lib/placement-explain.types.js";

/**
 * The package manager the project's fallback install would run, or null (npm / no manifest).
 * Reuses the worker's own lockfile ladder, so board and worker can never disagree about it.
 */
export function requiredPackageManagerFor(repoPath: string | null | undefined): "pnpm" | "yarn" | "bun" | null {
  if (!repoPath) return null;
  try {
    const tool = deriveFallbackSetupCommand(repoPath)?.split(" ")[0];
    return tool === "pnpm" || tool === "yarn" || tool === "bun" ? tool : null;
  } catch {
    return null;
  }
}

/**
 * One sentence per worker that REPORTED its package managers and lacks `required`, with the fix.
 * A worker that reported nothing is unknown, not lacking, and gets no sentence.
 */
export function missingPackageManagerNotes(
  required: "pnpm" | "yarn" | "bun" | null,
  workers: readonly Pick<WorkerEligibility, "name" | "packageManagers">[],
): string[] {
  if (!required) return [];
  const notes: string[] = [];
  for (const w of workers) {
    const have = w.packageManagers;
    if (!have || have[required]) continue;
    const fix = have.corepack
      ? `run 'corepack enable ${required}' there`
      : required === "bun"
        ? "install bun there (npm i -g bun)"
        : `install it there (npm i -g ${required})`;
    notes.push(
      `worker ${w.name} has no ${required} on PATH but this project's lockfile needs ${required} (its install would fail as assign_failed) - ${fix}`,
    );
  }
  return notes;
}
