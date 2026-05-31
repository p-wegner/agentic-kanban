import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  listOpenSpecs,
  showOpenSpec,
  validateOpenSpecChange,
} from "@agentic-kanban/shared/lib/openspec";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity } from "../db-utils.js";

async function resolveRepoPath(projectId: string, deps: ToolDeps): Promise<string | null> {
  const rows = await deps.db.select({
    id: deps.schema.projects.id,
    repoPath: deps.schema.projects.repoPath,
  })
    .from(deps.schema.projects)
    .where(eq(deps.schema.projects.id, projectId))
    .limit(1);
  const result = requireEntity(rows, projectId, "Project");
  if (!result.ok) return null;
  return result.value.repoPath;
}

export function registerOpenSpecListSpecs(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "openspec_list_specs",
    "List the living OpenSpec domains for a project. Use this before answering project architecture or behavior questions from specs.",
    {
      projectId: z.string().describe("The project ID"),
    },
    async ({ projectId }) => {
      const repoPath = await resolveRepoPath(projectId, deps);
      if (!repoPath) return { content: [{ type: "text" as const, text: "Project not found" }] };
      const specs = await listOpenSpecs(repoPath);
      return { content: [{ type: "text" as const, text: JSON.stringify({ specs }, null, 2) }] };
    },
  );
}

export function registerShowSpec(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "show_spec",
    "Show a living OpenSpec domain spec for a project. Butler answers about how the project works should cite this content when applicable.",
    {
      projectId: z.string().describe("The project ID"),
      domain: z.string().describe("The spec domain, e.g. butler-context or workspace-merge"),
    },
    async ({ projectId, domain }) => {
      const repoPath = await resolveRepoPath(projectId, deps);
      if (!repoPath) return { content: [{ type: "text" as const, text: "Project not found" }] };
      try {
        const spec = await showOpenSpec(repoPath, domain);
        return { content: [{ type: "text" as const, text: JSON.stringify(spec, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
      }
    },
  );
}

export function registerValidateChange(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "validate_change",
    "Validate OpenSpec change deltas under openspec/changes. Checks ADDED/MODIFIED/REMOVED sections and warns about same-domain delta collisions.",
    {
      projectId: z.string().describe("The project ID"),
      changeId: z.string().optional().describe("Optional openspec/changes/<changeId> folder to validate. Omit to validate all deltas."),
    },
    async ({ projectId, changeId }) => {
      const repoPath = await resolveRepoPath(projectId, deps);
      if (!repoPath) return { content: [{ type: "text" as const, text: "Project not found" }] };
      const result = await validateOpenSpecChange(repoPath, changeId);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
