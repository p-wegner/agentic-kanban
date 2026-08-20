import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall, butlerQuery } from "../butler-api.js";
import type { ButlerAskResponse } from "@agentic-kanban/shared/types";

export function registerAskButler(server: McpServer) {
  server.tool(
    "ask_butler",
    "Ask the project butler — a warm, persistent Claude assistant running in the project's repo — a question and get its answer back. Use for quick questions about the project, codebase, or board without spawning a new workspace. Maintains conversation context across calls.",
    {
      projectId: z.string().describe("The project ID"),
      question: z.string().describe("The question to ask the butler"),
      butler: z.string().optional().describe("Which butler to ask (definition id, e.g. \"smart\"). Defaults to the project's default butler. List available butlers via GET /api/butler-definitions."),
    },
    async ({ projectId, question, butler }) => {
      // `render`: this tool answers with the butler's REPLY TEXT, not the JSON envelope
      // every other butler tool returns.
      return await butlerCall("Butler", `/api/projects/${projectId}/butler/ask${butlerQuery(butler)}`, {
        method: "POST",
        body: JSON.stringify({ content: question }),
      }, { render: (data) => String((data as ButlerAskResponse).text ?? "") });
    },
  );
}
