import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { usePluginViewStore } from "../stores/pluginViewStore.js";

/** GET /api/plugins/marketplace — installed plugins merged with the machine's catalog file. */
type MarketplaceEntry = {
  slug: string | null;
  name: string;
  description: string | null;
  version: string | null;
  gitUrl: string | null;
  localPath: string | null;
  installed: boolean;
  installedId: string | null;
  enabled: boolean;
  origin: "installed" | "catalog";
};

interface PluginMarketplacePanelProps {
  projectId: string;
}

/**
 * The Plugins tab's marketplace surface: install a plugin by git URL or local
 * path, browse what is installed (enable/disable for THIS project, open its
 * view, uninstall), and see catalog entries that are one click from installed.
 * The catalog is a user-editable JSON file next to the cloned plugins
 * (`catalogPath` in the response) — the board ships no remote registry.
 */
export function PluginMarketplacePanel({ projectId }: PluginMarketplacePanelProps) {
  const [entries, setEntries] = useState<MarketplaceEntry[]>([]);
  const [catalogPath, setCatalogPath] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const installInputRef = useRef<HTMLInputElement>(null);
  const setSelection = usePluginViewStore((s) => s.setSelection);
  const installFocusNonce = usePluginViewStore((s) => s.installFocusNonce);

  const refetch = useCallback(async () => {
    try {
      const result = await apiFetch<{ entries: MarketplaceEntry[]; catalogPath: string }>(
        `/api/plugins/marketplace?projectId=${encodeURIComponent(projectId)}`,
      );
      setEntries(result.entries);
      setCatalogPath(result.catalogPath);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load marketplace", "error");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refetch();
  }, [refetch]);

  // "Install plugin…" in the toolbar menu bumps the nonce → put the cursor in the field.
  useEffect(() => {
    if (installFocusNonce > 0) installInputRef.current?.focus();
  }, [installFocusNonce]);

  async function handleInstall(installSource: string) {
    const trimmed = installSource.trim();
    if (!trimmed || installing) return;
    setInstalling(true);
    try {
      const row = await apiPost<{ name?: string }>(`/api/plugins`, { source: trimmed });
      showToast(`Installed "${row.name ?? trimmed}"`, "success");
      setSource("");
      await refetch();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Install failed", "error");
    } finally {
      setInstalling(false);
    }
  }

  async function handleToggleEnabled(entry: MarketplaceEntry) {
    if (!entry.installedId || busyId) return;
    setBusyId(entry.installedId);
    try {
      if (entry.enabled) {
        await apiPost(`/api/plugins/${entry.installedId}/disable`, { projectId });
        showToast(`Disabled "${entry.name}" for this project`, "success");
      } else {
        const report = await apiPost<{ warnings?: string[] }>(
          `/api/plugins/${entry.installedId}/enable`,
          { projectId },
        );
        const warnings = report.warnings ?? [];
        showToast(
          warnings.length > 0
            ? `Enabled "${entry.name}" (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`
            : `Enabled "${entry.name}" for this project`,
          "success",
        );
      }
      await refetch();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update plugin", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleUpdate(entry: MarketplaceEntry) {
    if (!entry.installedId || busyId) return;
    setBusyId(entry.installedId);
    try {
      const result = await apiPost<{
        pulled: boolean;
        headChanged: boolean;
        previousVersion: string | null;
        version: string | null;
        viewsStopped: number;
      }>(`/api/plugins/${entry.installedId}/update`, {});
      const versionNote =
        result.previousVersion !== result.version
          ? ` (${result.previousVersion ?? "?"} → ${result.version ?? "?"})`
          : "";
      const message = !result.pulled
        ? `Re-read "${entry.name}" manifest from its local checkout${versionNote}`
        : result.headChanged
          ? `Updated "${entry.name}"${versionNote}${result.viewsStopped > 0 ? ` — ${result.viewsStopped} running view${result.viewsStopped === 1 ? "" : "s"} stopped` : ""}`
          : `"${entry.name}" is already up to date`;
      showToast(message, "success");
      await refetch();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Update failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleUninstall(entry: MarketplaceEntry) {
    if (!entry.installedId || busyId) return;
    if (!window.confirm(`Uninstall "${entry.name}"? Its cloned files stay on disk; the board forgets it and disables it everywhere.`)) {
      return;
    }
    setBusyId(entry.installedId);
    try {
      await apiDelete(`/api/plugins/${entry.installedId}`);
      showToast(`Uninstalled "${entry.name}"`, "success");
      await refetch();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Uninstall failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <div className="flex-1 p-6 text-sm text-gray-500 dark:text-gray-400">Loading marketplace…</div>;
  }

  const installed = entries.filter((e) => e.installed);
  const available = entries.filter((e) => !e.installed);

  function entryCard(entry: MarketplaceEntry) {
    const key = entry.installedId ?? entry.gitUrl ?? entry.name;
    const busy = !!entry.installedId && busyId === entry.installedId;
    return (
      <div
        key={key}
        className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 flex flex-col gap-2"
        data-testid="marketplace-entry"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate" title={entry.name}>
              🧩 {entry.name}
            </div>
            <div className="text-[11px] text-gray-400 dark:text-gray-500">
              {entry.slug && <span className="font-mono">{entry.slug}</span>}
              {entry.version && <span> · v{entry.version}</span>}
            </div>
          </div>
          {entry.installed && (
            <span
              className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                entry.enabled
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
                  : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {entry.enabled ? "enabled" : "installed"}
            </span>
          )}
        </div>
        {entry.description && (
          <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-3">{entry.description}</p>
        )}
        <div className="text-[11px] text-gray-400 dark:text-gray-500 space-y-0.5">
          {entry.gitUrl && (
            <div className="truncate" title={entry.gitUrl}>
              <span className="font-semibold">git:</span> <span className="font-mono">{entry.gitUrl}</span>
            </div>
          )}
          {entry.localPath && (
            <div className="truncate" title={entry.localPath}>
              <span className="font-semibold">local:</span> <span className="font-mono">{entry.localPath}</span>
            </div>
          )}
        </div>
        <div className="mt-auto flex items-center gap-1.5 pt-1">
          {entry.installed ? (
            <>
              <button
                onClick={() => void handleToggleEnabled(entry)}
                disabled={busy}
                className={`text-xs px-2 py-1 rounded disabled:opacity-50 ${
                  entry.enabled
                    ? "border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                    : "bg-emerald-600 text-white hover:bg-emerald-700"
                }`}
              >
                {busy ? "Working…" : entry.enabled ? "Disable" : "Enable for project"}
              </button>
              {entry.enabled && entry.slug && (
                <button
                  onClick={() => setSelection({ kind: "plugin", slug: entry.slug! })}
                  className="text-xs px-2 py-1 rounded bg-violet-600 text-white hover:bg-violet-700"
                >
                  Open
                </button>
              )}
              <button
                onClick={() => void handleUpdate(entry)}
                disabled={busy}
                className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                title={entry.gitUrl ? "git pull --ff-only, then re-read the manifest" : "Re-read the manifest from the local checkout"}
              >
                {busy ? "Working…" : "Update"}
              </button>
              <button
                onClick={() => void handleUninstall(entry)}
                disabled={busy}
                className="ml-auto text-xs px-2 py-1 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
              >
                Uninstall
              </button>
            </>
          ) : (
            <button
              onClick={() => void handleInstall(entry.gitUrl ?? "")}
              disabled={installing || !entry.gitUrl}
              className="text-xs px-2 py-1 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {installing ? "Installing…" : "Install"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="plugin-marketplace-panel">
      <div className="max-w-4xl mx-auto p-4 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">🛍️ Plugin Marketplace</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Install once per machine, then enable per project. A plugin is a repo with a{" "}
            <code className="font-mono">kanban-plugin.json</code> manifest.
          </p>
        </div>

        {/* Install by source */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleInstall(source);
          }}
          className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3"
        >
          <label htmlFor="plugin-install-source" className="block text-xs font-medium text-gray-700 dark:text-gray-200">
            Install a plugin
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="plugin-install-source"
              ref={installInputRef}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Git URL (https://… / git@…) or local directory path"
              className="flex-1 text-xs rounded px-2 py-1.5 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 outline-none focus:border-violet-500"
            />
            <button
              type="submit"
              disabled={installing || !source.trim()}
              className="text-xs px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {installing ? "Installing…" : "Install"}
            </button>
          </div>
        </form>

        {/* Installed */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Installed ({installed.length})
          </h3>
          {installed.length === 0 ? (
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">Nothing installed yet.</p>
          ) : (
            <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-2.5">{installed.map(entryCard)}</div>
          )}
        </div>

        {/* Catalog */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Available ({available.length})
          </h3>
          {available.length === 0 ? (
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              No further catalog entries. Add installable plugins (name, description, gitUrl) to{" "}
              <code className="font-mono break-all">{catalogPath}</code> and they will be listed here.
            </p>
          ) : (
            <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-2.5">{available.map(entryCard)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
