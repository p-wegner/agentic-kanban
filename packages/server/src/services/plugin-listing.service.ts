import { createTtlMemo } from "@agentic-kanban/shared/lib/ttl-memo";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { listPluginRows } from "../repositories/plugins.repository.js";
import { marketplaceCatalogPath, buildMarketplaceEntries, type PluginMarketplaceEntry, type InstalledPluginRow } from "./plugin-marketplace.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Read-side listing of installed plugins: the short-TTL memoized `listPlugins`, the
 * marketplace merge, and the manifest-drift verdict. Extracted from plugin.service.ts
 * as its own cohesive module (god-module ceiling) — the plugin service facade
 * re-exposes these behind unchanged method names.
 */
export function createPluginListingOps(deps: {
  database: Database;
  enabledSlugsByProject: () => Promise<Map<string, Set<string>>>;
  readOutputLocationPref: (pluginSlug: string, projectId: string) => Promise<unknown>;
}) {
  const { database, enabledSlugsByProject, readOutputLocationPref } = deps;

  // Short-TTL memo for the plugin listing (#418): GET /api/plugins re-did per-request
  // work per installed plugin — a manifest parse, an output-location pref read, and a
  // manifest-file disk read for the drift check (measured at 5.1s once, likely a cold
  // AV-scanned disk read). The listing only changes through the mutators below, which
  // all clear the memo; the TTL bounds staleness from out-of-band pref edits. Keyed by
  // projectId because the enabled/outputLocation decoration is project-scoped. The
  // in-flight promise is memoized so concurrent requests share one compute; a rejection
  // evicts itself so errors are never cached.
  const LIST_PLUGINS_TTL_MS = 15_000;
  // #559 — the shared TTL memo. `singleFlight` is exactly what the hand-rolled version
  // approximated: concurrent callers share one compute, and a rejection evicts itself
  // instead of caching the error.
  const listPluginsMemo = createTtlMemo<string, Awaited<ReturnType<typeof computePluginList>>>({
    ttlMs: LIST_PLUGINS_TTL_MS,
  });

  /**
   * Manifest-drift verdicts keyed by manifest path (#425). Invalidated by the file's own
   * mtime AND by the cached `manifestJson` it was compared against, so a `POST /:id/update`
   * (which rewrites the row, not the file) can never leave a stale "drifted" badge behind.
   * Unbounded only in the number of INSTALLED plugins, which is a handful.
   */
  const manifestDriftCache = new Map<string, { mtimeMs: number; manifestJson: string; drift: boolean }>();

  function listPlugins(projectId?: string) {
    return listPluginsMemo.singleFlight(projectId ?? "", () => computePluginList(projectId));
  }

  /** Wrap a listing-affecting mutator so it clears the listPlugins memo (even on throw —
   *  a partial mutation must not leave a stale listing cached). */
  function invalidatesPluginList<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A) => {
      try {
        return await fn(...args);
      } finally {
        listPluginsMemo.clear();
      }
    };
  }

  /**
   * Is the manifest the board RUNS (the cached row) behind the one on DISK? Shared by the
   * marketplace listing and the board's plugin panel (#442) — the panel is where an operator
   * actually drives loops, and it used to show nothing, so a drifted plugin ran its stale
   * manifest with the only warning parked in a Settings tab the operator never opens.
   *
   * mtime + cached-manifestJson keyed (#425): skips the read when neither side has moved, and
   * can never report stale drift because a row rewrite (POST /:id/update) invalidates the entry.
   */
  async function readManifestDrift(row: { localPath: string; manifestJson: string }): Promise<boolean> {
    try {
      const manifestPath = join(row.localPath, PLUGIN_MANIFEST_FILENAME);
      const mtimeMs = (await stat(manifestPath)).mtimeMs;
      const cached = manifestDriftCache.get(manifestPath);
      if (cached && cached.mtimeMs === mtimeMs && cached.manifestJson === row.manifestJson) return cached.drift;
      const drift = (await readFile(manifestPath, "utf8")).trim() !== row.manifestJson.trim();
      manifestDriftCache.set(manifestPath, { mtimeMs, manifestJson: row.manifestJson, drift });
      return drift;
    } catch {
      return false; // checkout gone or unreadable — surfaced elsewhere
    }
  }

  async function computePluginList(projectId?: string) {
    const rows = await listPluginRows(database);
    const enabledMap = projectId ? await enabledSlugsByProject() : null;
    const enabledSlugs = enabledMap?.get(projectId!) ?? new Set<string>();
    return Promise.all(rows.map(async (row) => {
      let manifest: PluginManifest | null = null;
      let manifestError: string | null = null;
      try {
        manifest = parsePluginManifest(row.manifestJson);
      } catch (err) {
        manifestError = errorMessage(err);
      }
      // A peek only — never creates the sidecar repo (that happens on enable/run/setOutputLocation).
      const outputLocation = projectId ? await readOutputLocationPref(row.pluginId, projectId) : undefined;
      // Drift (#295): the cached manifest is what the board RUNS; the file on disk is what the
      // author EDITED. They only reconcile on POST /:id/update, and until then edits silently do
      // nothing — so say so instead of letting the author chase a phantom bug.
      // Async read (see readManifestDrift): a sync read of a cold file would stall the
      // whole event loop, and this runs per installed plugin per memo-miss request.
      const manifestDrift = await readManifestDrift(row);
      return {
        ...row,
        manifest,
        manifestError,
        manifestDrift,
        ...(projectId ? { enabled: enabledSlugs.has(row.pluginId), outputLocation } : {}),
      };
    }));
  }

  /**
   * The marketplace = every installed plugin (row + manifest + enabled flag) merged
   * with the machine's catalog file of installable-but-not-installed plugins. A
   * catalog entry matching an installed plugin (by normalized git URL or slug) is
   * absorbed into the installed row rather than listed twice.
   */
  async function listMarketplace(projectId?: string): Promise<{ entries: PluginMarketplaceEntry[]; catalogPath: string }> {
    const rows = (await listPlugins(projectId)) as unknown as InstalledPluginRow[];
    return { entries: buildMarketplaceEntries(rows), catalogPath: marketplaceCatalogPath() };
  }

  return { listPlugins, listMarketplace, readManifestDrift, invalidatesPluginList };
}
