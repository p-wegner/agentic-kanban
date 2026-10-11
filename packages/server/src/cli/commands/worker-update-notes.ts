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
import { shimCommandFor, shimInstalled } from "../../worker/worker-shim.js";
import type { DoctorCheck } from "./worker-doctor.js";

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

// #1372 (item 7) - which command a remedy should tell the reader to run. Bare `agentic-kanban-worker` resolves to the
// global launcher, which a self-update never refreshes (#1350); while that is stale or absent, the stable shim
// always runs the current build.
const BARE = "agentic-kanban-worker";
const VERBS = "setup|auth|start|doctor|update-check|pair|cleanup";

/** The command to print in remedies: the shim path when the global launcher is stale or absent AND the shim exists. */
export function launcherCommand(opts: {
  stateFile: string;
  globalVersion: string | null;
  /** Build id (hex) of the running install; undefined = unknown. */
  runningBuild: string | undefined;
  hasShim?: boolean;
}): string {
  const hasShim = opts.hasShim ?? shimInstalled(opts.stateFile);
  if (!hasShim) return BARE;
  const globalBuild = parseBuildId(opts.globalVersion);
  const runningBuild = opts.runningBuild;
  // Absent global, or a global whose build id provably differs; an unreadable id proves nothing.
  const stale = opts.globalVersion === null || (globalBuild !== undefined && runningBuild !== undefined && !sameBuild(globalBuild, runningBuild));
  if (!stale) return BARE;
  const shim = shimCommandFor(opts.stateFile);
  return /\s/.test(shim) ? `"${shim}"` : shim;
}

/** Swap bare `agentic-kanban-worker <verb>` in remedies for `launcher`. Details and other prose are left alone. */
export function useLauncherInRemedies(checks: DoctorCheck[], launcher: string): DoctorCheck[] {
  if (launcher === BARE) return checks;
  const re = new RegExp(`(^|[\\s\`'"(])${BARE}(?=\\s+(?:${VERBS})\\b)`, "g");
  return checks.map((c) => (c.remedy ? { ...c, remedy: c.remedy.replace(re, (_m, pre: string) => `${pre}${launcher}`) } : c));
}
