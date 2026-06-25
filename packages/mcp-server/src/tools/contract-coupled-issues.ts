import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { planContraction, resolveCoupledComponent } from "@agentic-kanban/shared/lib/dependency-graph.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { applyUpdateDependenciesBatch } from "./update-dependencies-batch.js";

export function registerContractCoupledIssues(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "contract_coupled_issues",
    "Contract a full coupled_with connected component onto one lead issue. The selected issueIds must exactly match the component; external sequential dependencies are inherited by the lead and internal coupled_with edges are removed.",
    {
      issueIds: z.array(z.string()).min(1).describe("All issue ids in the coupled_with component to contract"),
      leadIssueId: z.string().optional().describe("Issue id to keep as the lead; defaults to the first issueId"),
    },
    async ({ issueIds, leadIssueId }) => {
      const uniqueIssueIds = [...new Set(issueIds)];
      const leadId = leadIssueId ?? uniqueIssueIds[0];
      if (!leadId || !uniqueIssueIds.includes(leadId)) {
        return { content: [{ type: "text" as const, text: "Error: leadIssueId must be included in issueIds" }] };
      }

      const issueRows = await db
        .select({ id: schema.issues.id, projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(inArray(schema.issues.id, uniqueIssueIds));
      if (issueRows.length !== uniqueIssueIds.length) {
        return { content: [{ type: "text" as const, text: "Error: one or more issues were not found" }] };
      }

      const projectIds = new Set(issueRows.map((row) => row.projectId));
      if (projectIds.size !== 1) {
        return { content: [{ type: "text" as const, text: "Error: cannot contract issues across projects" }] };
      }

      const projectId = issueRows[0].projectId;
      const dependencyRows = await db
        .select({
          issueId: schema.issueDependencies.issueId,
          dependsOnId: schema.issueDependencies.dependsOnId,
          type: schema.issueDependencies.type,
        })
        .from(schema.issueDependencies)
        .innerJoin(schema.issues, eq(schema.issueDependencies.issueId, schema.issues.id))
        .where(eq(schema.issues.projectId, projectId));

      const edges = dependencyRows.map((row) => ({
        from: row.issueId,
        to: row.dependsOnId,
        type: row.type,
      }));
      const component = resolveCoupledComponent(leadId, edges);
      if (component.size < 2) {
        return { content: [{ type: "text" as const, text: "Error: selected issues are not a coupled component" }] };
      }

      const selected = new Set(uniqueIssueIds);
      const missing = [...component].filter((id) => !selected.has(id));
      const extra = uniqueIssueIds.filter((id) => !component.has(id));
      if (missing.length > 0 || extra.length > 0) {
        return { content: [{ type: "text" as const, text: "Error: issueIds must exactly match the lead issue's coupled component" }] };
      }

      const mutations = planContraction(leadId, component, edges);
      const result = await applyUpdateDependenciesBatch(deps, mutations);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${result.message}` }] };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            leadIssueId: leadId,
            memberIssueIds: [...component],
            mutations,
            added: result.added,
            removed: result.removed,
            skipped: result.skipped,
          }, null, 2),
        }],
      };
    },
  );
}
