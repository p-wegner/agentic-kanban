import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerPort } from "../server-url.js";

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
          const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
          if (!res.ok) {
            return {
              content: [{ type: "text" as const, text: `Server reachable but returned ${res.status}: ${res.statusText}` }],
            };
          }
          const projects = await res.json() as unknown[];
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  message: "Board is initialized and server is running.",
                  projectCount: Array.isArray(projects) ? projects.length : "unknown",
                }),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot reach board server on port ${port}. Is the server running? Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      }

      // Register a project via the server API
      try {
        const body: Record<string, string> = { repoPath };
        if (name) body.name = name;

        const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error registering project: ${(data.error as string) ?? res.statusText}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, project: data }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to register project (is the server running on port ${port}?): ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
