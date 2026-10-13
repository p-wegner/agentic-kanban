// #1429 — "will this project's sessions run on a worker?", asked BEFORE a session exists.
//
// A remote session installs its own dependencies on the worker (worker/worker-repo.ts), so a
// host-side `setup_script` / `pnpm install -r` for such a workspace is pure waste. Placement
// itself cannot be asked early: `resolveWorkerPlacement` reserves a worker slot, so calling it
// at provision time would claim capacity twice. What CAN be known without reserving is the
// strict case — worker dispatch on AND `worker_dispatch_strict` on means the host is never a
// fallback, so every launch is remote or refused. Non-strict projects may still land on the
// host, so they keep today's behaviour (install on the host).
import type { Database } from "../db/index.js";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { getPreferenceValue } from "../repositories/session-lifecycle.repository.js";
import type { LatestSetupRun } from "./workspace-run-records.js";
import { skippedSetupRun } from "./workspace-run-records.js";

const dispatchPref = projectPref("worker_dispatch");
const strictPref = projectPref("worker_dispatch_strict");

/** What the workspace's setup status shows when the install is left to the worker. */
export const DEPS_ON_WORKER_LABEL = "deps: on worker";

/** True when the project can only ever run its sessions on a worker (dispatch + strict). */
export async function projectDepsLiveOnWorker(projectId: string, database: Database): Promise<boolean> {
  try {
    if ((await getPreferenceValue(dispatchPref.key(projectId), database)) !== "true") return false;
    return (await getPreferenceValue(strictPref.key(projectId), database)) === "true";
  } catch {
    // Unknown = behave as today: the host install is wasteful but never wrong.
    return false;
  }
}

/** The setup record for a workspace whose install was deliberately not run on the host. */
export function depsOnWorkerSetupRun(command: string | null): LatestSetupRun {
  return { ...skippedSetupRun(command), stdoutTail: DEPS_ON_WORKER_LABEL };
}
