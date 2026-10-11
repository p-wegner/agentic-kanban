// #1373 — the heads-ups `update-check` prints beside its verdict. Own module: worker-update-check.ts and
// worker-doctor.ts are near their declaration ceilings. Db-free (ships in the standalone worker binary).
import { parseBuildId, sameBuild } from "../../lib/worker-update.js";
import {
  registerStateFile,
  resolveHarnessConfig,
  writePersistedHarness,
  type HarnessFlags,
  type ResolvedHarnessConfig,
} from "../../worker/worker-harness.js";
import { readPointer, versionsDirFor } from "../../worker/worker-versions.js";
import { shimCommandFor } from "../../worker/worker-shim.js";

/** The one-line fix for a global launcher that a self-update never refreshes (#1350). */
export function globalLauncherFix(stateFile: string): string {
  return (
    "Refresh the global install with the board's tarball: npm i -g <path-to-agentic-kanban-*.tgz> " +
    `(steps: agentic-kanban-worker setup --guide), or restart through the stable shim: ${shimCommandFor(stateFile)} start ...`
  );
}

/** The build the daemon runs after a self-update: the `versions/current.json` pointer (hex ids only). */
export function installedBuildOf(stateFile: string): string | undefined {
  const id = readPointer(versionsDirFor(stateFile))?.buildId;
  return id && /^[0-9a-f]{7,40}$/i.test(id) ? id.toLowerCase() : undefined;
}

/** WARN text when the global launcher is a different build than the running one; null when fine/unknown. */
export function globalLauncherWarning(opts: {
  stateFile: string;
  globalVersion: string | null;
  runningBuild: string | undefined;
}): string | null {
  const globalBuild = parseBuildId(opts.globalVersion);
  if (!globalBuild || !opts.runningBuild || sameBuild(globalBuild, opts.runningBuild)) return null;
  return (
    `WARNING: the global agentic-kanban-worker is build ${globalBuild.slice(0, 9)}, older than the running build ` +
    `${opts.runningBuild.slice(0, 9)}; flags added since (e.g. start --config-dir) fail there with 'unknown option'. ` +
    globalLauncherFix(opts.stateFile)
  );
}

/** After `update-check --apply`: say so when the global launcher is now a different build. */
export function printLauncherWarning(
  stateFile: string,
  globalVersion: string | null,
  log: (line: string) => void,
): void {
  const warn = globalLauncherWarning({
    stateFile,
    globalVersion,
    runningBuild: installedBuildOf(stateFile),
  });
  if (warn) log(warn);
}

/**
 * `worker start`: resolve the harness from flags + the state file, report disagreements and the
 * legacy keep-inherit case once, and record the result (and the state file) for doctor / auth.
 */
export function persistStartHarness(stateFile: string, flags: HarnessFlags): ResolvedHarnessConfig {
  const cfg = resolveHarnessConfig(stateFile, flags);
  for (const d of cfg.differences) console.warn(`[worker] ${d}; the flags win and are now recorded`);
  if (cfg.legacyInherit) {
    console.log(
      "[worker] this worker still uses your own ~/.claude (inherit); run agentic-kanban-worker auth claude " +
        "and restart with --clean to switch",
    );
  }
  writePersistedHarness(stateFile, cfg.toPersist);
  registerStateFile(stateFile);
  return cfg;
}

/**
 * What an update does to which providers this worker advertises (#1373 F1). A pairing whose state
 * predates harness modes keeps `inherit` (its claude login stays in your own ~/.claude); a recorded
 * `clean` mode with no login in the worker's folder would stop advertising claude.
 */
export function harnessUpdateNote(stateFile: string): string | null {
  if (!resolveHarnessConfig(stateFile).legacyInherit) return null;
  return (
    "note: this pairing predates harness modes. The target build keeps it in inherit mode, so it still uses your own " +
    "~/.claude and keeps advertising the same providers; run agentic-kanban-worker auth claude and restart with " +
    "--clean to switch to the worker's own folder."
  );
}
