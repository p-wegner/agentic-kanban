import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import { withTransaction } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import { DEPENDENCY_TYPES, type DependencyType } from "@agentic-kanban/shared/schema";
import { IssueError } from "./issue-error.js";
import type { BatchDependencyInput } from "./issue.service.js";
import {
  getIssueProjectId,
  getOutgoingDependencies,
  getIncomingDependencies,
} from "../repositories/issue.repository.js";
import {
  insertDependency,
  getIssueProjectIdsPair,
  deleteDependencyByIdAndIssue,
  getIssueIdsAndProjectsForBatch,
  getDependencyRowsForProjects,
  deleteDependencyById,
} from "../repositories/issue-service.repository.js";
import { wouldCreateCycle } from "./board-aggregation.service.js";
import { hasPath } from "../lib/dependency-graph.js";

/** Edge types that can form a meaningful cycle (the symmetric peers cannot). */
const DIRECTIONAL_DEPENDENCY_TYPES = new Set<DependencyType>(["depends_on", "blocked_by", "parent_of", "child_of"]);

/**
 * Validate index-based batch dependency edges and normalise each `type` (default
 * `depends_on`). Mirrors the `create_issues_batch` MCP tool: range-checks indices,
 * rejects self-edges and duplicates, and rejects a cycle across the DIRECTIONAL edges
 * only (`coupled_with`/`related_to`/`duplicates` are symmetric peers and never cycle).
 * Throws `IssueError(BAD_REQUEST)` with the offending edge `index` on any violation.
 */
export function validateBatchDependencies(
  edges: BatchDependencyInput[],
  issueCount: number,
): Array<{ issueIndex: number; dependsOnIndex: number; type: DependencyType }> {
  const normalized: Array<{ issueIndex: number; dependsOnIndex: number; type: DependencyType }> = [];
  const adj = new Map<number, Set<number>>();
  const seen = new Set<string>();
  const fail = (msg: string, index: number): never => {
    const err = new IssueError(msg, "BAD_REQUEST") as IssueError & { index?: number };
    err.index = index;
    throw err;
  };
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!Number.isInteger(e.issueIndex) || e.issueIndex < 0 || e.issueIndex >= issueCount) {
      fail(`dependencies[${i}].issueIndex ${e.issueIndex} out of range (0..${issueCount - 1})`, i);
    }
    if (!Number.isInteger(e.dependsOnIndex) || e.dependsOnIndex < 0 || e.dependsOnIndex >= issueCount) {
      fail(`dependencies[${i}].dependsOnIndex ${e.dependsOnIndex} out of range (0..${issueCount - 1})`, i);
    }
    if (e.issueIndex === e.dependsOnIndex) {
      fail(`dependencies[${i}]: an issue cannot depend on itself`, i);
    }
    const type = e.type ?? "depends_on";
    if (!DEPENDENCY_TYPES.includes(type)) {
      fail(`dependencies[${i}].type '${type}' is not supported`, i);
    }
    const key = `${e.issueIndex} ${e.dependsOnIndex} ${type}`;
    if (seen.has(key)) {
      fail(`dependencies[${i}]: duplicate edge (issue ${e.issueIndex} -> ${e.dependsOnIndex}, type ${type})`, i);
    }
    seen.add(key);
    if (DIRECTIONAL_DEPENDENCY_TYPES.has(type)) {
      let set = adj.get(e.issueIndex);
      if (!set) { set = new Set(); adj.set(e.issueIndex, set); }
      set.add(e.dependsOnIndex);
    }
    normalized.push({ issueIndex: e.issueIndex, dependsOnIndex: e.dependsOnIndex, type });
  }
  const reaches = (from: number, to: number): boolean => {
    const stack = [from];
    const visited = new Set<number>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const n of adj.get(cur) ?? []) stack.push(n);
    }
    return false;
  };
  for (let i = 0; i < normalized.length; i++) {
    const e = normalized[i];
    if (DIRECTIONAL_DEPENDENCY_TYPES.has(e.type) && reaches(e.dependsOnIndex, e.issueIndex)) {
      fail(`dependencies[${i}]: would create a cycle (issue ${e.issueIndex} -> ${e.dependsOnIndex})`, i);
    }
  }
  return normalized;
}

/**
 * Dependency-management slice of the issue service: add/remove a single dependency,
 * apply a validated batch of add/remove edges atomically (with in-transaction cycle
 * detection), and read an issue's outgoing+incoming dependencies. Extracted from
 * issue.service.ts behind that facade (it spreads this bag into its returned service)
 * so the core service file stays under the god-module ceiling. Self-contained: depends
 * only on the injected `database`/`boardEvents` plus repository helpers.
 */
export function createIssueDependencyService(deps: {
  database: Database;
  boardEvents?: BoardEvents;
}) {
  const { database, boardEvents } = deps;

  async function addDependency(
    issueId: string,
    dependsOnId: string,
    type?: string,
  ): Promise<{ id: string; type: string; projectId: string }> {
    if (dependsOnId === issueId) {
      throw new IssueError("An issue cannot depend on itself", "BAD_REQUEST");
    }

    const depType = (type || "depends_on") as DependencyType;
    const validTypes: string[] = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of", "coupled_with"];
    if (!validTypes.includes(depType)) {
      throw new IssueError(`Invalid dependency type. Must be one of: ${validTypes.join(", ")}`, "BAD_REQUEST");
    }

    const [sourceIssue, targetIssue] = await getIssueProjectIdsPair(issueId, dependsOnId, database);

    if (sourceIssue.length === 0) throw new IssueError("Issue not found", "NOT_FOUND");
    if (targetIssue.length === 0) throw new IssueError("Dependency target issue not found", "NOT_FOUND");
    if (sourceIssue[0].projectId !== targetIssue[0].projectId) {
      throw new IssueError("Cannot add dependencies across projects", "BAD_REQUEST");
    }

    if (depType === "depends_on" || depType === "blocked_by" || depType === "parent_of" || depType === "child_of") {
      const wouldCycle = await wouldCreateCycle(database, issueId, dependsOnId, sourceIssue[0].projectId);
      if (wouldCycle) {
        throw new IssueError("Adding this dependency would create a cycle", "CONFLICT");
      }
    }

    const id = randomUUID();
    try {
      await insertDependency({
        id,
        issueId,
        dependsOnId,
        type: depType,
        createdAt: new Date().toISOString(),
      }, database);
    } catch (err: unknown) {
      const e = err as {
        message?: string;
        code?: string;
        cause?: { message?: string; code?: string };
      };
      const isUnique =
        e.message?.includes("UNIQUE constraint") ||
        e.cause?.message?.includes("UNIQUE constraint") ||
        e.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        e.cause?.code === "SQLITE_CONSTRAINT_UNIQUE";
      if (isUnique) {
        throw new IssueError("This dependency already exists", "CONFLICT");
      }
      throw err;
    }

    boardEvents?.broadcast(sourceIssue[0].projectId, "dependency_added");
    return { id, type: depType, projectId: sourceIssue[0].projectId };
  }

  async function removeDependency(issueId: string, depId: string): Promise<string | null> {
    await deleteDependencyByIdAndIssue(depId, issueId, database);

    const projectId = await getIssueProjectId(issueId, database);
    if (projectId) boardEvents?.broadcast(projectId, "dependency_removed");
    return projectId;
  }

  async function updateDependenciesBatch(
    edges: { issueId: string; dependsOnId: string; type?: string; action: "add" | "remove" }[],
  ): Promise<{
    added: number;
    removed: number;
    skipped: { edge: typeof edges[number]; reason: string }[];
    projectIds: string[];
  }> {
    const VALID_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of", "coupled_with"];
    const DIRECTIONAL = new Set(["depends_on", "blocked_by", "parent_of", "child_of"]);

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e.issueId || !e.dependsOnId) {
        const err = new IssueError(`edges[${i}]: issueId and dependsOnId are required`, "BAD_REQUEST") as IssueError & { index?: number };
        err.index = i;
        throw err;
      }
      if (e.action !== "add" && e.action !== "remove") {
        const err = new IssueError(`edges[${i}]: action must be 'add' or 'remove'`, "BAD_REQUEST") as IssueError & { index?: number };
        err.index = i;
        throw err;
      }
      if (e.action === "add" && e.issueId === e.dependsOnId) {
        const err = new IssueError(`edges[${i}]: an issue cannot depend on itself`, "BAD_REQUEST") as IssueError & { index?: number };
        err.index = i;
        throw err;
      }
      if (e.type && !VALID_TYPES.includes(e.type)) {
        const err = new IssueError(`edges[${i}]: invalid type`, "BAD_REQUEST") as IssueError & { index?: number };
        err.index = i;
        throw err;
      }
    }

    const skipped: { edge: typeof edges[number]; reason: string }[] = [];
    const touchedProjectIds = new Set<string>();
    let added = 0;
    let removed = 0;

    await withTransaction(database, async (tx) => {
      const issueIds = [...new Set(edges.flatMap(e => [e.issueId, e.dependsOnId]))];
      const issueRows = issueIds.length === 0 ? [] : await getIssueIdsAndProjectsForBatch(issueIds, tx);
      const projectByIssue = new Map(issueRows.map(r => [r.id, r.projectId]));

      const projectIds = [...new Set(issueRows.map(r => r.projectId))];
      const allDepRows = projectIds.length === 0
        ? []
        : await getDependencyRowsForProjects(projectIds, tx);

      const adjByProject = new Map<string, Map<string, Set<string>>>();
      const edgeKeyToRow = new Map<string, { id: string; projectId: string }>();
      for (const dep of allDepRows) {
        if (DIRECTIONAL.has(dep.type)) {
          let adj = adjByProject.get(dep.projectId);
          if (!adj) { adj = new Map(); adjByProject.set(dep.projectId, adj); }
          let set = adj.get(dep.issueId);
          if (!set) { set = new Set(); adj.set(dep.issueId, set); }
          set.add(dep.dependsOnId);
        }
        edgeKeyToRow.set(`${dep.issueId}|${dep.dependsOnId}|${dep.type}`, { id: dep.id, projectId: dep.projectId });
      }

      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const type = e.type ?? "depends_on";
        const srcProj = projectByIssue.get(e.issueId);
        const tgtProj = projectByIssue.get(e.dependsOnId);

        if (e.action === "add") {
          if (!srcProj) { skipped.push({ edge: e, reason: "source issue not found" }); continue; }
          if (!tgtProj) { skipped.push({ edge: e, reason: "target issue not found" }); continue; }
          if (srcProj !== tgtProj) { skipped.push({ edge: e, reason: "cross-project dependency" }); continue; }

          const key = `${e.issueId}|${e.dependsOnId}|${type}`;
          if (edgeKeyToRow.has(key)) { skipped.push({ edge: e, reason: "already exists" }); continue; }

          if (DIRECTIONAL.has(type)) {
            let adj = adjByProject.get(srcProj);
            if (!adj) { adj = new Map(); adjByProject.set(srcProj, adj); }
            // Would adding issueId -> dependsOnId create a cycle? Cycle iff path dependsOnId -> issueId already.
            if (hasPath(adj, e.dependsOnId, e.issueId)) {
              const err = new IssueError(
                `edges[${i}]: adding dependency ${e.issueId} -> ${e.dependsOnId} would create a cycle`,
                "CONFLICT",
              ) as IssueError & { index?: number };
              err.index = i;
              throw err;
            }
            let set = adj.get(e.issueId);
            if (!set) { set = new Set(); adj.set(e.issueId, set); }
            set.add(e.dependsOnId);
          }

          const id = randomUUID();
          await insertDependency({
            id,
            issueId: e.issueId,
            dependsOnId: e.dependsOnId,
            type: type as DependencyType,
            createdAt: new Date().toISOString(),
          }, tx);
          edgeKeyToRow.set(key, { id, projectId: srcProj });
          touchedProjectIds.add(srcProj);
          added++;
        } else {
          const key = `${e.issueId}|${e.dependsOnId}|${type}`;
          const row = edgeKeyToRow.get(key);
          if (!row) { skipped.push({ edge: e, reason: "dependency does not exist" }); continue; }
          await deleteDependencyById(row.id, tx);
          edgeKeyToRow.delete(key);
          if (DIRECTIONAL.has(type)) {
            const adj = adjByProject.get(row.projectId);
            adj?.get(e.issueId)?.delete(e.dependsOnId);
          }
          touchedProjectIds.add(row.projectId);
          removed++;
        }
      }
    });

    for (const pid of touchedProjectIds) {
      boardEvents?.broadcast(pid, added > 0 ? "dependency_added" : "dependency_removed");
    }

    return { added, removed, skipped, projectIds: [...touchedProjectIds] };
  }

  async function getDependencies(issueId: string) {
    const [outgoing, incoming] = await Promise.all([
      getOutgoingDependencies(issueId, database),
      getIncomingDependencies(issueId, database),
    ]);
    return { dependencies: [...outgoing, ...incoming] };
  }

  return { addDependency, removeDependency, updateDependenciesBatch, getDependencies };
}
