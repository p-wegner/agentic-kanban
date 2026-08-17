import { readFileSync } from "node:fs";
import type { Database } from "../db/index.js";
import { getPluginRowById, listPluginRows } from "../repositories/plugins.repository.js";
import { parsePluginManifest, type PluginDocDef } from "@agentic-kanban/shared/lib/plugin-manifest";
import { resolveInside } from "./plugin-fs.js";

/**
 * Plugin docs (#manifest `docs[]`) — plugin-authored overview pages the board shows in its
 * Plugins menu (e.g. "which plugin when?"), served from the PLUGIN'S checkout.
 *
 * The board carries no knowledge of any particular plugin here: what is listed is exactly
 * what the installed manifests declare, so a public board without a (non-public) plugin has
 * nothing to show and no name to leak. The file is resolved through `resolveInside`, i.e. it
 * can only ever be a path the manifest itself declared, inside the plugin root.
 */
export type PluginDocEntry = PluginDocDef & { pluginId: string; pluginSlug: string; pluginName: string };

export async function listPluginDocs(database: Database): Promise<PluginDocEntry[]> {
  const out: PluginDocEntry[] = [];
  for (const row of await listPluginRows(database)) {
    let docs: PluginDocDef[] | undefined;
    try { docs = parsePluginManifest(row.manifestJson).docs; } catch { continue; }
    for (const d of docs ?? []) out.push({ ...d, pluginId: row.id, pluginSlug: row.pluginId, pluginName: row.name });
  }
  return out;
}

export type PluginDocRead =
  | { ok: true; body: string; contentType: string }
  | { ok: false; status: 404 };

/**
 * `theme` stamps `data-theme` on an HTML doc's `<html>` so an embedded page follows the
 * board's theme instead of the OS one (docs written theme-aware honour `:root[data-theme]`).
 */
export function stampTheme(html: string, theme: string | null | undefined): string {
  if (theme !== "dark" && theme !== "light") return html;
  return html.replace(/<html(\s[^>]*)?>/i, (m, attrs: string | undefined) =>
    /data-theme=/.test(m) ? m : `<html${attrs ?? ""} data-theme="${theme}">`);
}

export async function readPluginDoc(
  database: Database,
  pluginRowId: string,
  file: string,
  theme?: string | null,
): Promise<PluginDocRead> {
  const row = await getPluginRowById(pluginRowId, database);
  if (!row) return { ok: false, status: 404 };
  let doc: PluginDocDef | undefined;
  try { doc = parsePluginManifest(row.manifestJson).docs?.find((d) => d.file === file); } catch { /* fallthrough */ }
  if (!doc) return { ok: false, status: 404 };
  let body: string;
  try {
    body = readFileSync(resolveInside(row.localPath, doc.file, "docs[].file"), "utf8");
  } catch {
    return { ok: false, status: 404 };
  }
  const isHtml = /\.html?$/i.test(doc.file);
  return {
    ok: true,
    body: isHtml ? stampTheme(body, theme) : body,
    contentType: isHtml ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
  };
}
