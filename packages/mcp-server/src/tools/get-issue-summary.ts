import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadIssueSummary } from "@agentic-kanban/shared/lib/issue-summary";
import { mcpError, mcpJson, mcpText, resolveActiveProjectId } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * #506: takes injected `ToolDeps` like its sibling tools instead of importing the
 * module-level `db`/`schema` singletons. It was the only reason this tool had no tests —
 * the harness could not give it a seeded database, so the cross-project resolution bug it
 * carried had no way to be caught.
 *
 * The six-step chain it used to implement inline now lives in
 * `shared/lib/issue-summary.ts`, shared with the REST repository and the CLI. That also
 * gives this tool the CLI's session-selection policy, which it never had: it took
 * `find(completed|stopped) ?? rows[0]` and so would report a board-monitor session as the
 * agent's work on the ticket.
 */
export function registerGetIssueSummary(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "get_issue_summary",
    "Get a summary of the latest completed agent session for an issue. Resolves issue number → workspace → latest session → parsed summary in one call. Shows agent summary text, files touched, commands run, duration, cost, and key excerpts. Complements get_board_status (live state) with completed-work history.",
    {
      issueNumber: z.number().describe("The issue number (e.g. 1, 2, 3)"),
      projectId: z.string().optional().describe("Project ID — defaults to the active project. Issue numbers are per-project, so an unscoped number is ambiguous."),
    },
    async ({ issueNumber, projectId }) => {
      try {
        // Scope the number to a project (#506). Issue numbers are per-project
        // (`MAX(issue_number) + 1`), so an unscoped `where(issueNumber = N)` matched a row
        // in every project that had reached N — verified live on a 25-project board, where
        // issue #5 resolved to a fixture project rather than the active one. Precedence
        // matches get_issue: explicit projectId > active project > unscoped. The unscoped
        // tail keeps a no-active-project board working exactly as before.
        const resolution = await resolveActiveProjectId(db, schema, projectId);
        const result = await loadIssueSummary(db, {
          issueNumber,
          projectId: resolution.ok ? resolution.projectId : undefined,
        });

        if (!result) {
          return mcpText(`Issue #${issueNumber} not found`);
        }

        return mcpJson(result);
      } catch (err) {
        return mcpError(`Error: ${errorMessage(err)}`);
      }
    },
  );
}
