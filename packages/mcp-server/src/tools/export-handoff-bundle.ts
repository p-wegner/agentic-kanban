import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiUrl } from "../server-url.js";

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
        const url = boardApiUrl(`/api/workspaces/${workspaceId}/handoff-bundle${format === "markdown" ? "?format=markdown" : ""}`);
        const res = await fetch(url);

        if (!res.ok) {
          let errorText = res.statusText;
          try {
            const data = await res.json() as Record<string, unknown>;
            errorText = String(data.error ?? res.statusText);
          } catch { /* ignore parse failure */ }
          return { content: [{ type: "text" as const, text: `Export failed: ${errorText}` }] };
        }

        const text = await res.text();
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Export failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
