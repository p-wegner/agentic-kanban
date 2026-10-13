// Where a merge-train staging gate's INSTALL runs (#1440). With `verify_placement` sending the
// train gate to a worker, the worker installs (the verify job carries the project's setup script)
// and verifies the staged train branch it fetches from the board's git transport; the host keeps
// only the git plumbing (the merge, the staging worktree checkout). Running `pnpm install` in the
// host worktree as well would be exactly the host-side compute #1440 removes.
import type { Database } from "../db/index.js";
import { planVerifyPlacement } from "./verify-job-placement.js";

/** The worker name when the staging gate (install + verify) will run on a worker, else null. */
export async function trainGateWorkerName(projectId: string, database: Database, attemptLabel: string): Promise<string | null> {
  const plan = await planVerifyPlacement({ kind: "train-gate", projectId, database }).catch(() => null);
  if (plan?.target !== "worker") return null;
  console.log(`[merge-train] ${attemptLabel}: staging gate (install + verify) runs on worker ${plan.workerName}; no host install`);
  return plan.workerName;
}
