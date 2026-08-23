import { eq } from "drizzle-orm";
import { workspaceSymlinkRun } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * The one owner of dependency-symlink run persistence, over its own table (#798).
 *
 * The eight `latest_symlink_*` columns used to sit on `workspaces`. #739 counted 9 non-test
 * files; re-derived on the column names the true count is 5 — the writer
 * (`workspace-create.service.ts`), the two reads (`issue.repository.ts`,
 * `workspace-reads.repository.ts`), the projection that maps them into a DTO
 * (`lib/workspace-details-projection.ts`), and `services/issue.service.ts`, which reads them
 * off the projected ROW rather than the table. Both reads alias the new columns back to the
 * old `latestSymlink*` field names, so the projection and the DTO are unchanged and the
 * client never sees the move.
 *
 * Written once, at workspace creation, inside the same transaction as the workspace row —
 * including the `state: "disabled"` run a project with the feature off produces, because the
 * diagnostics panel distinguishes "disabled" from "pending" and the columns always carried it.
 */

/** The run record as the create path builds it (`workspace-run-records.ts`). */
export interface SymlinkRunValues {
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  dirs: string | null;
  linked: string | null;
  skipped: string | null;
  failed: string | null;
  error: string | null;
}

export async function insertWorkspaceSymlinkRun(
  workspaceId: string,
  values: SymlinkRunValues,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.insert(workspaceSymlinkRun).values({ workspaceId, ...values });
}

/** The run for one workspace, or `undefined` when none was ever recorded. */
export async function getWorkspaceSymlinkRun(
  workspaceId: string,
  database: Database = db,
): Promise<typeof workspaceSymlinkRun.$inferSelect | undefined> {
  const [row] = await database.select().from(workspaceSymlinkRun)
    .where(eq(workspaceSymlinkRun.workspaceId, workspaceId)).limit(1);
  return row;
}
