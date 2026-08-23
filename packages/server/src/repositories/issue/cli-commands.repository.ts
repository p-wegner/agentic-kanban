/**
 * Issue queries/mutations that back the `pnpm cli -- issue ...` commands
 * specifically (as opposed to the board API's own projections) — split out of
 * `issue.repository.ts` to relieve its cohesion-gate count (#465 decomposition,
 * #957 pattern: the blanket /repositories/ exemption is gone, so this facade
 * ships its OWN sub-modules rather than growing past the flat threshold).
 */
import { issues, projectStatuses, issueDependencies, projects } from "@agentic-kanban/shared/schema";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { parseIssueRef } from "@agentic-kanban/shared/lib/issue-ref";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import { isIssueNumberUniqueConstraintError, nextIssueNumber } from "../issue-number.repository.js";
import { issueIdentityColumns, issueTextColumns } from "../projections.js";
import { firstRow } from "@agentic-kanban/shared/lib/first-row";

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
  return firstRow(
    database
      .select({
        ...issueTextColumns,
        priority: issues.priority,
        issueType: issues.issueType,
        statusName: projectStatuses.name,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(and(eq(issues.issueNumber, issueNumber), eq(issues.projectId, projectId)))
      .limit(1)
  );
}

/**
 * Every project that has an issue with this number, newest project first (#467).
 *
 * Issue numbers are per-project, so `#462` is ambiguous across the board. When a lookup in the
 * ACTIVE project misses, the CLI used to say "not found" — which reads as "that ticket does not
 * exist" and sends the reader off investigating a phantom, when in fact the number belongs to
 * another project. This is what lets the CLI say which one instead.
 */
export async function findProjectsWithIssueNumber(issueNumber: number, database: Database = db) {
  return database
    .select({
      projectId: projects.id,
      projectName: projects.name,
      issueId: issues.id,
      title: issues.title,
    })
    .from(issues)
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(eq(issues.issueNumber, issueNumber));
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
  const ref = parseIssueRef(issueArg);
  if (ref.kind === "number" && projectId === undefined) {
    // #509: this was `eq(issues.projectId, projectId!)`. The non-null assertion was a
    // claim, not a check — with no project the comparison became `project_id = undefined`,
    // whose result is a driver detail rather than a decision anyone made. A numeric ref
    // is meaningless without a project (numbers are per-project), so say so.
    return null;
  }
  const whereClause = ref.kind === "number"
    ? and(eq(issues.issueNumber, ref.issueNumber), eq(issues.projectId, projectId as string))
    : eq(issues.id, ref.issueId);
  return firstRow(database.select().from(issues).where(whereClause).limit(1));
}

/** Issue identity + status name by issue id (CLI `session analyze` context), or null. */
export async function getIssueWithStatusById(issueId: string, database: Database = db) {
  return firstRow(
    database
      .select({
        ...issueIdentityColumns,
        statusName: projectStatuses.name,
        priority: issues.priority,
        issueType: issues.issueType,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

/**
 * Title + description for the first issue with this issue number (NOT project-
 * scoped — matches the CLI `session find-similar` global lookup), or null.
 */
export async function getIssueTitleDescriptionByNumber(
  issueNumber: number,
  /**
   * #509: this was an unscoped `where(issueNumber = N)` — the same defect #506 fixed at
   * three other surfaces. Numbers are per-project, so on a multi-project board it could
   * pull ANOTHER project's issue text and feed it to the failure-pattern search as if it
   * were this ticket's. Optional so the signature stays back-compatible; every caller in
   * tree now passes it.
   */
  projectId?: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(projectId
        ? and(eq(issues.issueNumber, issueNumber), eq(issues.projectId, projectId))
        : eq(issues.issueNumber, issueNumber))
      .limit(1)
  );
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
