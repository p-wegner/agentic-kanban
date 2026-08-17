import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveActiveProjectId } from "../db-utils.js";
import { boardApiUrl } from "../server-url.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Backlog Markdown over MCP (docs/backlog-markdown.md). Both tools go through the board's REST
 * routes rather than the DB: import updates issues through the issue service (events, webhooks,
 * status transitions all fire), and export reuses the snapshot machinery.
 */
export const EXPORT_BACKLOG_MARKDOWN_DESCRIPTION =
  "Export a project's backlog as ONE Backlog Markdown document (kanban-md 1: front matter, a `##` section per status, a `###` per issue with a metadata line, description, checklist) — the human-readable, hand-editable twin of the JSON snapshot. Filters: statuses, tags, priorities, types, milestone, q (free text), since (ISO), numbers, includeDone. Returns the markdown text (write it to a file yourself, e.g. BACKLOG.md). Round-trips through import_backlog_markdown.";

export const IMPORT_BACKLOG_MARKDOWN_DESCRIPTION =
  "Import a markdown backlog into a project — the kanban-md standard OR liberal styles (`## Section` + `- [ ] item` lists, `- **Title** — text`, `#12` in titles, `**Priority:** high`, `depends on #3`, `[x]` = done). ALWAYS run with dryRun=true first: it returns a preview (per-row action create/update/unchanged, matched existing issue, field changes, statuses/tags to create, warnings, confidence). If confidence is low (<0.6) or the preview looks wrong, rewrite the file into the standard yourself (see the backlog-markdown skill) and preview again — do not import junk. mode: update (default; matches existing issues by #number for a same-project file, then external key, then title, and updates only fields present in the file — tags/dependencies are added, never removed) or create (everything new, renumbered on collision).";

const filterSchema = {
  projectId: z.string().optional().describe("Project ID (defaults to the active project)"),
  statuses: z.array(z.string()).optional().describe("Status names to include (default: every non-terminal status)"),
  includeDone: z.boolean().optional().describe("Include Done/Cancelled/Archived (default false)"),
  tags: z.array(z.string()).optional(),
  priorities: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  milestone: z.string().optional(),
  q: z.string().optional().describe("Free-text filter over title + description"),
  since: z.string().optional().describe("ISO date — only issues updated at/after"),
  numbers: z.array(z.number().int()).optional().describe("Explicit issue numbers"),
  timestamps: z.boolean().optional().describe("Emit created/updated dates (default true)"),
  dependencies: z.boolean().optional().describe("Emit depends/blocks (default true)"),
  bare: z.boolean().optional().describe("Body only — no front matter/H1, for pasting into an existing document"),
};

export function registerExportBacklogMarkdown(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool("export_backlog_markdown", EXPORT_BACKLOG_MARKDOWN_DESCRIPTION, filterSchema, async (args) => {
    const rpid = await resolveActiveProjectId(db, schema, args.projectId);
    if (!rpid.ok) return rpid.error;
    const p = new URLSearchParams();
    if (args.statuses?.length) p.set("status", args.statuses.join(","));
    if (args.includeDone) p.set("includeDone", "1");
    if (args.tags?.length) p.set("tag", args.tags.join(","));
    if (args.priorities?.length) p.set("priority", args.priorities.join(","));
    if (args.types?.length) p.set("type", args.types.join(","));
    if (args.milestone) p.set("milestone", args.milestone);
    if (args.q) p.set("q", args.q);
    if (args.since) p.set("since", args.since);
    if (args.numbers?.length) p.set("numbers", args.numbers.join(","));
    if (args.timestamps === false) p.set("timestamps", "0");
    if (args.dependencies === false) p.set("deps", "0");
    if (args.bare) p.set("bare", "1");
    p.set("download", "0");
    try {
      const res = await fetch(boardApiUrl(`/api/projects/${rpid.projectId}/backlog.md?${p.toString()}`));
      const text = await res.text();
      if (!res.ok) return { content: [{ type: "text" as const, text: `Error: export failed (${res.status}): ${text.slice(0, 300)}` }] };
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: board unreachable — ${errorMessage(e)}` }] };
    }
  });
}

export function registerImportBacklogMarkdown(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool("import_backlog_markdown", IMPORT_BACKLOG_MARKDOWN_DESCRIPTION, {
    projectId: z.string().optional().describe("Target project ID (defaults to the active project)"),
    text: z.string().describe("The markdown document"),
    dryRun: z.boolean().optional().describe("true (default) = preview only, nothing written"),
    mode: z.enum(["update", "create"]).optional().describe("update (default) or create"),
    matchBy: z.enum(["auto", "number", "key", "title", "none"]).optional().describe("How to match existing issues in update mode (default auto: #number when the file's project is this one, then key, then title)"),
    defaultStatus: z.string().optional().describe("Status for issues above any section (default: the project's default)"),
    unknownStatus: z.enum(["create", "map"]).optional().describe("Sections the project lacks: create them (default) or map to the default status"),
  }, async ({ projectId, text, dryRun, mode, matchBy, defaultStatus, unknownStatus }) => {
    const rpid = await resolveActiveProjectId(db, schema, projectId);
    if (!rpid.ok) return rpid.error;
    const path = dryRun === false ? "import" : "preview";
    try {
      const res = await fetch(boardApiUrl(`/api/projects/${rpid.projectId}/backlog.md/${path}`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode, matchBy, defaultStatus, unknownStatus }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) return { content: [{ type: "text" as const, text: `Error: ${path} failed (${res.status}): ${JSON.stringify(data).slice(0, 400)}` }] };
      if (path === "import") notifyBoard(rpid.projectId, "mcp_import_backlog_markdown");
      return { content: [{ type: "text" as const, text: JSON.stringify({ dryRun: path === "preview", ...data }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: board unreachable — ${errorMessage(e)}` }] };
    }
  });
}
