import { randomUUID } from "node:crypto";
import { issues, issueTags, issueDependencies, issueArtifacts, issueComments, showdowns, workspaces, projectStatuses, workflowTemplates, workflowNodes, sessions, tags } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { eq, and, or, sql, inArray, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { deleteWorkspaceCascade } from "./workspace.repository.js";
import { hasPath } from "../lib/dependency-graph.js";
import type { BatchIssueInput, BatchDependencyInput } from "../lib/batch-create-issues.js";

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
    estimate: string | null;
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
  const rows = await database
    .select({ id: workflowTemplates.id, projectId: workflowTemplates.projectId })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, templateId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMaxIssueNumber(
  projectId: string,
  database: DbOrTx = db,
): Promise<number | null> {
  const maxRow = await database
    .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  return maxRow[0]?.maxNum ?? null;
}

export async function getFirstProjectStatusId(
  projectId: string,
  database: DbOrTx = db,
): Promise<string | null> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .limit(1);
  return rows.length === 0 ? null : rows[0].id;
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
    estimate: string | null;
    sortOrder: number;
    statusId: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issues).values(values);
}

export async function insertDependency(
  values: { id: string; issueId: string; dependsOnId: string; type: DependencyType; createdAt: string },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issueDependencies).values(values);
}

export async function getIssueWebhookSnapshot(
  id: string,
  database: DbOrTx = db,
) {
  const rows = await database
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
    .limit(1);
  return rows[0] ?? null;
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
  const statusRow = await database
    .select({ name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.id, statusId))
    .limit(1);
  return statusRow[0]?.name ?? null;
}

export async function getIssueCurrentNodeInfo(
  id: string,
  database: DbOrTx = db,
) {
  const rows = await database
    .select({ currentNodeId: issues.currentNodeId, currentNodeType: workflowNodes.nodeType })
    .from(issues)
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.id, id))
    .limit(1);
  return rows[0] ?? null;
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

export async function deleteIssueArtifactsForIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueArtifacts).where(eq(issueArtifacts.issueId, id));
}

export async function deleteIssueCommentsForIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueComments).where(eq(issueComments.issueId, id));
}

export async function getWorkspaceIdsForIssue(
  id: string,
  database: DbOrTx = db,
) {
  return database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.issueId, id));
}

export async function deleteIssueTagsForIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueTags).where(eq(issueTags.issueId, id));
}

export async function deleteDependenciesTouchingIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueDependencies).where(or(eq(issueDependencies.issueId, id), eq(issueDependencies.dependsOnId, id)));
}

export async function deleteShowdownsForIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(showdowns).where(eq(showdowns.issueId, id));
}

export async function deleteIssueRow(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issues).where(eq(issues.id, id));
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

export async function deleteDependencyByIdAndIssue(
  depId: string,
  issueId: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueDependencies)
    .where(and(eq(issueDependencies.id, depId), eq(issueDependencies.issueId, issueId)));
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

export async function getDependencyRowsForProjects(
  projectIds: string[],
  database: DbOrTx = db,
) {
  return database
    .select({
      id: issueDependencies.id,
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
      projectId: issues.projectId,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(inArray(issues.projectId, projectIds));
}

export async function deleteDependencyById(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueDependencies).where(eq(issueDependencies.id, id));
}

/**
 * Delete a dependency by id, returning the number of rows removed (0 = not
 * found). Uses `.returning().length` rather than a driver row-count because
 * libsql reports `rowsAffected`/`changes` unreliably for the not-found check
 * (CLI `issue dependency remove`).
 */
export async function deleteDependencyByIdReturning(
  id: string,
  database: DbOrTx = db,
): Promise<number> {
  const deleted = await database.delete(issueDependencies).where(eq(issueDependencies.id, id)).returning();
  return deleted.length;
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
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(desc(sessions.startedAt));
}

export async function getDuplicateSourceIssue(
  sourceId: string,
  database: DbOrTx = db,
) {
  const rows = await database
    .select({
      projectId: issues.projectId,
      title: issues.title,
      description: issues.description,
      priority: issues.priority,
      issueType: issues.issueType,
    })
    .from(issues)
    .where(eq(issues.id, sourceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getArchivedStatusId(
  projectId: string,
  database: DbOrTx = db,
): Promise<string | null> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Archived")))
    .limit(1);
  return rows.length === 0 ? null : rows[0].id;
}

export async function getDoneStatusIds(
  projectId: string,
  database: DbOrTx = db,
): Promise<string[]> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Done")));
  return rows.map((s) => s.id);
}

export async function getDoneCandidateIssues(
  projectId: string,
  doneStatusIds: string[],
  database: DbOrTx = db,
) {
  return database
    .select({ id: issues.id, statusChangedAt: issues.statusChangedAt, createdAt: issues.createdAt })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.statusId, doneStatusIds)));
}

export async function archiveIssuesByIds(
  issueIds: string[],
  archivedStatusId: string,
  now: string,
  database: DbOrTx = db,
): Promise<void> {
  await database
    .update(issues)
    .set({ statusId: archivedStatusId, statusChangedAt: now, updatedAt: now })
    .where(inArray(issues.id, issueIds));
}

/**
 * Apply a batch of dependency add/remove edges atomically (CLI `issue dependency
 * update-batch`). The caller pre-builds the project/adjacency/edge-key maps from
 * already-fetched rows; this owns the TRANSACTION. Idempotent (existing adds /
 * missing removes are skipped) with in-memory cycle detection. On a cycle it sets
 * `cycleError` and throws to roll back; the outer catch swallows ONLY then and
 * surfaces `cycleError` in the result. The passed maps are mutated in place as
 * bookkeeping (harmless — the CLI does not read them afterward).
 */
export async function applyDependencyEdgeBatch(
  args: {
    edges: Array<{ issueId: string; dependsOnId: string; type?: string; action: "add" | "remove" }>;
    projectByIssue: Map<string, string>;
    adjByProject: Map<string, Map<string, Set<string>>>;
    edgeKeyToRow: Map<string, { id: string; projectId: string }>;
    directional: Set<string>;
  },
  database: Database = db,
): Promise<{ added: number; removed: number; skipped: { edge: (typeof args.edges)[number]; reason: string }[]; cycleError: string | null }> {
  const { edges, projectByIssue, adjByProject, edgeKeyToRow, directional } = args;
  const skipped: { edge: (typeof edges)[number]; reason: string }[] = [];
  let added = 0;
  let removed = 0;
  let cycleError: string | null = null;

  await database
    .transaction(async (tx) => {
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const type = (e.type ?? "depends_on") as DependencyType;
        const srcProj = projectByIssue.get(e.issueId);
        const tgtProj = projectByIssue.get(e.dependsOnId);

        if (e.action === "add") {
          if (!srcProj) { skipped.push({ edge: e, reason: "source issue not found" }); continue; }
          if (!tgtProj) { skipped.push({ edge: e, reason: "target issue not found" }); continue; }
          if (srcProj !== tgtProj) { skipped.push({ edge: e, reason: "cross-project dependency" }); continue; }

          const key = `${e.issueId}|${e.dependsOnId}|${type}`;
          if (edgeKeyToRow.has(key)) { skipped.push({ edge: e, reason: "already exists" }); continue; }

          if (directional.has(type)) {
            let adj = adjByProject.get(srcProj);
            if (!adj) { adj = new Map(); adjByProject.set(srcProj, adj); }
            if (hasPath(adj, e.dependsOnId, e.issueId)) {
              cycleError = `edges[${i}]: would create a cycle (${e.issueId} -> ${e.dependsOnId})`;
              throw new Error(cycleError);
            }
            let set = adj.get(e.issueId);
            if (!set) { set = new Set(); adj.set(e.issueId, set); }
            set.add(e.dependsOnId);
          }

          const id = randomUUID();
          await tx.insert(issueDependencies).values({
            id,
            issueId: e.issueId,
            dependsOnId: e.dependsOnId,
            type,
            createdAt: new Date().toISOString(),
          });
          edgeKeyToRow.set(`${e.issueId}|${e.dependsOnId}|${type}`, { id, projectId: srcProj });
          added++;
        } else {
          const key = `${e.issueId}|${e.dependsOnId}|${type}`;
          const row = edgeKeyToRow.get(key);
          if (!row) { skipped.push({ edge: e, reason: "dependency does not exist" }); continue; }
          await tx.delete(issueDependencies).where(eq(issueDependencies.id, row.id));
          edgeKeyToRow.delete(key);
          if (directional.has(type)) {
            const adj = adjByProject.get(row.projectId);
            adj?.get(e.issueId)?.delete(e.dependsOnId);
          }
          removed++;
        }
      }
    })
    .catch((err) => {
      if (cycleError) return;
      throw err;
    });

  return { added, removed, skipped, cycleError };
}

/**
 * Cascade-delete an issue and all its data (CLI `issue delete`): every workspace
 * via deleteWorkspaceCascade (which clears that workspace's transitions / retry
 * decisions / diff-comments / artifacts / comments / repos / session-messages /
 * sessions inside its own tx), then the issue's tags, then the issue row. Order
 * preserved (workspaces+children first). NOTE: deleteWorkspaceCascade clears a
 * SUPERSET of the old hand-rolled CLI loop — it additionally removes
 * workflowTransitions/testRetryDecisions/issueArtifacts/issueComments/repos that
 * the previous CLI cascade leaked, mirroring the deleteProjectCascade fix.
 */
export async function deleteIssueCascade(issueId: string, database: Database = db): Promise<void> {
  const wsRows = await database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.issueId, issueId));
  for (const ws of wsRows) {
    await deleteWorkspaceCascade(ws.id, database);
  }
  await deleteIssueTagsForIssue(issueId, database);
  await deleteIssueRow(issueId, database);
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
        estimate: input.estimate ?? null,
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
