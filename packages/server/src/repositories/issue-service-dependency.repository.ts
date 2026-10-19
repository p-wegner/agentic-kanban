import { randomUUID } from "node:crypto";
import { issues, issueDependencies } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { hasPath } from "../lib/dependency-graph.js";
import { issueDependencyColumns } from "./projections.js";
import { firstRow } from "../lib/first-row.js";

/** A drizzle connection that is either the base db or an open transaction. */
type DbOrTx = Database | TransactionClient;

export async function insertDependency(
  values: { id: string; issueId: string; dependsOnId: string; type: DependencyType; createdAt: string },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issueDependencies).values(values);
}

/**
 * Return the existing dependency edge matching the unique key
 * (issueId, dependsOnId, type), or null. Used by the CLI to detect duplicates
 * BEFORE inserting — driver-independent, unlike matching the insert error string
 * (libsql's message lacks "UNIQUE constraint"; #857).
 */
export async function getDependencyEdge(
  issueId: string,
  dependsOnId: string,
  type: DependencyType,
  database: DbOrTx = db,
): Promise<{ id: string } | null> {
  return firstRow(
    database
      .select({ id: issueDependencies.id })
      .from(issueDependencies)
      .where(and(
        eq(issueDependencies.issueId, issueId),
        eq(issueDependencies.dependsOnId, dependsOnId),
        eq(issueDependencies.type, type),
      ))
      .limit(1)
  );
}

export async function deleteDependencyByIdAndIssue(
  depId: string,
  issueId: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueDependencies)
    .where(and(eq(issueDependencies.id, depId), eq(issueDependencies.issueId, issueId)));
}

export async function getDependencyRowsForProjects(
  projectIds: string[],
  database: DbOrTx = db,
) {
  return database
    .select({
      ...issueDependencyColumns,
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
