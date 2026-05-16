import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { notifyBoard } from "../notify.js";

const VALID_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"] as const;

async function wouldCreateCycle(issueId: string, dependsOnId: string, projectId: string): Promise<boolean> {
  const allDeps = await db
    .select({
      depIssueId: schema.issueDependencies.issueId,
      depDependsOnId: schema.issueDependencies.dependsOnId,
    })
    .from(schema.issueDependencies)
    .innerJoin(schema.issues, eq(schema.issueDependencies.issueId, schema.issues.id))
    .where(eq(schema.issues.projectId, projectId));

  const adj = new Map<string, Set<string>>();
  for (const dep of allDeps) {
    let set = adj.get(dep.depIssueId);
    if (!set) { set = new Set(); adj.set(dep.depIssueId, set); }
    set.add(dep.depDependsOnId);
  }

  const visited = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === issueId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const neighbors = adj.get(current);
    if (neighbors) {
      for (const n of neighbors) stack.push(n);
    }
  }
  return false;
}

export function registerAddDependency(server: McpServer) {
  server.tool(
    "add_dependency",
    "Add a dependency link between two issues. Types: depends_on (prerequisite), blocked_by (inverse of depends_on), related_to (symmetric link), duplicates (marks as duplicate), parent_of (parent-child), child_of (inverse of parent_of). Rejects cycles for directional types and self-dependencies.",
    {
      issueId: z.string().describe("The issue ID that has the dependency"),
      dependsOnId: z.string().describe("The issue ID of the target issue"),
      type: z.enum(VALID_TYPES).default("depends_on").describe("Dependency type: depends_on, blocked_by, related_to, duplicates, parent_of, child_of"),
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

      if (sourceIssue.length === 0) return { content: [{ type: "text" as const, text: `Issue ${issueId} not found` }] };
      if (targetIssue.length === 0) return { content: [{ type: "text" as const, text: `Issue ${dependsOnId} not found` }] };
      if (sourceIssue[0].projectId !== targetIssue[0].projectId) {
        return { content: [{ type: "text" as const, text: "Error: Cannot add dependencies across projects" }] };
      }

      // Cycle detection for directional types only
      if (depType === "depends_on" || depType === "blocked_by" || depType === "parent_of" || depType === "child_of") {
        const wouldCycle = await wouldCreateCycle(issueId, dependsOnId, sourceIssue[0].projectId);
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
      } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint")) {
          return { content: [{ type: "text" as const, text: "Error: This dependency already exists" }] };
        }
        throw err;
      }

      notifyBoard(sourceIssue[0].projectId, "mcp_dependency_added");

      return { content: [{ type: "text" as const, text: JSON.stringify({ id, issueId, dependsOnId, type: depType }, null, 2) }] };
    },
  );
}
