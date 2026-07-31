// Startup recovery for remote-worker results (epic #184, phase 3 #189).
//
// A worker may push to `refs/kanban/incoming/<branch>` while the board is down
// (or in the window between its push and the board's sync). Nothing else would
// ever look at that ref: the session row is finalized by the stale-session
// sweep, so the work would sit in the staging namespace invisibly. This sweep
// runs once at startup, lands every incoming ref that can be fast-forwarded,
// and reports the ones that cannot instead of forcing them.

import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { projects } from "@agentic-kanban/shared/schema";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { KANBAN_INCOMING_REF_PREFIX } from "../services/git-http.service.js";
import { syncIncomingBranch, clearIncomingRef } from "../services/worker-remote-sync.service.js";

export interface IncomingSweepResult {
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
  const result: IncomingSweepResult = { landed: [], held: [] };
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
    for (const branch of branches) {
      const sync = await syncIncomingBranch(project.repoPath, branch);
      if (sync.ok) {
        result.landed.push(branch);
        await clearIncomingRef(project.repoPath, branch).catch(() => {});
        console.log(`[worker-sweep] recovered worker push for ${branch} (${sync.status})`);
      } else {
        result.held.push({ branch, reason: sync.error });
        console.warn(`[worker-sweep] could not land worker push for ${branch}: ${sync.error}`);
      }
    }
  }
  if (result.landed.length > 0 || result.held.length > 0) {
    console.log(`[worker-sweep] incoming refs: ${result.landed.length} landed, ${result.held.length} held`);
  }
  return result;
}
