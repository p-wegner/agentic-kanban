/**
 * The plugin marketplace — extracted from `plugin.service.ts` to keep it under the 1000-line
 * god-module ceiling, which is part of `verify_script` and so blocks EVERY merge on the board
 * when it trips.
 *
 * Cohesive and almost entirely pure: the machine's user-editable catalog file, the entry shape
 * the routes return, and the merge of "installed plugins" with "catalog-only plugins". The one
 * impure input (the installed rows) is passed in rather than read here, so this module needs no
 * database and no service closure.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { pluginsHomeDir } from "./plugin-fs.js";

/**
 * User-editable marketplace catalog: a JSON array of `{ name?, slug?, description?, gitUrl }`
 * entries listing plugins that are AVAILABLE but not necessarily installed. Kept next to the
 * cloned plugins so a machine's catalog travels with its plugin store, never with the board's
 * source. Missing file = empty catalog; the marketplace still lists every installed plugin.
 */
export function marketplaceCatalogPath(): string {
  return join(pluginsHomeDir(), "marketplace.json");
}

export interface PluginMarketplaceEntry {
  /** Manifest id for installed plugins; the catalog's declared slug (or null) otherwise. */
  slug: string | null;
  name: string;
  description: string | null;
  version: string | null;
  gitUrl: string | null;
  localPath: string | null;
  installed: boolean;
  /** Plugin DB row id — the `:id` segment of the plugin routes — when installed. */
  installedId: string | null;
  /** Enabled for the requested project (false when no projectId was given). */
  enabled: boolean;
  origin: "installed" | "catalog";
}

type CatalogFileEntry = { name: string; gitUrl: string; description?: string; slug?: string };

/** The shape `listPlugins()` returns, narrowed to what the marketplace actually reads. */
export interface InstalledPluginRow {
  id: string;
  pluginId: string | null;
  name: string;
  version?: string | null;
  sourceUrl?: string | null;
  localPath: string | null;
  manifest?: { description?: string | null } | null;
  enabled?: boolean;
}

export function readMarketplaceCatalog(): CatalogFileEntry[] {
  const file = marketplaceCatalogPath();
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .filter((e) => typeof e.gitUrl === "string" && (e.gitUrl as string).trim().length > 0)
      .map((e) => ({
        gitUrl: (e.gitUrl as string).trim(),
        name:
          typeof e.name === "string" && e.name.trim()
            ? e.name.trim()
            : basename((e.gitUrl as string).trim()).replace(/\.git$/i, ""),
        description: typeof e.description === "string" ? e.description : undefined,
        slug: typeof e.slug === "string" && e.slug.trim() ? e.slug.trim() : undefined,
      }));
  } catch {
    return []; // a hand-edited broken catalog must not 500 the marketplace
  }
}

/** `.git` suffix, trailing slashes, and case are presentation, not identity. */
export function normalizeGitUrl(url: string): string {
  return url.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * The marketplace = every installed plugin merged with the machine's catalog file of
 * installable-but-not-installed plugins. A catalog entry matching an installed plugin (by
 * normalized git URL or slug) is absorbed into the installed row rather than listed twice.
 */
export function buildMarketplaceEntries(rows: InstalledPluginRow[]): PluginMarketplaceEntry[] {
  const entries: PluginMarketplaceEntry[] = rows.map((row) => ({
    slug: row.pluginId,
    name: row.name,
    description: row.manifest?.description ?? null,
    version: row.version ?? null,
    gitUrl: row.sourceUrl ?? null,
    localPath: row.localPath,
    installed: true,
    installedId: row.id,
    enabled: row.enabled ?? false,
    origin: "installed",
  }));

  const installedUrls = new Set(
    entries.map((e) => (e.gitUrl ? normalizeGitUrl(e.gitUrl) : null)).filter((u): u is string => !!u),
  );
  const installedSlugs = new Set(entries.map((e) => e.slug));

  for (const item of readMarketplaceCatalog()) {
    if (installedUrls.has(normalizeGitUrl(item.gitUrl))) continue;
    if (item.slug && installedSlugs.has(item.slug)) continue;
    entries.push({
      slug: item.slug ?? null,
      name: item.name,
      description: item.description ?? null,
      version: null,
      gitUrl: item.gitUrl,
      localPath: null,
      installed: false,
      installedId: null,
      enabled: false,
      origin: "catalog",
    });
  }
  return entries;
}
