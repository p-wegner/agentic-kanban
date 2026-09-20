import { and, eq, isNotNull, ne } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export interface HookBackfillCandidate {
  workingDir: string | null;
  tddMode: boolean | null;
}

/**
 * The persistence half of the #1214 commit-msg hook backfill: every open, non-direct workspace
 * that has a worktree on record. DIRECT workspaces are excluded here rather than in the sweep,
 * because their "worktree" is the project's main checkout, which the sweep must never install
 * into (`startup/commit-msg-hook-backfill.ts` says why).
 */
export async function listHookBackfillCandidates(
  database: Database = db,
): Promise<HookBackfillCandidate[]> {
  return database
    .select({ workingDir: workspaces.workingDir, tddMode: workspaces.tddMode })
    .from(workspaces)
    .where(and(ne(workspaces.status, "closed"), eq(workspaces.isDirect, false), isNotNull(workspaces.workingDir)));
}
