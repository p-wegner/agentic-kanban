import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpText, requireEntity } from "../db-utils.js";

export function registerGetWorkspaceScorecard(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "get_workspace_scorecard",
    "Get the PR quality scorecard for a workspace. Returns a 0-100 score with per-dimension breakdown (Tests, Types, Scope, Diff size, Conflicts, Docs, Skill output).",
    {
      workspaceId: z.string().describe("The workspace ID"),
    },
    async ({ workspaceId }) => {
      // #815: the scorecard artifact moved off `workspaces` into `workspace_scorecard`.
      // Aliased back to the same three field names, so everything below is untouched.
      // LEFT, not inner, and written inline because mcp-server cannot import server code: an
      // inner join would turn "not yet computed" into "Workspace not found", which is a
      // different (and wrong) answer — the not-computed message below is the right one.
      const wsRows = await db.select({
        id: schema.workspaces.id,
        scorecardScore: schema.workspaceScorecard.score,
        scorecardJson: schema.workspaceScorecard.json,
        scorecardComputedAt: schema.workspaceScorecard.computedAt,
      }).from(schema.workspaces)
        .leftJoin(schema.workspaceScorecard, eq(schema.workspaceScorecard.workspaceId, schema.workspaces.id))
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);

      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;
      const ws = r.value;

      if (ws.scorecardScore === null || !ws.scorecardJson) {
        return mcpText("Scorecard not yet computed for this workspace. It will be computed after the next session ends, or you can call POST /api/workspaces/:id/scorecard/refresh.");
      }

      let dimensions: unknown[] = [];
      try {
        dimensions = JSON.parse(ws.scorecardJson) as unknown[];
      } catch {
        // Ignore malformed JSON and return the total score only.
      }

      const grade = ws.scorecardScore >= 80 ? "🟢 GOOD" : ws.scorecardScore >= 60 ? "🟡 FAIR" : "🔴 POOR";
      const lines = [
        "# PR Quality Scorecard",
        `**Score: ${ws.scorecardScore}/100** ${grade}`,
        `_Computed: ${ws.scorecardComputedAt}_`,
        "",
        "## Dimensions",
        ...(dimensions as { name: string; score: number; maxScore: number; signal: string }[]).map(
          (dimension) => `- **${dimension.name}**: ${dimension.score}/${dimension.maxScore} — ${dimension.signal}`,
        ),
      ];

      return mcpText(lines.join("\n"));
    },
  );
}
