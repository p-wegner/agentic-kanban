import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";

const VALID_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"] as const;
const DIRECTIONAL = new Set<string>(["depends_on", "blocked_by", "parent_of", "child_of"]);

const edgeSchema = z.object({
  issueId: z.string(),
  dependsOnId: z.string(),
  type: z.enum(VALID_TYPES).optional(),
  action: z.enum(["add", "remove"]),
});

export function registerUpdateDependenciesBatch(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "update_dependencies_batch",
    "Add or remove multiple dependency edges atomically. Idempotent: existing add or missing remove is skipped (not failed). Cycle detection across the batch; rolls back on cycle.",
    {
      edges: z.array(edgeSchema).describe("Array of dependency edge operations"),
    },
    async ({ edges }) => {
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.action === "add" && e.issueId === e.dependsOnId) {
          return { content: [{ type: "text" as const, text: `Error: edges[${i}]: an issue cannot depend on itself` }] };
        }
      }

      const issueIds = [...new Set(edges.flatMap(e => [e.issueId, e.dependsOnId]))];
      const issueRows = issueIds.length === 0 ? [] : await db
        .select({ id: schema.issues.id, projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(inArray(schema.issues.id, issueIds));
      const projectByIssue = new Map(issueRows.map(r => [r.id, r.projectId]));

      const projectIds = [...new Set(issueRows.map(r => r.projectId))];
      const allDepRows = projectIds.length === 0 ? [] : await db
        .select({
          id: schema.issueDependencies.id,
          issueId: schema.issueDependencies.issueId,
          dependsOnId: schema.issueDependencies.dependsOnId,
          type: schema.issueDependencies.type,
          projectId: schema.issues.projectId,
        })
        .from(schema.issueDependencies)
        .innerJoin(schema.issues, eq(schema.issueDependencies.issueId, schema.issues.id))
        .where(inArray(schema.issues.projectId, projectIds));

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

      const hasPath = (adj: Map<string, Set<string>>, from: string, to: string): boolean => {
        const visited = new Set<string>();
        const stack = [from];
        while (stack.length) {
          const cur = stack.pop()!;
          if (cur === to) return true;
          if (visited.has(cur)) continue;
          visited.add(cur);
          const ns = adj.get(cur);
          if (ns) for (const n of ns) stack.push(n);
        }
        return false;
      };

      const skipped: { edge: typeof edges[number]; reason: string }[] = [];
      const touched = new Set<string>();
      let added = 0;
      let removed = 0;
      let cycleError: { index: number; message: string } | null = null;

      await db.transaction(async (tx) => {
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
              if (hasPath(adj, e.dependsOnId, e.issueId)) {
                cycleError = { index: i, message: `edges[${i}]: would create a cycle (${e.issueId} -> ${e.dependsOnId})` };
                throw new Error(cycleError.message);
              }
              let set = adj.get(e.issueId);
              if (!set) { set = new Set(); adj.set(e.issueId, set); }
              set.add(e.dependsOnId);
            }

            const id = randomUUID();
            await tx.insert(schema.issueDependencies).values({
              id,
              issueId: e.issueId,
              dependsOnId: e.dependsOnId,
              type,
              createdAt: new Date().toISOString(),
            });
            edgeKeyToRow.set(key, { id, projectId: srcProj });
            touched.add(srcProj);
            added++;
          } else {
            const key = `${e.issueId}|${e.dependsOnId}|${type}`;
            const row = edgeKeyToRow.get(key);
            if (!row) { skipped.push({ edge: e, reason: "dependency does not exist" }); continue; }
            await tx.delete(schema.issueDependencies).where(eq(schema.issueDependencies.id, row.id));
            edgeKeyToRow.delete(key);
            if (DIRECTIONAL.has(type)) {
              const adj = adjByProject.get(row.projectId);
              adj?.get(e.issueId)?.delete(e.dependsOnId);
            }
            touched.add(row.projectId);
            removed++;
          }
        }
      }).catch((err) => {
        if (cycleError) return;
        throw err;
      });

      if (cycleError) {
        return { content: [{ type: "text" as const, text: `Error: ${(cycleError as { message: string }).message}` }] };
      }

      for (const pid of touched) {
        notifyBoard(pid, added > 0 ? "mcp_dependency_added" : "mcp_dependency_removed");
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ added, removed, skipped }, null, 2) }] };
    },
  );
}
