import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { isResolvedDependencyStatusView } from "@agentic-kanban/shared";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpJson, requireEntity, resolveActiveProjectId } from "../db-utils.js";

export function registerGetIssue(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "get_issue",
    "Get detailed information about a specific issue, including workspaces and dependencies. Accepts either a UUID issue ID or a numeric issue number (e.g. 42). When resolving by number, pass projectId to scope to the correct project.",
    {
      issueId: z.string().describe("The issue ID (UUID) or issue number (e.g. '42')"),
      projectId: z.string().optional().describe("Project ID — required when resolving by issue number to avoid cross-project ambiguity"),
    },
    async ({ issueId, projectId }) => {
      const isNumeric = /^\d+$/.test(issueId);
      // #506: a numeric ref with no explicit projectId used to fall back to an UNSCOPED
      // lookup, despite this parameter's own description calling it "required ... to avoid
      // cross-project ambiguity". Issue numbers are per-project, so that returned an
      // arbitrary project's issue. Default to the active project, matching the CLI.
      // Resolve the scope for a numeric ref: explicit projectId > active project. When
      // NEITHER exists we fall back to the historical unscoped lookup rather than erroring
      // — a board with no active project is a degenerate state, and turning a previously
      // working call into an error would be a contract change this fix does not need.
      let scopeProjectId = projectId;
      if (isNumeric && !scopeProjectId) {
        const resolved = await resolveActiveProjectId(db, schema);
        if (resolved.ok) scopeProjectId = resolved.projectId;
      }
      const whereClause = isNumeric
        ? (scopeProjectId
            ? and(eq(schema.issues.issueNumber, Number(issueId)), eq(schema.issues.projectId, scopeProjectId))
            : eq(schema.issues.issueNumber, Number(issueId)))
        : eq(schema.issues.id, issueId);

      const issues = await db.select({
        id: schema.issues.id,
        issueNumber: schema.issues.issueNumber,
        title: schema.issues.title,
        description: schema.issues.description,
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
        .where(whereClause)
        .limit(1);

      const r = requireEntity(issues, issueId, "Issue");
      if (!r.ok) return r.error;
      const resolvedId = r.value.id;

      const [workspaces, outgoing, incoming] = await Promise.all([
        db.select().from(schema.workspaces).where(eq(schema.workspaces.issueId, resolvedId)),
        db.select({
          id: schema.issueDependencies.id,
          dependsOnId: schema.issueDependencies.dependsOnId,
          type: schema.issueDependencies.type,
          createdAt: schema.issueDependencies.createdAt,
          issueTitle: schema.issues.title,
          issueStatusName: schema.projectStatuses.name,
          issueCurrentNodeId: schema.issues.currentNodeId,
          issueCurrentNodeType: schema.workflowNodes.nodeType,
          issueNumber: schema.issues.issueNumber,
        })
          .from(schema.issueDependencies)
          .innerJoin(schema.issues, eq(schema.issueDependencies.dependsOnId, schema.issues.id))
          .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
          .leftJoin(schema.workflowNodes, eq(schema.issues.currentNodeId, schema.workflowNodes.id))
          .where(eq(schema.issueDependencies.issueId, resolvedId)),
        db.select({
          id: schema.issueDependencies.id,
          issueId: schema.issueDependencies.issueId,
          type: schema.issueDependencies.type,
          createdAt: schema.issueDependencies.createdAt,
          issueTitle: schema.issues.title,
          issueStatusName: schema.projectStatuses.name,
          issueNumber: schema.issues.issueNumber,
        })
          .from(schema.issueDependencies)
          .innerJoin(schema.issues, eq(schema.issueDependencies.issueId, schema.issues.id))
          .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
          .where(eq(schema.issueDependencies.dependsOnId, resolvedId)),
      ]);

      // An issue is blocked if it has unmet outgoing "depends_on" or "blocked_by" dependencies
      // Only outgoing deps matter — incoming deps mean OTHER issues depend on this one, which
      // doesn't block THIS issue.
      const isBlocked = outgoing.some((dep) => {
        const type = dep.type;
        return (type === "depends_on" || type === "blocked_by") &&
          !isResolvedDependencyStatusView({
            currentNodeId: dep.issueCurrentNodeId,
            currentNodeType: dep.issueCurrentNodeType,
            statusName: dep.issueStatusName,
          });
      });

      const result = {
        ...r.value,
        workspaces,
        dependencies: { outgoing, incoming },
        isBlocked,
      };

      return mcpJson(result);
    },
  );
}
