import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpJson, mcpText, nextIssueNumber, resolveActiveProjectId, resolveProjectName } from "../db-utils.js";

const issueInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  issueType: z.string().optional(),
  estimate: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  statusName: z.string().optional(),
  tags: z.array(z.string()).optional().describe("Tag names to assign to this issue (e.g. ['no-auto-start']). Unknown tags are created on the fly; matching is case-insensitive."),
});

const DEPENDENCY_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of", "coupled_with"] as const;

/**
 * A dependency edge seeded alongside the batch. Endpoints reference the
 * just-created issues by their 0-based index in the `issues` array, since the
 * issue IDs are generated inside this call and not yet known to the caller.
 */
const dependencyInputSchema = z.object({
  issueIndex: z.number().int().describe("0-based index into the `issues` array — the dependent issue"),
  dependsOnIndex: z.number().int().describe("0-based index into the `issues` array — the issue it depends on / is blocked by"),
  type: z.enum(DEPENDENCY_TYPES).optional().describe("Edge type (default depends_on). Use 'coupled_with' to DECLARE that two slices touch the same code and are best implemented together — a generating agent should emit this for coupled vertical slices it knowingly creates, so the monitor can contract them before they fan out into conflicting workspaces (#918)."),
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
      const rpid = await resolveActiveProjectId(db, schema, projectId);
      if (!rpid.ok) return rpid.error;
      const pid = rpid.projectId;

      const statuses = await db.select().from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.projectId, pid))
        .orderBy(schema.projectStatuses.sortOrder);
      if (statuses.length === 0) {
        return mcpText("No statuses configured for project");
      }

      for (let i = 0; i < issues.length; i++) {
        if (!issues[i].title?.trim()) {
          return mcpText(`Error: issues[${i}].title is required`);
        }
        if (issues[i].statusName && !statuses.find(s => s.name === issues[i].statusName)) {
          return mcpText(`Error: issues[${i}].statusName '${issues[i].statusName}' not found`);
        }
      }

      const edges = dependencies ?? [];
      const DIRECTIONAL = new Set<string>(["depends_on", "blocked_by", "parent_of", "child_of"]);
      // Adjacency over array indices for intra-batch cycle detection. Only the
      // directional edge types can form a meaningful cycle.
      const adj = new Map<number, Set<number>>();
      // Tracks (issueIndex, dependsOnIndex, type) seen so far so a redundant edge
      // is rejected up-front with a clear message rather than blowing up the
      // transaction on the `issue_dependencies_unique` constraint (mirrors
      // add_dependency's "already exists" handling).
      const seenEdges = new Set<string>();
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.issueIndex < 0 || e.issueIndex >= issues.length) {
          return mcpText(`Error: dependencies[${i}].issueIndex ${e.issueIndex} out of range (0..${issues.length - 1})`);
        }
        if (e.dependsOnIndex < 0 || e.dependsOnIndex >= issues.length) {
          return mcpText(`Error: dependencies[${i}].dependsOnIndex ${e.dependsOnIndex} out of range (0..${issues.length - 1})`);
        }
        if (e.issueIndex === e.dependsOnIndex) {
          return mcpText(`Error: dependencies[${i}]: an issue cannot depend on itself`);
        }
        const type = e.type ?? "depends_on";
        const key = `${e.issueIndex} ${e.dependsOnIndex} ${type}`;
        if (seenEdges.has(key)) {
          return mcpText(`Error: dependencies[${i}]: duplicate edge (issue ${e.issueIndex} -> ${e.dependsOnIndex}, type ${type})`);
        }
        seenEdges.add(key);
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
          return mcpText(`Error: dependencies[${i}]: would create a cycle (issue ${e.issueIndex} -> ${e.dependsOnIndex})`);
        }
      }

      if (parentIssueId) {
        const parent = await db
          .select({ projectId: schema.issues.projectId })
          .from(schema.issues)
          .where(eq(schema.issues.id, parentIssueId))
          .limit(1);
        if (parent.length === 0) {
          return mcpText(`Error: parent issue not found: ${parentIssueId}`);
        }
        if (parent[0].projectId !== pid) {
          return mcpText("Error: parent issue must be in the same project");
        }
      }

      let nextNumber = await nextIssueNumber(db, schema, pid);

      const now = new Date().toISOString();
      const created: { id: string; issueNumber: number; title: string }[] = [];

      await db.transaction(async (tx) => {
        // Resolve tag names to ids once for the whole batch, creating any that
        // don't exist yet. Case-insensitive match mirrors the tag repository's
        // findTagByName so "no-auto-start" lands on the seeded builtin tag
        // instead of spawning a duplicate.
        const tagIdByName = new Map<string, string>();
        const resolveTagId = async (name: string): Promise<string> => {
          const key = name.toLowerCase();
          const cached = tagIdByName.get(key);
          if (cached) return cached;
          const existing = await tx.select({ id: schema.tags.id }).from(schema.tags)
            .where(sql`lower(${schema.tags.name}) = lower(${name})`)
            .limit(1);
          let tagId: string;
          if (existing.length > 0) {
            tagId = existing[0].id;
          } else {
            tagId = randomUUID();
            await tx.insert(schema.tags).values({ id: tagId, name, color: null, createdAt: now });
          }
          tagIdByName.set(key, tagId);
          return tagId;
        };

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
            projectId: pid,
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
          // Assign tags by name, deduped per issue, in the same transaction so a
          // batch-created ticket carries its tags (e.g. no-auto-start) atomically
          // — fixes builders launching against a meta ticket whose tag was dropped.
          if (input.tags && input.tags.length > 0) {
            const seenTagIds = new Set<string>();
            for (const tagName of input.tags) {
              const trimmed = tagName.trim();
              if (!trimmed) continue;
              const tagId = await resolveTagId(trimmed);
              if (seenTagIds.has(tagId)) continue;
              seenTagIds.add(tagId);
              await tx.insert(schema.issueTags).values({ id: randomUUID(), issueId: id, tagId });
            }
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

      // Echo the RESOLVED project (#335): a batch is the most expensive thing to
      // mis-file, so the response names the board the issues landed in.
      const projectName = await resolveProjectName(db, schema, pid);

      return mcpJson({ issues: created, dependenciesCreated: edges.length, projectId: pid, projectName });
    },
  );
}
