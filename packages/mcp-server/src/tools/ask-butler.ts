import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;

interface AskResponse {
  sessionId: string | null;
  text: string;
  isError: boolean;
  error?: string;
}

export function registerAskButler(server: McpServer) {
  server.tool(
    "ask_butler",
    "Ask the project butler — a warm, persistent Claude assistant running in the project's repo — a question and get its answer back. Use for quick questions about the project, codebase, or board without spawning a new workspace. Maintains conversation context across calls.",
    {
      projectId: z.string().describe("The project ID"),
      question: z.string().describe("The question to ask the butler"),
    },
    async ({ projectId, question }) => {
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/projects/${projectId}/butler/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: question }),
        });
        const data = (await res.json()) as AskResponse;
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler error: ${data.error ?? res.statusText}` }] };
        }
        return { content: [{ type: "text" as const, text: String(data.text ?? "") }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to reach the butler (is the server running on port ${SERVER_PORT}?): ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
