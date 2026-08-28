/**
 * The TOUCHED-FILES read model: `issues.touched_files_json`, the cached prediction of
 * which paths an issue will change.
 *
 * One column, four readers, and they are here together because every one of them exists
 * to answer the same question — "which issues overlap on files?" — just at different
 * scopes: one issue, one issue plus its project, a whole project, or a named set of
 * issue numbers. The overlap ARITHMETIC is deliberately not here; the related-issues
 * route and the CLI's `issue check-overlap` each build their own scoring from these rows.
 *
 * Kept out of the main repository because the column is a CACHE, not part of an issue's
 * identity: it is written by the prediction path and may be null or stale for any row,
 * so a reader has to handle absence — a rule that would be invisible if these four sat
 * among the ordinary issue reads.
 */

import { issues } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import { issueIdentityColumns } from "../projections.js";
import { firstRow } from "../../lib/first-row.js";

/** The cached touched-files prediction JSON for one issue, or null when the issue is absent. */
export async function getIssueTouchedFiles(
  issueId: string,
  database: Database = db,
): Promise<{ touchedFilesJson: string | null } | null> {
  return firstRow(
    database
      .select({ touchedFilesJson: issues.touchedFilesJson })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

/** Touched-files JSON + projectId for one issue (related-issues lookup), or null when absent. */
export async function getIssueTouchedFilesWithProject(
  issueId: string,
  database: Database = db,
): Promise<{ touchedFilesJson: string | null; projectId: string } | null> {
  return firstRow(
    database
      .select({ touchedFilesJson: issues.touchedFilesJson, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

/** All issues in a project with their touched-files JSON (related-issues file-overlap scan). */
export async function getProjectIssuesTouchedFiles(projectId: string, database: Database = db) {
  return database
    .select({
      ...issueIdentityColumns,
      touchedFilesJson: issues.touchedFilesJson,
    })
    .from(issues)
    .where(eq(issues.projectId, projectId));
}

/**
 * Same as {@link getProjectIssuesTouchedFiles} plus `statusId` (#918) — the touched-files
 * ticket-group seed needs to restrict candidates to Backlog/Todo, which the identity
 * projection alone cannot express.
 */
export async function getProjectIssuesTouchedFilesWithStatus(projectId: string, database: Database = db) {
  return database
    .select({
      ...issueIdentityColumns,
      statusId: issues.statusId,
      touchedFilesJson: issues.touchedFilesJson,
    })
    .from(issues)
    .where(eq(issues.projectId, projectId));
}

/**
 * id + issueNumber + touchedFilesJson for a set of issue numbers in a project
 * (CLI `issue check-overlap`). The found-set + overlap-building stays in the CLI.
 */
export async function getIssuesTouchedFilesByNumbers(
  projectId: string,
  issueNumbers: number[],
  database: Database = db,
) {
  return database
    .select({ id: issues.id, issueNumber: issues.issueNumber, touchedFilesJson: issues.touchedFilesJson })
    .from(issues)
    .where(and(inArray(issues.issueNumber, issueNumbers), eq(issues.projectId, projectId)));
}
