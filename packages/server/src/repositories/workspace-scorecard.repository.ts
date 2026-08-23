import { eq } from "drizzle-orm";
import { issues, sessions, workspaceScorecard } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

export async function getScorecardIssue(issueId: string, database: Database = db) {
  return firstRow(
    database
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

export async function getScorecardReviewSessions(workspaceId: string, database: Database = db) {
  return database
    .select({ id: sessions.id, exitCode: sessions.exitCode, triggerType: sessions.triggerType })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
}

/**
 * Record the computed scorecard for a workspace, replacing whatever was stored before.
 *
 * #815: the three `scorecard_*` columns moved off `workspaces` into `workspace_scorecard`, and
 * this file — already the family's owner — writes the new table instead. UPSERT rather than
 * update: the row does not exist until the first scoring run, so an UPDATE would silently
 * no-op for every workspace being scored for the FIRST time, which is the common case.
 */
export async function persistScorecard(
  workspaceId: string,
  values: { scorecardScore: number; scorecardJson: string; scorecardComputedAt: string },
  database: Database | TransactionClient = db,
): Promise<void> {
  const row = {
    score: values.scorecardScore,
    json: values.scorecardJson,
    computedAt: values.scorecardComputedAt,
  };
  await database.insert(workspaceScorecard).values({ workspaceId, ...row })
    .onConflictDoUpdate({ target: workspaceScorecard.workspaceId, set: { ...row } });
}

/**
 * The stored scorecard for one workspace, aliased back to the old `scorecard*` field names so
 * `getStoredScorecard` is untouched by the move.
 *
 * Returns `null` for a workspace that has never been scored — where the pre-#815 query
 * returned a row of three NULLs. Both collapse to the same `null` at the one call site, which
 * guards `if (!ws) return null;` before it reads the fields.
 */
export async function getScorecardColumns(workspaceId: string, database: Database = db) {
  return firstRow(
    database
      .select({
        scorecardScore: workspaceScorecard.score,
        scorecardJson: workspaceScorecard.json,
        scorecardComputedAt: workspaceScorecard.computedAt,
      })
      .from(workspaceScorecard)
      .where(eq(workspaceScorecard.workspaceId, workspaceId))
      .limit(1)
  );
}
