import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { requireEntity } from "../db-utils.js";

export function registerGetWorkspaceScorecard(server: McpServer) {
  server.tool(
    "get_workspace_scorecard",
    "Get the PR quality scorecard for a workspace. Returns a 0-100 score with per-dimension breakdown (Tests, Types, Scope, Diff size, Conflicts, Docs, Skill output).",
    {
      workspaceId: z.string().describe("The workspace ID"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select({
        id: schema.workspaces.id,
        scorecardScore: schema.workspaces.scorecardScore,
        scorecardJson: schema.workspaces.scorecardJson,
        scorecardComputedAt: schema.workspaces.scorecardComputedAt,
      }).from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);

      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;
      const ws = r.value;

      if (ws.scorecardScore === null || !ws.scorecardJson) {
        return {
          content: [{
            type: "text" as const,
            text: "Scorecard not yet computed for this workspace. It will be computed after the next session ends, or you can call POST /api/workspaces/:id/scorecard/refresh.",
          }],
        };
      }

      let dimensions: unknown[] = [];
      try {
        dimensions = JSON.parse(ws.scorecardJson);
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

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
