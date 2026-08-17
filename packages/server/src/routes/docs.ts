import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "../middleware/create-router.js";

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
 * Location: packaged installs read `dist/docs/plugins/` (copied by scripts/copy-assets.mjs,
 * shipped via package.json "files"); a dev checkout falls back to the repo's `docs/plugins/`.
 * Two packaged candidates because the bundles sit at different depths (dist/server.js vs
 * dist/cli/index.js) — same pattern as resolveHookSource in project-scaffold.ts.
 */
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

export function readPluginDoc(
  file: string,
  opts: { theme?: string | null; docsDir?: string | null } = {},
): { ok: true; body: string; contentType: string } | { ok: false; status: 400 | 404 } {
  if (!SAFE_NAME.test(file)) return { ok: false, status: 400 };
  const dir = opts.docsDir ?? resolvePluginDocsDir();
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

export function createDocsRoute() {
  const router = createRouter();
  router.get("/plugins/:file", (c) => {
    const result = readPluginDoc(c.req.param("file"), { theme: c.req.query("theme") });
    if (!result.ok) {
      return c.json({ error: result.status === 400 ? "invalid file name" : "doc not found" }, result.status);
    }
    return c.body(result.body, 200, { "Content-Type": result.contentType, "Cache-Control": "no-cache" });
  });
  return router;
}
