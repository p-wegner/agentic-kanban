import type { Context } from "hono";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { createRouter } from "../middleware/create-router.js";
import { requireProject } from "../services/require-project.js";
import {
  exportBacklogMarkdown, previewBacklogMarkdownImport, applyBacklogMarkdownImport,
  type ExportFilters, type ImportOptions,
} from "../services/backlog-markdown.service.js";

/**
 * Backlog Markdown routes (docs/backlog-markdown.md). Mounted under /projects.
 *
 *   GET  /api/projects/:id/backlog.md?status=a,b&tag=x&priority=high&type=bug&milestone=M&q=text&since=ISO&numbers=1,2&includeDone=1&timestamps=0&deps=0&bare=1&download=1
 *   POST /api/projects/:id/backlog.md/preview   { text, mode?, matchBy?, defaultStatus?, unknownStatus? } | multipart file
 *   POST /api/projects/:id/backlog.md/import    same body — applies; returns the result
 */
export function createBacklogMarkdownRoute(database: Database, options?: { boardEvents?: BoardEvents }) {
  const router = createRouter();

  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bool = (v: string | undefined, dflt: boolean) => (v == null || v === "" ? dflt : !/^(0|false|no|off)$/i.test(v));

  router.get("/:projectId/backlog.md", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProject(projectId, database);
    const q = (k: string) => c.req.query(k);
    const filters: ExportFilters = {
      statuses: list(q("status")), includeDone: bool(q("includeDone"), false), tags: list(q("tag")), priorities: list(q("priority")),
      types: list(q("type")), milestone: q("milestone") || null, q: q("q") || null, since: q("since") || null,
      numbers: list(q("numbers")).map(Number).filter((n) => Number.isFinite(n)), timestamps: bool(q("timestamps"), true),
      dependencies: bool(q("deps"), true), bare: bool(q("bare"), false),
    };
    const { markdown, project } = await exportBacklogMarkdown(projectId, filters, database);
    const safe = project.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "backlog";
    const headers: Record<string, string> = { "Content-Type": "text/markdown; charset=utf-8" };
    if (bool(q("download"), true)) headers["Content-Disposition"] = `attachment; filename="${safe}-backlog.md"`;
    return new Response(markdown, { headers });
  });

  async function readBody(c: Context): Promise<{ text: string; opts: ImportOptions } | { error: string }> {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const fd = await c.req.formData();
      const file = fd.get("file");
      const rawText = fd.get("text");
      const text = file && typeof file !== "string" ? await file.text() : typeof rawText === "string" ? rawText : "";
      if (!text.trim()) return { error: "multipart upload must include a 'file' or 'text' field" };
      const g = (k: string) => { const v = fd.get(k); return typeof v === "string" && v ? v : undefined; };
      return { text, opts: { mode: g("mode") as ImportOptions["mode"], matchBy: g("matchBy") as ImportOptions["matchBy"], defaultStatus: g("defaultStatus") ?? null, unknownStatus: g("unknownStatus") as ImportOptions["unknownStatus"] } };
    }
    if (contentType.includes("application/json")) {
      const body: unknown = await c.req.json().catch(() => null);
      const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      if (!obj || typeof obj.text !== "string") return { error: "JSON body must be { text, mode?, matchBy?, defaultStatus?, unknownStatus? }" };
      return { text: obj.text, opts: { mode: obj.mode as ImportOptions["mode"], matchBy: obj.matchBy as ImportOptions["matchBy"], defaultStatus: (obj.defaultStatus as string | null | undefined) ?? null, unknownStatus: obj.unknownStatus as ImportOptions["unknownStatus"] } };
    }
    if (contentType.includes("text/")) {
      const text = await c.req.text();
      return { text, opts: { mode: c.req.query("mode") as ImportOptions["mode"], matchBy: c.req.query("matchBy") as ImportOptions["matchBy"] } };
    }
    return { error: "Content-Type must be application/json, text/markdown or multipart/form-data" };
  }

  router.post("/:projectId/backlog.md/preview", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProject(projectId, database);
    const b = await readBody(c);
    if ("error" in b) return c.json({ error: b.error }, 400);
    const { doc: _doc, ...preview } = await previewBacklogMarkdownImport(projectId, b.text, b.opts, database);
    return c.json(preview);
  });

  router.post("/:projectId/backlog.md/import", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProject(projectId, database);
    const b = await readBody(c);
    if ("error" in b) return c.json({ error: b.error }, 400);
    const result = await applyBacklogMarkdownImport(projectId, b.text, b.opts, database, options?.boardEvents);
    return c.json(result, 201);
  });

  return router;
}
