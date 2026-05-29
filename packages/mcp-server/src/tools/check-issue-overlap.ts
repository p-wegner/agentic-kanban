import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";

export function registerCheckIssueOverlap(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "check_issue_overlap",
    "Check which files overlap between a set of issues based on their cached touched-file predictions. Returns a map of filePath → [issueIds] for files touched by more than one issue. Run analyze_touched_files on each issue first to populate the cache. Use before launching parallel workspaces to detect conflict risk.",
    {
      issueIds: z.array(z.string()).min(2).describe("List of issue IDs to check for file overlap (at least 2)"),
    },
    async ({ issueIds }) => {
      const rows = await db
        .select({ id: schema.issues.id, touchedFilesJson: schema.issues.touchedFilesJson })
        .from(schema.issues)
        .where(inArray(schema.issues.id, issueIds));

      const overlap: Record<string, string[]> = {};
      for (const row of rows) {
        if (!row.touchedFilesJson) continue;
        let files: { path: string }[];
        try { files = JSON.parse(row.touchedFilesJson); } catch { continue; }
        for (const f of files) {
          if (!f.path) continue;
          if (!overlap[f.path]) overlap[f.path] = [];
          if (!overlap[f.path].includes(row.id)) overlap[f.path].push(row.id);
        }
      }
      for (const path of Object.keys(overlap)) {
        if (overlap[path].length < 2) delete overlap[path];
      }

      const issuesWithoutCache = issueIds.filter(id => !rows.find(r => r.id === id && r.touchedFilesJson));
      const result: Record<string, unknown> = { overlap };
      if (issuesWithoutCache.length > 0) {
        result.warning = `${issuesWithoutCache.length} issue(s) have no cached prediction yet. Run analyze_touched_files on them first: ${issuesWithoutCache.join(", ")}`;
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
