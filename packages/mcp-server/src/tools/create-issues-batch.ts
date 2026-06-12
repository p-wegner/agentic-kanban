import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";
import { nextIssueNumber } from "../db-utils.js";

const issueInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  issueType: z.string().optional(),
  estimate: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  statusName: z.string().optional(),
});

const DEPENDENCY_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"] as const;

/**
 * A dependency edge seeded alongside the batch. Endpoints reference the
 * just-created issues by their 0-based index in the `issues` array, since the
 * issue IDs are generated inside this call and not yet known to the caller.
 */
const dependencyInputSchema = z.object({
  issueIndex: z.number().int().describe("0-based index into the `issues` array — the dependent issue"),
  dependsOnIndex: z.number().int().describe("0-based index into the `issues` array — the issue it depends on / is blocked by"),
  type: z.enum(DEPENDENCY_TYPES).optional().describe("Edge type (default depends_on)"),
});

export function registerCreateIssuesBatch(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "create_issues_batch",
    "Create multiple issues atomically in a single call, optionally with dependency edges between them. Returns each created issue with its assigned issueNumber. All-or-nothing: issues AND edges commit in one transaction, so autodrive can never observe a ticket before its dependency edges exist. Any validation failure rolls back.",
    {
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
      parentIssueId: z.string().optional().describe("Optional parent issue ID. When provided, every created issue is linked to it with a child_of dependency."),
      issues: z.array(issueInputSchema).describe("Array of issue payloads"),
      dependencies: z.array(dependencyInputSchema).optional().describe("Dependency edges between the issues being created, by 0-based index. Committed in the SAME transaction as the issues — seed a fan-out epic atomically so a builder never launches against a ticket whose blocker edge isn't persisted yet."),
    },
    async ({ projectId, parentIssueId, issues, dependencies }) => {
      let pid = projectId;
      if (!pid) {
        const pref = await db
          .select({ value: schema.preferences.value })
          .from(schema.preferences)
          .where(eq(schema.preferences.key, "activeProjectId"))
          .limit(1);
        if (pref.length === 0 || !pref[0].value) {
          return { content: [{ type: "text" as const, text: "No active project. Run `pnpm cli -- register <path>` first." }] };
        }
        pid = pref[0].value;
      }

      const statuses = await db.select().from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.projectId, pid))
        .orderBy(schema.projectStatuses.sortOrder);
      if (statuses.length === 0) {
        return { content: [{ type: "text" as const, text: "No statuses configured for project" }] };
      }

      for (let i = 0; i < issues.length; i++) {
        if (!issues[i].title?.trim()) {
          return { content: [{ type: "text" as const, text: `Error: issues[${i}].title is required` }] };
        }
        if (issues[i].statusName && !statuses.find(s => s.name === issues[i].statusName)) {
          return { content: [{ type: "text" as const, text: `Error: issues[${i}].statusName '${issues[i].statusName}' not found` }] };
        }
      }

      const edges = dependencies ?? [];
      const DIRECTIONAL = new Set<string>(["depends_on", "blocked_by", "parent_of", "child_of"]);
      // Adjacency over array indices for intra-batch cycle detection. Only the
      // directional edge types can form a meaningful cycle.
      const adj = new Map<number, Set<number>>();
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.issueIndex < 0 || e.issueIndex >= issues.length) {
          return { content: [{ type: "text" as const, text: `Error: dependencies[${i}].issueIndex ${e.issueIndex} out of range (0..${issues.length - 1})` }] };
        }
        if (e.dependsOnIndex < 0 || e.dependsOnIndex >= issues.length) {
          return { content: [{ type: "text" as const, text: `Error: dependencies[${i}].dependsOnIndex ${e.dependsOnIndex} out of range (0..${issues.length - 1})` }] };
        }
        if (e.issueIndex === e.dependsOnIndex) {
          return { content: [{ type: "text" as const, text: `Error: dependencies[${i}]: an issue cannot depend on itself` }] };
        }
        const type = e.type ?? "depends_on";
        if (DIRECTIONAL.has(type)) {
          let set = adj.get(e.issueIndex);
          if (!set) { set = new Set(); adj.set(e.issueIndex, set); }
          set.add(e.dependsOnIndex);
        }
      }
      // Cycle detection across the directional edges of the batch.
      const hasPath = (from: number, to: number): boolean => {
        const visited = new Set<number>();
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
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const type = e.type ?? "depends_on";
        if (DIRECTIONAL.has(type) && hasPath(e.dependsOnIndex, e.issueIndex)) {
          return { content: [{ type: "text" as const, text: `Error: dependencies[${i}]: would create a cycle (issue ${e.issueIndex} -> ${e.dependsOnIndex})` }] };
        }
      }

      if (parentIssueId) {
        const parent = await db
          .select({ projectId: schema.issues.projectId })
          .from(schema.issues)
          .where(eq(schema.issues.id, parentIssueId))
          .limit(1);
        if (parent.length === 0) {
          return { content: [{ type: "text" as const, text: `Error: parent issue not found: ${parentIssueId}` }] };
        }
        if (parent[0].projectId !== pid) {
          return { content: [{ type: "text" as const, text: "Error: parent issue must be in the same project" }] };
        }
      }

      let nextNumber = await nextIssueNumber(db, schema, pid);

      const now = new Date().toISOString();
      const created: { id: string; issueNumber: number; title: string }[] = [];

      await db.transaction(async (tx) => {
        const idByIndex: string[] = [];
        for (const input of issues) {
          const id = randomUUID();
          const statusId = input.statusName
            ? statuses.find(s => s.name === input.statusName)!.id
            : statuses[0].id;
          const issueNumber = nextNumber++;
          await tx.insert(schema.issues).values({
            id,
            issueNumber,
            title: input.title,
            description: input.description ?? null,
            priority: input.priority ?? "medium",
            issueType: input.issueType ?? "task",
            sortOrder: input.sortOrder ?? 0,
            estimate: input.estimate ?? null,
            statusId,
            projectId: pid!,
            createdAt: now,
            updatedAt: now,
          });
          if (parentIssueId) {
            await tx.insert(schema.issueDependencies).values({
              id: randomUUID(),
              issueId: id,
              dependsOnId: parentIssueId,
              type: "child_of",
              createdAt: now,
            });
          }
          idByIndex.push(id);
          created.push({ id, issueNumber, title: input.title });
        }

        // Seed dependency edges in the SAME transaction as the issues, so the
        // monitor can never observe a ticket before its blocker edge exists (#765).
        for (const e of edges) {
          await tx.insert(schema.issueDependencies).values({
            id: randomUUID(),
            issueId: idByIndex[e.issueIndex],
            dependsOnId: idByIndex[e.dependsOnIndex],
            type: e.type ?? "depends_on",
            createdAt: now,
          });
        }
      });

      notifyBoard(pid, "mcp_create_issues_batch");
      if (parentIssueId || edges.length > 0) notifyBoard(pid, "mcp_dependency_added");

      return { content: [{ type: "text" as const, text: JSON.stringify({ issues: created, dependenciesCreated: edges.length }, null, 2) }] };
    },
  );
}
