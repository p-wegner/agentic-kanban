import { eq } from "drizzle-orm";
import { issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
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

export async function persistScorecard(
  workspaceId: string,
  values: { scorecardScore: number; scorecardJson: string; scorecardComputedAt: string },
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));
}

export async function getScorecardColumns(workspaceId: string, database: Database = db) {
  return firstRow(
    database
      .select({
        scorecardScore: workspaces.scorecardScore,
        scorecardJson: workspaces.scorecardJson,
        scorecardComputedAt: workspaces.scorecardComputedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
  );
}
