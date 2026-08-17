import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "../middleware/create-router.js";
import type { Database } from "../db/index.js";
import { listPluginRows } from "../repositories/plugins.repository.js";

/**
 * Docs route — serves the board's own operator-facing docs (`docs/plugins/*.html`) so
 * they are visible INSIDE the board (Plugins tab → "Guide: which plugin when?"), not
 * only as a file in the repo that nobody opens.
 *
 *   GET /api/docs/plugins/:file[?theme=dark|light]
 *
 * `theme` stamps `data-theme` on the document's `<html>` so an embedded page follows the
 * board's theme instead of the OS one (the docs are written theme-aware, see
 * improvement-system-map.html's `:root[data-theme]` blocks).
 *
 * NOT public by default. The docs describe plugins (refactor-safety-net, code-metrics,
 * refactor-toolset) that are not themselves public, while this repo is — so a doc is only
 * served when at least one plugin it is `about` is INSTALLED on this board (`PLUGIN_DOCS`),
 * and nothing under docs/plugins/ ships in the npm tarball (no copy-assets step, no "files"
 * entry). A consumer without those plugins gets 404 and never sees the menu entry
 * (GET /api/docs/plugins lists only the docs that qualify).
 *
 * Location: the repo's `docs/plugins/` (dev checkout walk-up from the module dir; a packaged
 * install has no such dir and serves nothing).
 */

/** Which docs exist and which installed plugin(s) make each one relevant. */
export const PLUGIN_DOCS: ReadonlyArray<{ file: string; title: string; about: readonly string[] }> = [
  {
    file: "improvement-system-map.html",
    title: "Guide: which plugin when?",
    about: ["refactor-safety-net", "code-metrics", "refactor-toolset"],
  },
];
const _moduleDir = dirname(fileURLToPath(import.meta.url));

/** Only bare filenames from a fixed allowlist of extensions — no traversal, no dotfiles. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(html|md)$/;

export function resolvePluginDocsDir(moduleDir: string = _moduleDir): string | null {
  const candidates = [
    join(moduleDir, "docs", "plugins"),
    join(moduleDir, "..", "docs", "plugins"),
  ];
  let dir = moduleDir;
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, "docs", "plugins"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) {
    try {
      readFileSync(join(c, "improvement-system-map.html"));
      return resolve(c);
    } catch { /* try next */ }
  }
  return null;
}

/** Docs whose subject plugins are installed (by manifest slug) — the only ones ever served. */
export function availablePluginDocs(installedSlugs: Iterable<string>, docsDir: string | null = resolvePluginDocsDir()) {
  if (!docsDir) return [];
  const installed = new Set(installedSlugs);
  return PLUGIN_DOCS.filter((d) => d.about.some((slug) => installed.has(slug)))
    .filter((d) => { try { readFileSync(join(docsDir, d.file)); return true; } catch { return false; } })
    .map(({ file, title }) => ({ file, title }));
}

export function readPluginDoc(
  file: string,
  opts: { theme?: string | null; docsDir?: string | null; installedSlugs?: Iterable<string> } = {},
): { ok: true; body: string; contentType: string } | { ok: false; status: 400 | 404 } {
  if (!SAFE_NAME.test(file)) return { ok: false, status: 400 };
  const dir = opts.docsDir ?? resolvePluginDocsDir();
  if (opts.installedSlugs && !availablePluginDocs(opts.installedSlugs, dir).some((d) => d.file === file)) {
    return { ok: false, status: 404 };
  }
  if (!dir) return { ok: false, status: 404 };
  let body: string;
  try {
    body = readFileSync(join(dir, file), "utf8");
  } catch {
    return { ok: false, status: 404 };
  }
  const isHtml = file.endsWith(".html");
  if (isHtml && (opts.theme === "dark" || opts.theme === "light")) {
    body = body.replace(/<html(\s[^>]*)?>/i, (m, attrs: string | undefined) =>
      /data-theme=/.test(m) ? m : `<html${attrs ?? ""} data-theme="${opts.theme}">`);
  }
  return { ok: true, body, contentType: isHtml ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8" };
}

export function createDocsRoute(database: Database) {
  const router = createRouter();
  const installedSlugs = async () => (await listPluginRows(database)).map((p) => p.pluginId);
  // GET /api/docs/plugins — the docs this board may show (drives the Plugins-tab menu entry).
  router.get("/plugins", async (c) => c.json(availablePluginDocs(await installedSlugs())));
  router.get("/plugins/:file", async (c) => {
    const result = readPluginDoc(c.req.param("file"), {
      theme: c.req.query("theme"),
      installedSlugs: await installedSlugs(),
    });
    if (!result.ok) {
      return c.json({ error: result.status === 400 ? "invalid file name" : "doc not found" }, result.status);
    }
    return c.body(result.body, 200, { "Content-Type": result.contentType, "Cache-Control": "no-cache" });
  });
  return router;
}
