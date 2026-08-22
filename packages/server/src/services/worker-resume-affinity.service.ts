// Which worker a RESUMED session should go back to (#750 item 4).
//
// A resume carries `--resume <providerSessionId>`, and both things that makes meaningful
// live on ONE machine: the provider transcript in that worker's own agent config dir
// (credentials never leave their machine — decision 012), and the git checkout in its
// `checkouts/<sessionId>`. Placement, however, was least-loaded-first with no memory of
// the previous dispatch, so a resume could be handed to a worker that holds neither half
// and would fail with "no conversation found" — classified as a launch failure, which is
// the least informative shape that failure could take.
//
// This is a PREFERENCE, not a hold. It is applied to the candidate list placement has
// already filtered (so #751's capacity reservations still bind), and a holder with no free
// slot falls through to the normal choice with a warning. Refusing placement outright would
// trade a probably-failing resume for a definitely-blocked one, and the board cannot know
// that the transcript is still there anyway — a worker's disk is not the board's to assert
// about (the same reason `remote-session-liveness` has an `unknown`).

import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { listWorkerBranchAssignments } from "../repositories/worker.repository.js";

/**
 * The worker that ran this branch most recently, or null when the board has no record of
 * a fleet dispatch for it (a branch that has only ever been built on the host, or a first
 * run).
 *
 * NEWEST dispatch, not any: a relaunch leaves older ended rows behind, and it is the last
 * machine that holds the transcript the resume names.
 *
 * Deliberately NOT gated on `isWorkerAssignmentCurrent`: that predicate bounds a worker's
 * authority to PUSH (#753) and expires an hour after a session ends, whereas the checkout
 * and transcript a resume wants stay on that machine until its work root is cleaned. The
 * two questions have different answers on purpose.
 */
export async function resolveResumeWorkerAffinity(
  params: { projectId: string; branch: string },
  database: Database = db,
): Promise<string | null> {
  try {
    // Sorted newest-started-first by the repository.
    const assignments = await listWorkerBranchAssignments(params.projectId, database);
    return assignments.find((a) => a.branch === params.branch)?.workerId ?? null;
  } catch (err) {
    // An affinity hint is never worth failing a launch for.
    console.warn(`[worker-fleet] could not resolve resume affinity for ${params.branch}`, err);
    return null;
  }
}
