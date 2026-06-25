import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { notifyBoard } from "../notify.js";
import { requireEntity } from "../db-utils.js";
import { buildAdjacency, wouldCreateCycle as graphWouldCreateCycle } from "@agentic-kanban/shared/lib/dependency-graph.js";

const VALID_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of", "coupled_with"] as const;

async function wouldCreateCycle(issueId: string, dependsOnId: string, projectId: string): Promise<boolean> {
  const allDeps = await db
    .select({
      depIssueId: schema.issueDependencies.issueId,
      depDependsOnId: schema.issueDependencies.dependsOnId,
    })
    .from(schema.issueDependencies)
    .innerJoin(schema.issues, eq(schema.issueDependencies.issueId, schema.issues.id))
    .where(eq(schema.issues.projectId, projectId));

  const adj = buildAdjacency(allDeps.map((d) => ({ from: d.depIssueId, to: d.depDependsOnId })));
  return graphWouldCreateCycle(adj, issueId, dependsOnId);
}

export function registerAddDependency(server: McpServer) {
  server.tool(
    "add_dependency",
    "Add a dependency link between two issues. Types: depends_on (prerequisite), blocked_by (inverse of depends_on), related_to (symmetric link), duplicates (marks as duplicate), parent_of (parent-child), child_of (inverse of parent_of), coupled_with (symmetric peer edge: two issues touch the same code and are best implemented together). Rejects cycles for directional types and self-dependencies.",
    {
      issueId: z.string().describe("The issue ID that has the dependency"),
      dependsOnId: z.string().describe("The issue ID of the target issue"),
      type: z.enum(VALID_TYPES).default("depends_on").describe("Dependency type: depends_on, blocked_by, related_to, duplicates, parent_of, child_of, coupled_with"),
    },
    async ({ issueId, dependsOnId, type }) => {
      if (dependsOnId === issueId) {
        return { content: [{ type: "text" as const, text: "Error: An issue cannot depend on itself" }] };
      }

      const depType = type || "depends_on";

      const [sourceIssue, targetIssue] = await Promise.all([
        db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1),
        db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.id, dependsOnId)).limit(1),
      ]);

      const r1 = requireEntity(sourceIssue, issueId, "Issue");
      if (!r1.ok) return r1.error;
      const r2 = requireEntity(targetIssue, dependsOnId, "Issue");
      if (!r2.ok) return r2.error;
      if (r1.value.projectId !== r2.value.projectId) {
        return { content: [{ type: "text" as const, text: "Error: Cannot add dependencies across projects" }] };
      }

      // Cycle detection for directional types only
      if (depType === "depends_on" || depType === "blocked_by" || depType === "parent_of" || depType === "child_of") {
        const wouldCycle = await wouldCreateCycle(issueId, dependsOnId, r1.value.projectId);
        if (wouldCycle) {
          return { content: [{ type: "text" as const, text: "Error: Adding this dependency would create a cycle" }] };
        }
      }

      const id = randomUUID();
      try {
        await db.insert(schema.issueDependencies).values({
          id,
          issueId,
          dependsOnId,
          type: depType,
          createdAt: new Date().toISOString(),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : undefined;
        if (message?.includes("UNIQUE constraint")) {
          return { content: [{ type: "text" as const, text: "Error: This dependency already exists" }] };
        }
        throw err;
      }

      notifyBoard(r1.value.projectId, "mcp_dependency_added");

      return { content: [{ type: "text" as const, text: JSON.stringify({ id, issueId, dependsOnId, type: depType }, null, 2) }] };
    },
  );
}
