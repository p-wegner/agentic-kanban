import { workspaces, issues, preferences } from "@agentic-kanban/shared/schema";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { preferenceKeyValueColumns } from "./projections.js";

const trainMaxSizePref = projectPref("train_max_size");

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
