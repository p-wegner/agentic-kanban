/**
 * Reconcile an issue whose WORKFLOW NODE and whose STATUS disagree (#395, #397).
 *
 * #381 fixed the BACKWARDS direction — an issue moved backwards out of the workflow's status set
 * kept rendering in the stale node's column — by clearing the node on that move. Two other
 * directions were left, and both are worse than a rendering bug.
 *
 * ── #395: the node is at an `end` node while the status is not terminal ──
 *
 * MEASURED on eventhub: eight issues (#79, #84, #89, #91, #92, #95, #97, #98) had
 * `current_node_id` pointing at a `node_type = 'end'` / `status_name = 'Done'` node while
 * `status_id` still resolved to **In Review**. Every `status_changed_at` predated #381's commit,
 * so this is not a regression of it — it is the direction it did not touch. Control: the dev board
 * measured 0 divergence over 67 issues in the same sweep.
 *
 * The consequence is not cosmetic. The monitor's candidate query excluded an issue whose node is
 * an `end` node **regardless of its status or its workspaces**, so those issues left automation
 * entirely. That explains an observation #387 recorded as unverified: two `ready_for_merge`
 * In-Review workspaces had not merged in ~1000 minutes with `auto_merge=true` and cycles running.
 * #387 guessed at the Windows `./gradlew` verify script or the per-project time budget; neither
 * was the cause. Both issues sat on an `end` node, so their workspaces were never candidates and
 * the merge code never ran on them at all.
 *
 * ── #397: the node regressed BACKWARDS to the start node after the work landed ──
 *
 * Observed naturally on roomsync round 14. Issue #7 completed, its artifact merged to master, its
 * gate was approved; workspace `closed`, both sessions `completed`. Yet it sat **In Progress** on
 * the "Analyze" (`node_type = start`) node, with `status_changed_at` seven minutes AFTER the
 * workspace closed and within five seconds of the loop planning the NEXT unit. It was not left
 * behind — it was actively moved backwards after finishing. Its neighbour, which took the
 * identical path, sits correctly on the Done/end node.
 *
 * Nothing recovered it: the workspace is closed, so no monitor candidate exists, and no
 * reconciler moves an issue off a start node. The loop's `openTickets` then read 2 with one unit
 * genuinely in flight — a phantom open ticket, which is exactly the state that can stall a later
 * advance.
 *
 * ── The resolution rule ──
 *
 * Which source wins is decided by the WORK, not by the node type:
 *
 * | state | winner | why |
 * |---|---|---|
 * | merged workspace, nothing live | the merge | the work is on the base branch; the issue is finished whatever the node says (#397) |
 * | `end` node, live workspace | the status | there is committed work that never landed, so "the workflow says done" must not silently override it (#395) |
 *
 * Clearing the node rather than advancing the status is the #381-shaped repair and is recoverable:
 * moving the issue to a status the template covers re-points the node on the next sync. It also
 * un-hides the issue from the monitor walk, which is the half that actually costs work.
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { issues, projectStatuses, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { reconcileMergedIssue } from "../services/merge-cleanup.service.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const TERMINAL_ISSUE_STATUSES = ["Done", "Cancelled"];

export type NodeDivergenceAction = "clear-node" | "converge-done" | "none";

export interface NodeDivergenceRow {
  issueId: string;
  issueNumber: number | null;
  projectId: string;
  issueStatusName: string;
  nodeType: string | null;
  nodeStatusName: string | null;
  hasLiveWorkspace: boolean;
  hasMergedWorkspace: boolean;
}

/** Pure resolution rule — see the table above. */
export function decideNodeDivergence(row: NodeDivergenceRow): { action: NodeDivergenceAction; reason: string } {
  if (TERMINAL_ISSUE_STATUSES.includes(row.issueStatusName)) {
    return { action: "none", reason: "issue is already terminal" };
  }
  if (row.hasMergedWorkspace && !row.hasLiveWorkspace) {
    return {
      action: "converge-done",
      reason: `work merged and no live workspace remains, but the issue is "${row.issueStatusName}"`
        + (row.nodeType === "start" ? " on the workflow's START node (#397)" : ""),
    };
  }
  if (row.nodeType === "end" && row.hasLiveWorkspace) {
    return {
      action: "clear-node",
      reason: `node is an END node ("${row.nodeStatusName ?? "?"}") while the issue is "${row.issueStatusName}" `
        + `and still owns a live workspace — the node was hiding committed work from the monitor walk (#395)`,
    };
  }
  return { action: "none", reason: "node and status do not disagree in a way that strands work" };
}

/** Issues whose node/status pair is worth examining. Cheap: one query, no git. */
export async function listNodeDivergences(database: Database = db): Promise<NodeDivergenceRow[]> {
  // The EXISTS columns come back as SQLite 0/1, not booleans. Coerced on the way out so the
  // decision rule below is genuinely boolean and a caller cannot be surprised by `=== true`.
  const rows = await database
    .select({
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
      issueStatusName: projectStatuses.name,
      nodeType: workflowNodes.nodeType,
      nodeStatusName: workflowNodes.statusName,
      hasLiveWorkspace: sql<boolean>`EXISTS (
        SELECT 1 FROM ${workspaces} AS live
        WHERE live.issue_id = ${issues.id} AND live.status != 'closed'
      )`,
      hasMergedWorkspace: sql<boolean>`EXISTS (
        SELECT 1 FROM ${workspaces} AS landed
        WHERE landed.issue_id = ${issues.id} AND landed.merged_at IS NOT NULL
      )`,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(and(
      isNotNull(issues.currentNodeId),
      // Terminal issues are excluded in SQL as well as in the rule — they are the bulk of any
      // board, and there is nothing to reconcile on them.
      ne(projectStatuses.name, "Done"),
      ne(projectStatuses.name, "Cancelled"),
    ));
  return rows.map((row) => ({
    ...row,
    hasLiveWorkspace: Boolean(row.hasLiveWorkspace),
    hasMergedWorkspace: Boolean(row.hasMergedWorkspace),
  }));
}

export interface NodeDivergenceSweepResult {
  checked: number;
  clearedNodes: string[];
  convergedToDone: string[];
}

export async function reconcileWorkflowNodeDivergence(
  opts: { database?: Database; now?: string; log?: (message: string) => void } = {},
): Promise<NodeDivergenceSweepResult> {
  const database = opts.database ?? db;
  const now = opts.now ?? new Date().toISOString();
  const log = opts.log ?? ((message: string) => console.log(`[node-divergence] ${message}`));
  const rows = await listNodeDivergences(database).catch(() => [] as NodeDivergenceRow[]);
  const result: NodeDivergenceSweepResult = { checked: rows.length, clearedNodes: [], convergedToDone: [] };

  for (const row of rows) {
    const { action, reason } = decideNodeDivergence(row);
    if (action === "none") continue;
    const ref = `issue #${row.issueNumber ?? "?"} (${row.issueId})`;
    try {
      if (action === "clear-node") {
        await database.update(issues).set({ currentNodeId: null }).where(eq(issues.id, row.issueId));
        // The board's column override reads `workspaces.current_node_id`, so a node cleared only
        // on the issue would keep rendering in the stale column — the exact #381 symptom.
        await database.update(workspaces).set({ currentNodeId: null })
          .where(and(eq(workspaces.issueId, row.issueId), sql`${workspaces.status} != 'closed'`));
        result.clearedNodes.push(row.issueId);
        log(`cleared the workflow node of ${ref} — ${reason}`);
        continue;
      }
      await reconcileMergedIssue({ database, issueId: row.issueId, now, projectId: row.projectId });
      result.convergedToDone.push(row.issueId);
      log(`converged ${ref} to Done — ${reason}`);
    } catch (err) {
      log(`failed to reconcile ${ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startWorkflowNodeDivergenceReconciler(opts: { intervalMs?: number } = {}): void {
  if (timer) return;
  timer = setInterval(() => {
    void reconcileWorkflowNodeDivergence().catch((err) => {
      console.warn("[node-divergence] sweep failed (non-fatal):", err instanceof Error ? err.message : String(err));
    });
  }, opts.intervalMs ?? SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopWorkflowNodeDivergenceReconciler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
