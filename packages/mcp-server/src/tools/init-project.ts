import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText } from "../board-call.js";
import { mcpError } from "../db-utils.js";
import { getServerPort } from "../server-url.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * init_project mirrors CLI `init [path]`.
 *
 * The init command's primary job (ensureDataDir + runMigrations + seed) is inherently a
 * host-setup operation that the server already performs on startup — by the time the MCP
 * server is running, migrations and seeding have already happened. What remains useful from
 * an MCP context is registering a new project repo. This tool delegates to the running
 * server's REST API (`POST /api/projects`) which calls the same `registerProject` service
 * used by the CLI's `register` and `init` commands.
 *
 * Limitation: if the server is not running (i.e. you're trying to do true first-time init
 * without a server), this tool cannot help — use the CLI `agentic-kanban init` instead.
 */
export function registerInitProject(server: McpServer) {
  server.tool(
    "init_project",
    "Initialize and register a git repository as a project on the kanban board. Mirrors CLI `init [path]`. The server must already be running (the MCP server itself being active satisfies this). If no path is provided, only confirms the server is reachable and migrations are up to date.",
    {
      repoPath: z.string().optional().describe("Absolute path to a git repository to register as a project. Omit to skip project registration and only confirm the board is initialized."),
      name: z.string().optional().describe("Custom project name (defaults to the repository directory name)"),
    },
    async ({ repoPath, name }) => {
      const port = getServerPort();

      if (!repoPath) {
        // Just confirm the server is reachable
        try {
          const { ok, status, statusText, data: projects } = await boardApi("/api/projects");
          if (!ok) {
            return mcpText(`Server reachable but returned ${status}: ${statusText}`);
          }
          return mcpText(JSON.stringify({
            ok: true,
            message: "Board is initialized and server is running.",
            projectCount: Array.isArray(projects) ? projects.length : "unknown",
          }));
        } catch (err) {
          return mcpText(`Cannot reach board server on port ${port}. Is the server running? Error: ${errorMessage(err)}`);
        }
      }

      // Register a project via the server API
      try {
        const body: Record<string, string> = { repoPath };
        if (name) body.name = name;

        const { ok, statusText, data } = await boardApi("/api/projects", {
          method: "POST",
          body: JSON.stringify(body),
        });

        if (!ok) {
          return mcpError(`Error registering project: ${boardErrorText(data, statusText)}`);
        }

        return mcpJson({ ok: true, project: data });
      } catch (err) {
        return mcpText(`Failed to register project (is the server running on port ${port}?): ${errorMessage(err)}`);
      }
    },
  );
}
