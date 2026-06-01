import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiUrl } from "../server-url.js";

const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 120_000;

export function registerApproveToolUse(server: McpServer) {
  server.tool(
    "approve_tool_use",
    "Internal tool used by Claude Code's --permission-prompt-tool flag. Routes tool approval requests to the agentic-kanban UI for user approval. Returns allow/deny/allow_session/deny_session.",
    {
      tool_name: z.string().describe("The tool Claude wants to use"),
      tool_input: z.record(z.unknown()).describe("The input Claude wants to pass to the tool"),
    },
    async ({ tool_name, tool_input }, extra) => {
      // Get the session ID from the MCP meta (injected by Claude Code)
      const sessionId = (extra as any)?.sessionId ?? "unknown";

      // Create a pending approval on the kanban server
      let approvalId: string;
      try {
        const res = await fetch(boardApiUrl("/api/approvals"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, toolName: tool_name, toolInput: tool_input }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { id: string };
        approvalId = data.id;
      } catch (err) {
        // If server is unreachable, deny by default
        return { content: [{ type: "text" as const, text: "deny" }] };
      }

      // Poll until resolved or timeout
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const res = await fetch(boardApiUrl(`/api/approvals/${approvalId}`));
          if (res.ok) {
            const data = await res.json() as { decision: string | null };
            if (data.decision) {
              // Clean up and return
              fetch(boardApiUrl(`/api/approvals/${approvalId}`), { method: "DELETE" }).catch(() => {});
              return { content: [{ type: "text" as const, text: data.decision }] };
            }
          }
        } catch {
          // transient — keep polling
        }
      }

      // Timed out — deny and clean up
      fetch(boardApiUrl(`/api/approvals/${approvalId}`), { method: "DELETE" }).catch(() => {});
      return { content: [{ type: "text" as const, text: "deny" }] };
    },
  );
}
