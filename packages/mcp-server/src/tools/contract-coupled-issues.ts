import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray, ne } from "drizzle-orm";
import { planContraction, resolveCoupledComponent } from "@agentic-kanban/shared/lib/dependency-graph";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { prodDeps, type ToolDeps } from "./deps.js";
import { applyUpdateDependenciesBatch } from "./update-dependencies-batch.js";
import { mcpError, mcpJson } from "../db-utils.js";

type ContractIssueRow = {
  id: string;
  issueNumber: number | null;
  title: string;
  description: string | null;
};

function issueRef(issueNumber: number | null): string {
  return issueNumber === null ? "unnumbered" : `#${issueNumber}`;
}

function compareIssueNumber(a: number | null, b: number | null): number {
  return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
}

function contractPointer(leadIssueNumber: number | null): string {
  return `> Absorbed into ${issueRef(leadIssueNumber)} - combined into one coupled ticket.`;
}

function buildCombinedDescription(leadId: string, members: ContractIssueRow[]): string {
  const sorted = [...members].sort((a, b) => {
    if (a.id === leadId) return -1;
    if (b.id === leadId) return 1;
    return compareIssueNumber(a.issueNumber, b.issueNumber);
  });
  return [
    "## Combined Coupled Ticket Sources",
    "",
    ...sorted.map((member) => [
      `### From ${issueRef(member.issueNumber)}: ${member.title}`,
      "",
      member.description?.trim() || "(no description)",
    ].join("\n")),
  ].join("\n");
}

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
        return mcpError("Error: leadIssueId must be included in issueIds");
      }

      const issueRows = await db
        .select({
          id: schema.issues.id,
          issueNumber: schema.issues.issueNumber,
          title: schema.issues.title,
          description: schema.issues.description,
          statusId: schema.issues.statusId,
          projectId: schema.issues.projectId,
        })
        .from(schema.issues)
        .where(inArray(schema.issues.id, uniqueIssueIds));
      if (issueRows.length !== uniqueIssueIds.length) {
        return mcpError("Error: one or more issues were not found");
      }

      const projectIds = new Set(issueRows.map((row) => row.projectId));
      if (projectIds.size !== 1) {
        return mcpError("Error: cannot contract issues across projects");
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
        return mcpError("Error: selected issues are not a coupled component");
      }

      const selected = new Set(uniqueIssueIds);
      const missing = [...component].filter((id) => !selected.has(id));
      const extra = uniqueIssueIds.filter((id) => !component.has(id));
      if (missing.length > 0 || extra.length > 0) {
        return mcpError("Error: issueIds must exactly match the lead issue's coupled component");
      }

      const openWorkspaces = await db
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(and(inArray(schema.workspaces.issueId, [...component]), ne(schema.workspaces.status, "closed")));
      if (openWorkspaces.length > 0) {
        return mcpError("Error: cannot contract a component with open workspaces");
      }

      const leadIssue = issueRows.find((row) => row.id === leadId);
      if (!leadIssue) {
        return mcpError("Error: leadIssueId must be included in issueIds");
      }
      const absorbedIssueIds = issueRows
        .filter((row) => row.id !== leadId)
        .sort((a, b) => compareIssueNumber(a.issueNumber, b.issueNumber))
        .map((row) => row.id);

      const terminalStatuses = await db
        .select({ id: schema.projectStatuses.id, name: schema.projectStatuses.name })
        .from(schema.projectStatuses)
        .where(and(
          eq(schema.projectStatuses.projectId, projectId),
          inArray(schema.projectStatuses.name, ["Cancelled", "Done"]),
        ));
      const terminalStatusId =
        terminalStatuses.find((status) => status.name === "Cancelled")?.id ??
        terminalStatuses.find((status) => status.name === "Done")?.id;
      if (!terminalStatusId) {
        return mcpError("Error: project must have a Cancelled or Done status to absorb issues");
      }

      const mutations = [
        ...planContraction(leadId, component, edges),
        ...absorbedIssueIds.map((id) => ({
          issueId: id,
          dependsOnId: leadId,
          type: "duplicates",
          action: "add" as const,
        })),
      ];
      const result = await applyUpdateDependenciesBatch(deps, mutations);
      if (!result.ok) {
        return mcpError(`Error: ${result.message}`);
      }

      const now = new Date().toISOString();
      await db.update(schema.issues)
        .set({ title: leadIssue.title, description: buildCombinedDescription(leadId, issueRows), updatedAt: now })
        .where(eq(schema.issues.id, leadId));
      for (const id of absorbedIssueIds) {
        const absorbed = issueRows.find((row) => row.id === id);
        const nextDescription = [
          absorbed?.description?.trim() || "",
          contractPointer(leadIssue.issueNumber),
        ].filter(Boolean).join("\n\n");
        // #501: the description is a plain column write, but the terminal status must go
        // through the transition authority so the workflow current-node is synced with it
        // — absorbing an issue is exactly the case where a stale currentNodeId would make
        // dependency resolution treat a closed issue as still open (#537).
        await db.update(schema.issues)
          .set({ description: nextDescription, updatedAt: now })
          .where(eq(schema.issues.id, id));
        await transitionIssueStatus(db, id, terminalStatusId, { now });
      }
      deps.notifyBoard(projectId, "mcp_issue_updated");

      return mcpJson({
            leadIssueId: leadId,
            memberIssueIds: [...component],
            mutations,
            added: result.added,
            removed: result.removed,
            absorbedIssueIds,
            skipped: result.skipped,
          });
    },
  );
}
