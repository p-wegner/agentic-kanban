// #1346 — `worker doctor`'s "which build is this" check. Its own module: worker-doctor.ts sits at
// the god-module gate's declaration ceiling (#889).
import { compareBuilds } from "../../worker/worker-delegate.js";
import type { DoctorCheck } from "./worker-doctor.js";

/**
 * Global vs current build. WARN (never fail) when `current.json` names a different installed
 * build: `worker start` delegates to it by default, so the machine is healthy — the operator
 * just ought to know which build actually runs.
 */
export function checkWorkerBuild(stateFile: string, runningEntry: string | null): DoctorCheck {
  const name = "worker build";
  const cmp = compareBuilds(stateFile, runningEntry);
  const running = runningEntry ?? "unknown";
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
    remedy: "`agentic-kanban-worker start …` delegates to the current build automatically; pass --no-delegate to force this one.",
  };
}
