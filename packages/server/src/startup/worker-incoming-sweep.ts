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

import { emptyPassReport, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { projects } from "@agentic-kanban/shared/schema";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { KANBAN_INCOMING_REF_PREFIX } from "../services/git-http.service.js";
import { listWorkerAssignedBranches } from "../repositories/worker.repository.js";
import { syncIncomingBranch, clearIncomingRef } from "../services/worker-remote-sync.service.js";

/** #592 — the shared pass core, plus the outcome lists only this pass has. */
export interface IncomingSweepResult extends PassReport {
  landed: string[];
  held: Array<{ branch: string; reason: string }>;
}

async function listIncomingBranches(repoPath: string): Promise<string[]> {
  const result = await gitExec(["for-each-ref", "--format=%(refname)", KANBAN_INCOMING_REF_PREFIX], { cwd: repoPath });
  if (result.code !== 0) return [];
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
      assigned = await listWorkerAssignedBranches(project.id, database);
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
        result.held.push({ branch, reason: "no worker assignment for this branch" });
        recordSkipped(result, branch, "no worker assignment for this branch");
        console.warn(
          `[worker-sweep] refusing to land ${branch} in project ${project.id}: ` +
          `no session was ever dispatched to a worker for that branch`,
        );
        continue;
      }
      const sync = await syncIncomingBranch(project.repoPath, branch);
      if (sync.ok) {
        result.landed.push(branch);
        recordActed(result, branch, "landed");
        await clearIncomingRef(project.repoPath, branch).catch(() => {});
        console.log(`[worker-sweep] recovered worker push for ${branch} (${sync.status})`);
      } else {
        result.held.push({ branch, reason: sync.error });
        recordSkipped(result, branch, "sync failed");
        console.warn(`[worker-sweep] could not land worker push for ${branch}: ${sync.error}`);
      }
    }
  }
  if (result.landed.length > 0 || result.held.length > 0) {
    console.log(`[worker-sweep] incoming refs: ${result.landed.length} landed, ${result.held.length} held`);
  }
  return result;
}
