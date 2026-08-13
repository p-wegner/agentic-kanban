/**
 * Issue queries/mutations that back the `pnpm cli -- issue ...` commands
 * specifically (as opposed to the board API's own projections) — split out of
 * `issue.repository.ts` to relieve its cohesion-gate count (#465 decomposition,
 * #957 pattern: the blanket /repositories/ exemption is gone, so this facade
 * ships its OWN sub-modules rather than growing past the flat threshold).
 */
import { issues, projectStatuses, issueDependencies } from "@agentic-kanban/shared/schema";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import { isIssueNumberUniqueConstraintError, nextIssueNumber } from "../issue-number.repository.js";

type Issue = typeof issues.$inferSelect;
const ISSUE_NUMBER_INSERT_ATTEMPTS = 3;

/**
 * Lean issue list for a project (CLI `issue list`): the exact 7-field projection
 * the CLI prints/serializes, unordered (the CLI applies status/priority filters
 * in JS). A purpose-built projection — NOT getIssuesByProject — so the `--json`
 * shape and ordering stay byte-identical to the previous inline query.
 */
export async function getIssueListForProject(projectId: string, database: Database = db) {
  return database
    .select({
      issueNumber: issues.issueNumber,
      id: issues.id,
      title: issues.title,
      priority: issues.priority,
      issueType: issues.issueType,
      statusName: projectStatuses.name,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId));
}

/**
 * One issue's display header by number within a project (CLI `issue get` /
 * `issue status`), joined to its status name, or null. The 9-field projection
 * matches `issue get --json` exactly.
 */
export async function getIssueHeaderByNumber(projectId: string, issueNumber: number, database: Database = db) {
  const rows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
      priority: issues.priority,
      issueType: issues.issueType,
      statusName: projectStatuses.name,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(eq(issues.issueNumber, issueNumber), eq(issues.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve an issue by its per-project number (numeric arg + projectId) or by its
 * full id (non-numeric arg), returning the full row or null — the resolution the
 * CLI `issue update`/`move`/`summary`/`create-sub`/`delete` handlers share.
 */
export async function getIssueByNumberOrId(
  issueArg: string,
  projectId: string | undefined,
  database: Database = db,
): Promise<Issue | null> {
  const isNumeric = /^\d+$/.test(issueArg);
  const whereClause = isNumeric
    ? and(eq(issues.issueNumber, Number(issueArg)), eq(issues.projectId, projectId!))
    : eq(issues.id, issueArg);
  const rows = await database.select().from(issues).where(whereClause).limit(1);
  return rows[0] ?? null;
}

/** Issue identity + status name by issue id (CLI `session analyze` context), or null. */
export async function getIssueWithStatusById(issueId: string, database: Database = db) {
  const rows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
      priority: issues.priority,
      issueType: issues.issueType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Title + description for the first issue with this issue number (NOT project-
 * scoped — matches the CLI `session find-similar` global lookup), or null.
 */
export async function getIssueTitleDescriptionByNumber(issueNumber: number, database: Database = db) {
  const rows = await database
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.issueNumber, issueNumber))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create an issue with the next per-project issue number (MAX+1), mirroring the
 * CLI `issue create` minimal value set. The MAX read + insert are two statements
 * on the same handle (NOT a transaction) — preserving the CLI's prior behavior.
 * Deliberately does NOT go through the issue.service create path (which resolves
 * workflow templates / current node the CLI omits).
 */
export async function createIssueWithNextNumber(
  input: {
    projectId: string;
    statusId: string;
    title: string;
    description?: string | null;
    priority?: string;
    issueType?: string;
  },
  database: Database = db,
): Promise<{ id: string; issueNumber: number }> {
  for (let attempt = 1; attempt <= ISSUE_NUMBER_INSERT_ATTEMPTS; attempt++) {
    const issueNumber = await nextIssueNumber(input.projectId, database);

    const id = randomUUID();
    const now = new Date().toISOString();

    try {
      await database.insert(issues).values({
        id,
        issueNumber,
        title: input.title,
        description: input.description ?? null,
        priority: (input.priority as "low" | "medium" | "high" | "critical") ?? "medium",
        issueType: (input.issueType as "task" | "bug" | "feature" | "chore") ?? "task",
        sortOrder: 0,
        statusId: input.statusId,
        projectId: input.projectId,
        createdAt: now,
        updatedAt: now,
      });

      return { id, issueNumber };
    } catch (err: unknown) {
      if (attempt < ISSUE_NUMBER_INSERT_ATTEMPTS && isIssueNumberUniqueConstraintError(err)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Could not allocate a unique issue number");
}

/**
 * Move an issue to a status by id (CLI `issue move`): sets statusId +
 * statusChangedAt + updatedAt, then best-effort syncs the workflow current-node
 * to the new status. Owns the workflow-engine call so the CLI need not hold db.
 */
export async function moveIssueToStatus(issueId: string, statusId: string, database: Database = db): Promise<void> {
  await transitionIssueStatus(database, issueId, statusId);
}

/**
 * Create a sub-issue and link it to its parent via a `child_of` dependency, in a
 * single transaction (CLI `issue create-sub`). The MAX+1 read precedes the tx as
 * in the CLI. Minimal value set + child_of literal preserved verbatim.
 */
export async function createSubIssueWithParentLink(
  input: {
    projectId: string;
    parentId: string;
    title: string;
    description?: string | null;
    priority?: string;
    issueType?: string;
    statusId: string;
  },
  database: Database = db,
): Promise<{ id: string; issueNumber: number; dependencyId: string }> {
  for (let attempt = 1; attempt <= ISSUE_NUMBER_INSERT_ATTEMPTS; attempt++) {
    const issueNumber = await nextIssueNumber(input.projectId, database);

    const id = randomUUID();
    const dependencyId = randomUUID();
    const now = new Date().toISOString();

    try {
      await database.transaction(async (tx) => {
        await tx.insert(issues).values({
          id,
          issueNumber,
          title: input.title,
          description: input.description ?? null,
          priority: (input.priority as "low" | "medium" | "high" | "critical") ?? "medium",
          issueType: (input.issueType as "task" | "bug" | "feature" | "chore") ?? "task",
          sortOrder: 0,
          statusId: input.statusId,
          projectId: input.projectId,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(issueDependencies).values({
          id: dependencyId,
          issueId: id,
          dependsOnId: input.parentId,
          type: "child_of",
          createdAt: now,
        });
      });

      return { id, issueNumber, dependencyId };
    } catch (err: unknown) {
      if (attempt < ISSUE_NUMBER_INSERT_ATTEMPTS && isIssueNumberUniqueConstraintError(err)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Could not allocate a unique issue number");
}
