/**
 * The `issues` reads the base-health **heal ticket** needs (#1016).
 *
 * Inside the `issues` owning subtree (#822: ownership is a SUBTREE, not a filename — see
 * `repository-table-ownership.test.ts`), so the heal-ticket reconciler never queries the table
 * itself, which is both that ratchet's rule and `pnpm lint:arch`'s `services-bypass-repositories`.
 * A separate file rather than two more functions on `issue-service.repository.ts`, which is
 * already at the god-module gate's ceiling (#889).
 *
 * Both queries exist because the heal ticket is identified by a MACHINE KEY, not by its title:
 * a heal title carries the current failing-suite count and changes on every sweep.
 */

import { issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import { firstRow } from "../../lib/first-row.js";
import { issueTextColumns } from "../projections.js";

export interface IssueByExternalKeyRow {
  id: string;
  issueNumber: number | null;
  title: string;
  description: string | null;
  statusId: string;
  statusName: string | null;
  sortOrder: number;
  createdAt: string;
  /** The key the row was found by — a prefix scan needs it back to tell signatures apart (#1233). */
  externalKey: string | null;
}

/**
 * Every issue in this project carrying `externalKey`, newest first, with its status NAME joined
 * in so a caller can tell an open one from a closed one.
 *
 * A cross-aggregate JOIN read, deliberately: enriching an `issues` query with the status name is
 * one query, not a mirror of `project_statuses`.
 */
export async function listIssuesByExternalKey(
  projectId: string,
  externalKey: string,
  database: Database = db,
): Promise<IssueByExternalKeyRow[]> {
  return database
    .select({
      ...issueTextColumns,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      sortOrder: issues.sortOrder,
      createdAt: issues.createdAt,
      externalKey: issues.externalKey,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(eq(issues.projectId, projectId), eq(issues.externalKey, externalKey)))
    .orderBy(desc(issues.createdAt));
}

/**
 * Every issue in this project whose `externalKey` STARTS WITH `prefix`, newest first — the
 * "all heal tickets of this project" read (#1233: one key per failure signature, so an exact
 * match can no longer enumerate them). `prefix` is a literal, not a LIKE pattern: `%` and `_`
 * in it are escaped, so a caller cannot widen the scan by accident.
 */
export async function listIssuesByExternalKeyPrefix(
  projectId: string,
  prefix: string,
  database: Database = db,
): Promise<IssueByExternalKeyRow[]> {
  const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return database
    .select({
      ...issueTextColumns,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      sortOrder: issues.sortOrder,
      createdAt: issues.createdAt,
      externalKey: issues.externalKey,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(eq(issues.projectId, projectId), sql`${issues.externalKey} LIKE ${pattern} ESCAPE '\\'`))
    .orderBy(desc(issues.createdAt));
}

/**
 * The smallest `sort_order` any issue in this project holds, or null for an empty project.
 *
 * "Top of the backlog" is `min - 1`: the board renders columns `.orderBy(issues.sortOrder)`
 * ascending, so lower is higher. Deliberately NOT a WIP exemption — none exists, and #1016 does
 * not invent one; a heal ticket outranks the rest of the backlog and then waits its turn like
 * anything else.
 */
export async function getMinIssueSortOrder(
  projectId: string,
  database: Database = db,
): Promise<number | null> {
  const row = await firstRow(
    database
      .select({ min: sql<number | null>`min(${issues.sortOrder})` })
      .from(issues)
      .where(eq(issues.projectId, projectId))
  );
  return row?.min ?? null;
}
