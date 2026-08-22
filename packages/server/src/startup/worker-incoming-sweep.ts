// Startup recovery for remote-worker results (epic #184, phase 3 #189).
//
// A worker may push to `refs/kanban/incoming/<branch>` while the board is down
// (or in the window between its push and the board's sync). Nothing else would
// ever look at that ref: the session row is finalized by the stale-session
// sweep, so the work would sit in the staging namespace invisibly. This sweep
// runs once at startup, lands every incoming ref that can be fast-forwarded,
// and reports the ones that cannot instead of forcing them.
//
// LANDING IS BOUND TO AN ASSIGNMENT (#246). The first cut landed ANY ref under
// the incoming namespace in ANY project, so a worker (or anyone holding the
// then-board-wide git token) could push a commit descending from `main`, wait for
// a board restart, and have it fast-forwarded onto `refs/heads/main` with no
// review, no session and no human. Fast-forward-only is no defence there — the
// attacker authors the descendant. A ref is now landed only when the DB holds a
// matching assignment for that project and branch (`sessions.workerId` +
// `workspaces.branch`); unmatched refs are HELD and reported, and left in the
// staging namespace so a real one can still be recovered by hand.
//
// THE MATCH IS NOW TIME-BOUND TOO (#753). "The DB holds a matching assignment"
// was read as "any session ever stamped with a workerId for this branch" — no
// status, no recency, no worker identity. That is not a bound: a branch that has
// EVER been dispatched stays landable forever, so a token holder could force-push
// a descendant of master hours after review and merge finished (or after the
// `ak-<N>` branch name had been recycled onto a different issue) and have the
// next board restart fast-forward it. The predicate is now the NEWEST dispatch
// for that branch, and only while it is still current — running, or ended within
// `WORKER_RESULT_LANDABLE_AFTER_END_MS`. Everything else is HELD, and an operator
// can still land it deliberately via `POST /api/workers/incoming/land`, which
// keeps the looser "was ever dispatched" gate on purpose: a human choosing one
// ref is a different act from a startup pass landing whatever it finds.

import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { projects } from "@agentic-kanban/shared/schema";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { KANBAN_INCOMING_REF_PREFIX } from "../services/git-http.service.js";
import {
  listLandableWorkerBranches,
  WORKER_RESULT_LANDABLE_AFTER_END_MS,
} from "../repositories/worker.repository.js";
import { syncIncomingBranch, clearIncomingRef } from "../services/worker-remote-sync.service.js";
import { reclaimLandedIncomingRefs, INCOMING_REF_STALE_AFTER_MS } from "../services/worker-incoming-refs.service.js";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

/** #592 — the shared pass core, plus the outcome lists only this pass has. */
export interface IncomingSweepResult extends PassReport {
  landed: string[];
  held: Array<{ branch: string; reason: string }>;
}

async function listIncomingBranches(repoPath: string): Promise<string[]> {
  const result = await gitExec(["for-each-ref", "--format=%(refname)", KANBAN_INCOMING_REF_PREFIX], { cwd: repoPath });
  if (!execSucceeded(result)) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(KANBAN_INCOMING_REF_PREFIX))
    .map((ref) => ref.slice(KANBAN_INCOMING_REF_PREFIX.length))
    .filter(Boolean);
}

/** Land any worker pushes that arrived while this board was not listening. */
export async function sweepIncomingWorkerRefs(database: Database = realDb): Promise<IncomingSweepResult> {
  const result: IncomingSweepResult = { ...emptyPassReport(), landed: [], held: [] };
  let rows: Array<{ id: string; repoPath: string | null }>;
  try {
    rows = await database.select({ id: projects.id, repoPath: projects.repoPath }).from(projects);
  } catch (err) {
    console.error("[worker-sweep] could not list projects:", err);
    return result;
  }

  for (const project of rows) {
    if (!project.repoPath) continue;
    let branches: string[];
    try {
      branches = await listIncomingBranches(project.repoPath);
    } catch {
      continue; // not a repo / unreadable — nothing to recover
    }
    if (branches.length === 0) continue;
    result.scanned += branches.length;
    let assigned: Set<string>;
    try {
      assigned = await listLandableWorkerBranches(project.id, database);
    } catch (err) {
      console.error(`[worker-sweep] could not read worker assignments for project ${project.id}:`, err);
      // Fail CLOSED: with no assignment record we cannot tell a worker's result
      // from an injected ref, so nothing lands.
      for (const branch of branches) {
        result.held.push({ branch, reason: "assignment lookup failed" });
        recordSkipped(result, branch, "assignment lookup failed");
      }
      continue;
    }
    for (const branch of branches) {
      if (!assigned.has(branch)) {
        const reason = "no current worker assignment for this branch";
        result.held.push({ branch, reason });
        recordSkipped(result, branch, reason);
        console.warn(
          `[worker-sweep] refusing to land ${branch} in project ${project.id}: ` +
          `its newest fleet dispatch is not current (no session dispatched to a worker for that branch, ` +
          `or the newest one ended more than ${Math.round(WORKER_RESULT_LANDABLE_AFTER_END_MS / 60_000)} min ago). ` +
          `Land it deliberately with POST /api/workers/incoming/land if it is genuinely yours (#753).`,
        );
        continue;
      }
      // `syncIncomingBranch` falls through to a `merge --ff-only` in the worktree that
      // holds the branch (#743). Before it did, this sweep could recover only refs whose
      // workspace had already been torn down — a live workspace holds its branch, which
      // is the normal case, so "restart recovery" recovered almost nothing.
      const sync = await syncIncomingBranch(project.repoPath, branch);
      if (sync.ok) {
        result.landed.push(branch);
        recordActed(result, branch, "landed");
        await clearIncomingRef(project.repoPath, branch).catch(() => {});
        console.log(`[worker-sweep] recovered worker push for ${branch} via ${sync.via} (${sync.status})`);
      } else {
        result.held.push({ branch, reason: sync.error });
        recordSkipped(result, branch, "sync failed");
        console.warn(`[worker-sweep] could not land worker push for ${branch}: ${sync.error}`);
      }
    }
  }
  // #752: the held list stops here being a value the caller drops. The retention pass
  // clears refs whose commits are provably on a branch already, and everything still
  // held is named with its age — which is what makes decision 012's "reported and held"
  // true rather than half true. Nothing unreachable is deleted at any age; that needs an
  // explicit `discardIncomingRef`. `GET /api/workers/incoming` serves the same view live.
  try {
    const reclaim = await reclaimLandedIncomingRefs(database);
    for (const dropped of reclaim.reclaimed) {
      console.log(`[worker-sweep] reclaimed stale incoming ref ${dropped.branch} (${dropped.reason})`);
    }
    for (const stuck of reclaim.held) {
      const days = Math.round(stuck.ageMs / 86_400_000);
      console.warn(
        `[worker-sweep] HELD incoming ref ${stuck.branch} in project ${stuck.projectId}: ${stuck.reason} ` +
        `(${days}d old${stuck.stale ? `, past the ${Math.round(INCOMING_REF_STALE_AFTER_MS / 86_400_000)}d retention flag` : ""}). ` +
        `See GET /api/workers/incoming to land or discard it.`,
      );
    }
  } catch (err) {
    console.error("[worker-sweep] incoming-ref retention pass failed:", err);
  }
  // #689: the report body names the unaccounted remainder — a branch whose sync threw
  // outside the per-branch handling above would otherwise vanish between "landed" and
  // "held". Tag stays a literal first argument (#616).
  //
  // UNCONDITIONAL (#718). This used to be guarded by `landed.length > 0 || held.length > 0`,
  // which suppressed the line in exactly the case the comment above describes: a branch that
  // was scanned and then threw is in neither list, so the one run whose remainder needed
  // naming was the one that printed nothing. `PassReport` exists because "a pass that found
  // nothing is indistinguishable from one that reported nothing" — a `scanned 0` line is the
  // report, not noise.
  console.log(`[worker-sweep] ${formatPassReportBody(result)}`);
  return result;
}
