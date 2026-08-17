import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall } from "../butler-api.js";

// #508: `ButlerEntry` existed only to type the `await res.json()` this tool no longer
// does. It never constrained the output — the body was passed straight to
// JSON.stringify — so it documented a shape rather than enforcing one.

export function registerButlerList(server: McpServer) {
  server.tool(
    "butler_list",
    "List all defined butlers and their per-project runtime state (warm/stopped, session id). Equivalent to CLI `butler list`.",
    {
      projectId: z.string().describe("The project ID"),
    },
    async ({ projectId }) => {
      // The array guard this tool needed (a successful body is a JSON ARRAY, so reading
      // `.error` off it is wrong) now lives in the shared helper, so every tool has it.
      return await butlerCall("Butler list", `/api/projects/${projectId}/butlers`, undefined, { pretty: true });
    },
  );
}
