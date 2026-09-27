import { workspaces, issues, preferences } from "@agentic-kanban/shared/schema";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { preferenceKeyValueColumns } from "./projections.js";

const trainMaxSizePref = projectPref("train_max_size");

/**
 * The queue-pressure signal's input (#1246): ready-for-merge, idle, non-fork workspaces for
 * one project, with the timestamp they became ready (`updatedAt`, the same field
 * `resolvePendingMembers` in `merge-queue.ts` reads for `readySince`). Deliberately a simpler
 * read than the auto-merge orchestrator's own candidate query — it does not need the join
 * status name filter, since `readyForMerge` alone is what "waiting in the queue" means for a
 * pressure READING (unlike the orchestrator, which also accepts an un-flagged "In Review"/"AI
 * Reviewed" workspace as a merge candidate under `auto_merge_in_review`).
 */
export async function getQueuePressureMemberRows(
  projectId: string,
  database: Database = db,
): Promise<{ workspaceId: string; readySince: string; issueNumber: number | null; title: string | null }[]> {
  const rows = await database
    .select({ workspaceId: workspaces.id, updatedAt: workspaces.updatedAt, issueNumber: issues.issueNumber, title: issues.title })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(
      eq(issues.projectId, projectId),
      ne(workspaces.status, "closed"),
      eq(workspaces.isDirect, false),
      eq(workspaces.readyForMerge, true),
      eq(workspaces.status, "idle"),
    ));
  // The ticket ref rides along (same join, no extra query) for the Delivery panel's waiting list.
  return rows.map((row) => ({ workspaceId: row.workspaceId, readySince: row.updatedAt, issueNumber: row.issueNumber ?? null, title: row.title ?? null }));
}

export async function getMergeQueueWorkspaceRows(
  workspaceIds: string[],
  database: Database = db,
) {
  return database
    .select()
    .from(workspaces)
    .where(inArray(workspaces.id, workspaceIds));
}

export async function getMergeQueueIssueRows(
  issueIds: string[],
  database: Database = db,
) {
  return database
    .select()
    .from(issues)
    .where(inArray(issues.id, issueIds));
}

export async function getWorkspaceStatus(
  workspaceId: string,
  database: Database = db,
): Promise<string | undefined> {
  const [current] = await database
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return current?.status;
}

/**
 * The durable merge outcome of one workspace.
 *
 * `mergedHeadSha` is here for #990: it is the branch tip captured at merge time and it
 * SURVIVES the post-merge branch deletion, so it is the one field that lets a caller
 * confirm a merge landed without consulting git. `mergedAt` alone says "it landed";
 * the sha says *what* landed.
 */
export async function getWorkspaceMergeState(
  workspaceId: string,
  database: Database = db,
): Promise<{ status: string; mergedAt: string | null; mergedHeadSha: string | null } | undefined> {
  const [row] = await database
    .select({
      status: workspaces.status,
      mergedAt: workspaces.mergedAt,
      mergedHeadSha: workspaces.mergedHeadSha,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row;
}

/**
 * `train_max_size_<projectId>` (#904) — the opt-in cap `executeQueue` reads to decide whether
 * an eligible independent batch defaults to the train strategy (`> 1` opts in). Returns the
 * raw string; the service parses it, matching how `getWipLimitPrefMap`/`resolveWaveWipLimit`
 * split the read (repository) from the interpretation (service).
 */
export async function getMergeTrainMaxSizePref(
  projectId: string,
  database: Database = db,
): Promise<string | undefined> {
  const rows = await database
    .select(preferenceKeyValueColumns)
    .from(preferences)
    .where(inArray(preferences.key, [trainMaxSizePref.key(projectId)]));
  return rows.find((r) => r.key === trainMaxSizePref.key(projectId))?.value;
}
