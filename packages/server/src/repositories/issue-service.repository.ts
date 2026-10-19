import { randomUUID } from "node:crypto";
import { issues, issueTags, issueDependencies, issueArtifacts, workspaces, projectStatuses, workflowTemplates, workflowNodes, sessions, tags } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { deleteIssueCascade as deleteIssueCascadeShared } from "@agentic-kanban/shared/lib/cascade-delete";
import { eq, and, sql, inArray, desc, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import type { BatchIssueInput, BatchDependencyInput } from "../lib/batch-create-issues.js";
import { firstRow } from "../lib/first-row.js";

// Decomposed (#1628): these moved to ./issue-service-archive.repository.js; re-exported so import paths are unchanged.
export { getArchivedStatusId, getDoneStatusIds, getDoneCandidateIssues, archiveIssuesByIds } from "./issue-service-archive.repository.js";

// Decomposed (#1628): these moved to ./issue-service-dependency.repository.js; re-exported so import paths are unchanged.
export { insertDependency, getDependencyEdge, getDependencyRowsForProjects, deleteDependencyByIdAndIssue, deleteDependencyById, deleteDependencyByIdReturning, applyDependencyEdgeBatch } from "./issue-service-dependency.repository.js";

/** A drizzle connection that is either the base db or an open transaction. */
type DbOrTx = Database | TransactionClient;

export async function insertIssue(
  values: {
    id: string;
    issueNumber: number;
    title: string;
    description: string | null;
    priority: string;
    issueType: string;
    skipAutoReview: boolean;
    sortOrder: number;
    workflowTemplateId: string | null;
    externalKey: string | null;
    externalUrl: string | null;
    currentNodeId: string | null;
    statusId: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issues).values(values);
}



export async function getWorkflowTemplateForProject(
  templateId: string,
  database: DbOrTx = db,
) {
  return firstRow(
    database
      .select({ id: workflowTemplates.id, projectId: workflowTemplates.projectId })
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, templateId))
      .limit(1)
  );
}



export async function getFirstProjectStatusId(
  projectId: string,
  database: DbOrTx = db,
): Promise<string | null> {
  // Same ordering as `resolveNewIssueDefaults` (issue.repository.ts) — `limit(1)` with no
  // ORDER BY returns whatever the query plan yields first, which is not stable (#1136: six
  // batch-created tickets landed in "AI Reviewed" instead of "Backlog"). `is_default` names
  // the intended column; `sort_order` breaks the tie leftmost-first.
  const row = await firstRow(
    database
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(desc(projectStatuses.isDefault), asc(projectStatuses.sortOrder))
      .limit(1)
  );
  return row?.id ?? null;
}



export async function insertBatchIssue(
  values: {
    id: string;
    issueNumber: number;
    title: string;
    description: string | null;
    priority: string;
    issueType: string;
    skipAutoReview: boolean;
    sortOrder: number;
    statusId: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
    externalKey?: string | null;
    externalUrl?: string | null;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issues).values(values);
}



export async function getIssueWebhookSnapshot(
  id: string,
  database: DbOrTx = db,
) {
  return firstRow(
    database
      .select({
        issueNumber: issues.issueNumber,
        title: issues.title,
        statusId: issues.statusId,
        statusName: projectStatuses.name,
        currentNodeId: issues.currentNodeId,
      })
      .from(issues)
      .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.id, id))
      .limit(1)
  );
}



export async function updateIssueById(
  id: string,
  updates: Record<string, unknown>,
  database: DbOrTx = db,
): Promise<void> {
  await database.update(issues).set(updates).where(eq(issues.id, id));
}



export async function getProjectStatusName(
  statusId: string,
  database: DbOrTx = db,
): Promise<string | null> {
  return (await firstRow(
    database
      .select({ name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.id, statusId))
      .limit(1)
  ))?.name ?? null;
}



export async function getIssueCurrentNodeInfo(
  id: string,
  database: DbOrTx = db,
) {
  return firstRow(
    database
      .select({ currentNodeId: issues.currentNodeId, currentNodeType: workflowNodes.nodeType })
      .from(issues)
      .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
      .where(eq(issues.id, id))
      .limit(1)
  );
}



export async function closeOpenWorkspacesForIssue(
  id: string,
  closedAt: string,
  database: DbOrTx = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({ status: "closed", closedAt, updatedAt: closedAt })
    .where(and(eq(workspaces.issueId, id), sql`${workspaces.status} != 'closed'`));
}



export async function getIssueIdsAndProjects(
  ids: string[],
  database: DbOrTx = db,
) {
  return database
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, ids));
}



export async function updateIssuesByIds(
  ids: string[],
  updates: Record<string, unknown>,
  database: DbOrTx = db,
): Promise<void> {
  await database.update(issues).set(updates).where(inArray(issues.id, ids));
}



export async function getWorkspaceIdsForIssue(
  id: string,
  database: DbOrTx = db,
) {
  return database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.issueId, id));
}



export async function getIssueProjectIdsPair(
  issueId: string,
  dependsOnId: string,
  database: DbOrTx = db,
) {
  return Promise.all([
    database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1),
    database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, dependsOnId)).limit(1),
  ]);
}



export async function getIssueIdsAndProjectsForBatch(
  issueIds: string[],
  database: DbOrTx = db,
) {
  return database
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
}



export async function insertIssueArtifact(
  values: {
    id: string;
    issueId: string;
    workspaceId: string | null;
    type: string;
    mimeType: string | null;
    content: string;
    caption: string | null;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issueArtifacts).values(values);
}



export async function getLatestSessionsForWorkspaces(
  wsIds: string[],
  database: DbOrTx = db,
) {
  if (wsIds.length === 0) return [];
  return database
    .select({
      workspaceId: sessions.workspaceId,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      triggerType: sessions.triggerType,
      // #861 — non-null when the session was dispatched to a remote fleet worker;
      // the enriched workspace DTO derives `remotePlacement` from it.
      workerId: sessions.workerId,
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(desc(sessions.startedAt));
}



export async function getDuplicateSourceIssue(
  sourceId: string,
  database: DbOrTx = db,
) {
  return firstRow(
    database
      .select({
        projectId: issues.projectId,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        issueType: issues.issueType,
      })
      .from(issues)
      .where(eq(issues.id, sourceId))
      .limit(1)
  );
}



/**
 * Cascade-delete an issue and all its data (CLI `issue delete`): every workspace
 * via deleteWorkspaceCascade (which clears that workspace's transitions / retry
 * decisions / diff-comments / artifacts / comments / repos / session-messages /
 * sessions inside its own tx), then every row that FK-references the issue, then
 * the issue row. Order preserved (workspaces+children first).
 *
 * deleteWorkspaceCascade only clears issueArtifacts/issueComments scoped to a
 * WORKSPACE (by workspaceId). Rows attached directly to the issue (workspaceId
 * NULL), plus issueTimeEntries, showdowns, and issueDependencies (in BOTH
 * directions — issueId and dependsOnId), are NOT workspace-scoped, so they must
 * be deleted here. These FKs are RESTRICT in the live DB (#858: the schema's
 * onDelete:"cascade" clauses were never migrated into existing databases, and the
 * action drifts between DBs), so omitting any of them makes the final issue-row
 * delete FK-fail. Each delete is by issueId and idempotent.
 */
export async function deleteIssueCascade(issueId: string, database: Database = db): Promise<void> {
  await deleteIssueCascadeShared(issueId, database);
}



/**
 * Atomically create a batch of issues with sequential per-project numbers,
 * optional case-insensitive tags, optional parent `child_of` links, and
 * index-based inter-issue dependency edges (CLI `issue create-batch`). Owns the
 * TRANSACTION. Replicates the CLI body verbatim — deliberately NOT routed through
 * issue.service.createIssuesBatch (which drops tags / sibling-deps / statusName).
 * `startNumber` + `now` are computed by the caller before the tx, as before.
 */
export async function createIssuesBatchWithDepsAndTags(
  args: {
    projectId: string;
    startNumber: number;
    now: string;
    issueInputs: BatchIssueInput[];
    dependencyInputs: BatchDependencyInput[];
    statuses: Array<{ id: string; name: string }>;
    parentIssueId?: string;
  },
  database: Database = db,
): Promise<{ created: { id: string; issueNumber: number; title: string }[] }> {
  const { projectId, startNumber, now, issueInputs, dependencyInputs, statuses, parentIssueId } = args;
  let nextNumber = startNumber;
  const created: { id: string; issueNumber: number; title: string }[] = [];

  await database.transaction(async (tx) => {
    const tagIdByName = new Map<string, string>();
    const resolveTagId = async (name: string): Promise<string> => {
      const key = name.toLowerCase();
      const cached = tagIdByName.get(key);
      if (cached) return cached;
      const existing = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(sql`lower(${tags.name}) = lower(${name})`)
        .limit(1);
      let tagId: string;
      if (existing.length > 0) {
        tagId = existing[0].id;
      } else {
        tagId = randomUUID();
        await tx.insert(tags).values({ id: tagId, name, color: null, createdAt: now });
      }
      tagIdByName.set(key, tagId);
      return tagId;
    };

    const idByIndex: string[] = [];
    for (const input of issueInputs) {
      const id = randomUUID();
      const statusId = input.statusName
        ? statuses.find((s) => s.name === input.statusName)!.id
        : statuses[0].id;
      const issueNumber = nextNumber++;
      await tx.insert(issues).values({
        id,
        issueNumber,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? "medium",
        issueType: input.issueType ?? "task",
        sortOrder: input.sortOrder ?? 0,
        statusId,
        projectId,
        createdAt: now,
        updatedAt: now,
      });
      if (parentIssueId) {
        await tx.insert(issueDependencies).values({
          id: randomUUID(),
          issueId: id,
          dependsOnId: parentIssueId,
          type: "child_of",
          createdAt: now,
        });
      }
      if (input.tags && input.tags.length > 0) {
        const seenTagIds = new Set<string>();
        for (const tagName of input.tags) {
          const trimmed = tagName.trim();
          if (!trimmed) continue;
          const tagId = await resolveTagId(trimmed);
          if (seenTagIds.has(tagId)) continue;
          seenTagIds.add(tagId);
          await tx.insert(issueTags).values({ id: randomUUID(), issueId: id, tagId });
        }
      }
      idByIndex.push(id);
      created.push({ id, issueNumber, title: input.title });
    }

    for (const e of dependencyInputs) {
      if (e.issueIndex < 0 || e.issueIndex >= issueInputs.length) {
        throw new Error(`dependencies: issueIndex ${e.issueIndex} out of range (0..${issueInputs.length - 1})`);
      }
      if (e.dependsOnIndex < 0 || e.dependsOnIndex >= issueInputs.length) {
        throw new Error(`dependencies: dependsOnIndex ${e.dependsOnIndex} out of range (0..${issueInputs.length - 1})`);
      }
      await tx.insert(issueDependencies).values({
        id: randomUUID(),
        issueId: idByIndex[e.issueIndex],
        dependsOnId: idByIndex[e.dependsOnIndex],
        type: (e.type ?? "depends_on") as DependencyType,
        createdAt: now,
      });
    }
  });

  return { created };
}
