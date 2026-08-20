import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiText, boardErrorText, mcpText } from "../board-call.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export function registerExportHandoffBundle(server: McpServer) {
  server.tool(
    "export_handoff_bundle",
    "Export a compact handoff bundle for a workspace that is stuck, awaiting review, or being transferred to a human. Returns workspace metadata, issue context, diff stats, agent summary, changed files, errors, and reviewer notes.",
    {
      workspaceId: z.string().describe("The workspace ID to export"),
      format: z.enum(["json", "markdown"]).optional().describe("Output format — json (default) or markdown"),
    },
    async ({ workspaceId, format }) => {
      try {
        const { ok, statusText, text } = await boardApiText(
          `/api/workspaces/${workspaceId}/handoff-bundle${format === "markdown" ? "?format=markdown" : ""}`,
        );

        if (!ok) {
          // The body is markdown on success but JSON on failure, so the error text has to be
          // re-parsed here rather than read off a parsed `data` (#508).
          let parsed: unknown = null;
          try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
          return mcpText(`Export failed: ${boardErrorText(parsed, statusText)}`);
        }

        return mcpText(text);
      } catch (err) {
        return mcpText(`Export failed: ${errorMessage(err)}`);
      }
    },
  );
}
