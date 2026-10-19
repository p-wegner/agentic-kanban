import { eq, inArray } from "drizzle-orm";
import { issues } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

export async function getIssueForTouchedFiles(
  issueId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        projectId: issues.projectId,
        touchedFilesJson: issues.touchedFilesJson,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

export async function updateIssueTouchedFiles(
  issueId: string,
  touchedFilesJson: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(issues)
    .set({ touchedFilesJson })
    .where(eq(issues.id, issueId));
}

export async function getIssuesTouchedFiles(
  issueIds: string[],
  database: Database = db,
) {
  return database
    .select({ id: issues.id, touchedFilesJson: issues.touchedFilesJson })
    .from(issues)
    .where(inArray(issues.id, issueIds));
}
