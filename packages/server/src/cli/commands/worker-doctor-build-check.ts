// #1346 — `worker doctor`'s "which build is this" check. Its own module: worker-doctor.ts sits at
// the god-module gate's declaration ceiling (#889).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseBuildId, sameBuild } from "../../lib/worker-update.js";
import { compareBuilds } from "../../worker/worker-delegate.js";
import { shimCommandFor, shimInstalled } from "../../worker/worker-shim.js";
import type { DoctorCheck } from "./worker-doctor.js";

/** `version` of the package a `bin/worker.js` entry belongs to; null when unreadable. */
export function readEntryVersion(entry: string | null): string | null {
  if (!entry) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Version of the globally installed `agentic-kanban` package (the `npm i -g` launcher); null if none. */
export function probeGlobalVersion(): string | null {
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: process.platform === "win32",
    }).trim();
    const pkg = JSON.parse(readFileSync(join(root, "agentic-kanban", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * #1350: the globally installed launcher is never refreshed by a self-update. WARN when it is a
 * different build than the one running — the stable shim is the restart path that is always right.
 */
export function checkGlobalLauncher(opts: {
  stateFile: string;
  runningEntry: string | null;
  globalVersion?: string | null;
  runningVersion?: string | null;
}): DoctorCheck {
  const name = "global launcher";
  const shim = shimCommandFor(opts.stateFile);
  const hasShim = shimInstalled(opts.stateFile);
  const global = opts.globalVersion === undefined ? probeGlobalVersion() : opts.globalVersion;
  const running = opts.runningVersion === undefined ? readEntryVersion(opts.runningEntry) : opts.runningVersion;
  const globalBuild = parseBuildId(global);
  const runningBuild = parseBuildId(running);
  if (globalBuild && runningBuild && !sameBuild(globalBuild, runningBuild)) {
    return {
      name,
      status: "warn",
      detail: `the global agentic-kanban-worker is build ${globalBuild}, older than the running build ${runningBuild}; a self-update never refreshes it`,
      remedy: hasShim
        ? `Restart manually with the stable shim: ${shim} start ... (it always runs the current build).`
        : `No stable shim yet (it is written on the next \`worker start\`). Until then use: agentic-kanban-worker start …  (delegates only if the global build includes #1346).`,
    };
  }
  if (!hasShim) {
    return { name, status: "pass", detail: `no stable shim yet at ${shim}; written on the next \`worker start\`` };
  }
  return { name, status: "pass", detail: `global launcher ${global ?? "not detected"}; stable shim at ${shim}` };
}

/**
 * Global vs current build. WARN (never fail) when `current.json` names a different installed
 * build: `worker start` delegates to it by default, so the machine is healthy — the operator
 * just ought to know which build actually runs.
 */
export function checkWorkerBuild(
  stateFile: string,
  runningEntry: string | null,
  runningVersion?: string | null,
): DoctorCheck {
  const name = "worker build";
  const cmp = compareBuilds(stateFile, runningEntry);
  const running = runningEntry ?? "unknown";
  // #1359: a differing PATH is not a differing BUILD — the global launcher and the versions-dir
  // copy are the same commit. Compare build ids; only a real mismatch warns.
  const runningBuild = parseBuildId(runningVersion === undefined ? readEntryVersion(runningEntry) : runningVersion);
  if (cmp.current?.installed && cmp.differs && runningBuild && sameBuild(runningBuild, cmp.current.buildId)) {
    return {
      name,
      status: "pass",
      detail: `this install ${running} IS build ${cmp.current.buildId}; the daemon runs from the versions dir (${cmp.current.entry})`,
    };
  }
  if (!cmp.current) {
    return { name, status: "pass", detail: `this install (${running}); no self-update has happened (no versions/current.json)` };
  }
  if (!cmp.current.installed) {
    return {
      name,
      status: "warn",
      detail: `versions/current.json names build ${cmp.current.buildId}, but ${cmp.current.entry} is not installed; running ${running}`,
      remedy: "A pruned or half-removed install. `worker start` runs this install; the next update rewrites the pointer.",
    };
  }
  if (!cmp.differs) {
    return { name, status: "pass", detail: `this install IS the current build ${cmp.current.buildId} (${running})` };
  }
  return {
    name,
    status: "warn",
    detail: `global/this install ${running} is NOT the current build ${cmp.current.buildId} (${cmp.current.entry})`,
    remedy: "`agentic-kanban-worker start ...` delegates to the current build automatically; pass --no-delegate to force this one.",
  };
}
