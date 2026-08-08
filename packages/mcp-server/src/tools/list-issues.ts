import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, inArray, and } from "drizzle-orm";
import { isResolvedDependencyStatusView } from "@agentic-kanban/shared";
import { prodDeps, type ToolDeps } from "./deps.js";

export function registerListIssues(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "list_issues",
    "List issues for a project, optionally filtered by status name, priority, tag, blocked status, or issue number. "
      + "Descriptions are OMITTED by default — use get_issue for one issue's full text, or pass includeDescription "
      + "when you genuinely need every description at once.",
    {
      projectId: z.string().describe("The project ID"),
      status: z.string().optional().describe("Filter by status name (e.g., 'Todo', 'In Progress')"),
      priority: z.string().optional().describe("Filter by priority (low, medium, high, critical)"),
      tag: z.string().optional().describe("Filter by tag name (e.g., 'bug', 'feature')"),
      blocked: z.boolean().optional().describe("Filter by blocked status (true = only blocked, false = only unblocked)"),
      issueNumber: z.number().optional().describe("Filter by issue number (e.g., 42)"),
      includeDescription: z.boolean().optional().describe(
        "Include each issue's full description. Off by default: descriptions are ~70% of the payload "
        + "(509 KB across 323 issues on a mature project) and this tool's output goes straight into an "
        + "agent's context. Prefer get_issue for the one issue you actually need.",
      ),
    },
    async ({ projectId, status, priority, tag, blocked, issueNumber, includeDescription }) => {
      // #344: `description` used to be selected unconditionally. On the dev project that is
      // 509 KB of description text across 323 issues — ~70% of the payload — and unlike the
      // HTTP route (where a `slim=1` opt-in existed but no ecosystem consumer passed it),
      // this tool's output is serialized into an AGENT'S CONTEXT on every call. Listing is
      // for finding an issue; reading one is what get_issue is for. Kept recoverable via an
      // explicit opt-in rather than removed, so nothing that truly needs it is stranded.
      const query = db.select({
        id: schema.issues.id,
        issueNumber: schema.issues.issueNumber,
        title: schema.issues.title,
        ...(includeDescription ? { description: schema.issues.description } : {}),
        priority: schema.issues.priority,
        sortOrder: schema.issues.sortOrder,
        statusId: schema.issues.statusId,
        projectId: schema.issues.projectId,
        createdAt: schema.issues.createdAt,
        updatedAt: schema.issues.updatedAt,
        statusName: schema.projectStatuses.name,
      })
        .from(schema.issues)
        .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
        .where(issueNumber !== undefined
          ? and(eq(schema.issues.projectId, projectId), eq(schema.issues.issueNumber, issueNumber))
          : eq(schema.issues.projectId, projectId));

      let results = await query;

      if (tag) {
        const matchingIssueIds = (await db
          .select({ issueId: schema.issueTags.issueId })
          .from(schema.issueTags)
          .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
          .where(eq(schema.tags.name, tag))
        ).map(r => r.issueId);

        const matchingSet = new Set(matchingIssueIds);
        results = results.filter(i => matchingSet.has(i.id));
      }

      if (status) {
        results = results.filter(i => i.statusName === status);
      }
      if (priority) {
        results = results.filter(i => i.priority === priority);
      }

      if (blocked !== undefined) {
        const issueIds = results.map(i => i.id);
        const depRows = issueIds.length > 0 ? await db
          .select({ issueId: schema.issueDependencies.issueId, dependsOnId: schema.issueDependencies.dependsOnId, type: schema.issueDependencies.type })
          .from(schema.issueDependencies)
          .where(inArray(schema.issueDependencies.issueId, issueIds)) : [];

        const dependsOnIds = [...new Set(depRows.map(d => d.dependsOnId))];
        const depStatusMap = new Map<string, { currentNodeId: string | null; currentNodeType: string | null; statusName: string }>();

        if (dependsOnIds.length > 0) {
          const depStatuses = await db
            .select({
              id: schema.issues.id,
              currentNodeId: schema.issues.currentNodeId,
              currentNodeType: schema.workflowNodes.nodeType,
              statusName: schema.projectStatuses.name,
            })
            .from(schema.issues)
            .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
            .leftJoin(schema.workflowNodes, eq(schema.issues.currentNodeId, schema.workflowNodes.id))
            .where(inArray(schema.issues.id, dependsOnIds));
          for (const ds of depStatuses) depStatusMap.set(ds.id, ds);
        }

        const blockedSet = new Set<string>();
        for (const dep of depRows) {
          const isBlockingType = dep.type === "depends_on" || dep.type === "blocked_by";
          if (!isBlockingType) continue;
          const blocker = depStatusMap.get(dep.dependsOnId);
          if (blocker && isResolvedDependencyStatusView(blocker)) continue;
          blockedSet.add(dep.issueId);
        }

        results = results.filter(i => blocked ? blockedSet.has(i.id) : !blockedSet.has(i.id));
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );
}
