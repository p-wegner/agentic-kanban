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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
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
  /** The manifest file on disk differs from the cached copy the board runs (#295). */
  manifestDrift: boolean;
  origin: "installed" | "catalog" | "bundled";
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
  manifestDrift?: boolean;
}

export function readMarketplaceCatalog(): CatalogFileEntry[] {
  const file = marketplaceCatalogPath();
  if (!existsSync(file)) return [];
  try {
    // Strip a UTF-8 BOM: PowerShell's `Set-Content -Encoding utf8` (the way a Windows
    // user will most likely author this file) writes one, and JSON.parse rejects it.
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed: unknown = JSON.parse(raw);
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

/**
 * The board's BUNDLED plugins: `plugins/<slug>/` directories shipped inside the board's own
 * package (repo checkout in dev, the npm package root when installed). Found by walking up from
 * this module to the `agentic-kanban` package root, so it works from `src/` under tsx and from
 * the esbuild `dist/` bundle alike. `AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR` overrides for tests
 * (set it to a non-existent path to disable). Missing dir = no bundled plugins, never an error.
 */
export function bundledPluginsDir(): string | null {
  const override = process.env.AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR;
  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : null;
  }
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        // Both the server package and the repo root are named "agentic-kanban" (the former is
        // the published npm package) — take the FIRST match that actually has a plugins/ dir.
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "agentic-kanban") {
          const plugins = join(dir, "plugins");
          if (existsSync(plugins)) return plugins;
        }
      } catch {
        /* unreadable package.json — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

type BundledPlugin = { slug: string; name: string; description?: string; version?: string; localPath: string };

/** Every bundled `plugins/<dir>/kanban-plugin.json` that parses; broken ones are skipped. */
export function readBundledPlugins(): BundledPlugin[] {
  const root = bundledPluginsDir();
  if (!root) return [];
  const out: BundledPlugin[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const name of entries) {
    const localPath = join(root, name);
    try {
      let raw = readFileSync(join(localPath, "kanban-plugin.json"), "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const m: unknown = JSON.parse(raw);
      if (!m || typeof m !== "object") continue;
      const manifest = m as Record<string, unknown>;
      if (typeof manifest.id !== "string" || !manifest.id) continue;
      out.push({
        slug: manifest.id,
        name: typeof manifest.name === "string" && manifest.name ? manifest.name : manifest.id,
        description: typeof manifest.description === "string" ? manifest.description : undefined,
        version: typeof manifest.version === "string" ? manifest.version : undefined,
        localPath,
      });
    } catch {
      /* a broken bundled manifest must not 500 the marketplace */
    }
  }
  return out;
}

/** `.git` suffix, trailing slashes, and case are presentation, not identity. */
export function normalizeGitUrl(url: string): string {
  return url.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * The marketplace = every installed plugin, merged with the board's BUNDLED plugins and the
 * machine's catalog file of installable-but-not-installed plugins. A bundled/catalog entry
 * matching an installed plugin (by slug, normalized git URL, or resolved local path) is
 * absorbed into the installed row rather than listed twice.
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
    manifestDrift: row.manifestDrift ?? false,
    origin: "installed",
  }));

  const installedUrls = new Set(
    entries.map((e) => (e.gitUrl ? normalizeGitUrl(e.gitUrl) : null)).filter((u): u is string => !!u),
  );
  const installedSlugs = new Set(entries.map((e) => e.slug));
  const installedPaths = new Set(
    entries.map((e) => (e.localPath ? resolve(e.localPath).toLowerCase() : null)).filter((p): p is string => !!p),
  );

  for (const item of readBundledPlugins()) {
    if (installedSlugs.has(item.slug)) continue;
    if (installedPaths.has(resolve(item.localPath).toLowerCase())) continue;
    entries.push({
      slug: item.slug,
      name: item.name,
      description: item.description ?? null,
      version: item.version ?? null,
      gitUrl: null,
      localPath: item.localPath,
      installed: false,
      installedId: null,
      enabled: false,
      manifestDrift: false,
      origin: "bundled",
    });
  }

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
      manifestDrift: false,
      origin: "catalog",
    });
  }
  return entries;
}
