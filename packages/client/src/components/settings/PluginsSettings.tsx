import { useCallback, useEffect, useState } from "react";
import type { PluginManifest, PluginOutputLocation } from "@agentic-kanban/shared";
import { PLUGIN_OUTPUT_LOCATIONS } from "@agentic-kanban/shared";
import { apiFetch, apiPost, apiDelete } from "../../lib/api.js";
import { getViewRoutePath } from "../../lib/appRoutes.js";
import { showToast } from "../Toast.js";

/** One row from GET /api/plugins?projectId= — DB row + parsed manifest + enabled flag. */
type PluginListItem = {
  id: string;
  pluginId: string;
  name: string;
  sourceUrl: string | null;
  localPath: string;
  version: string | null;
  manifest: PluginManifest | null;
  manifestError: string | null;
  /** Only present when the list was fetched with a projectId. */
  enabled?: boolean;
  /** Only present when the list was fetched with a projectId. */
  outputLocation?: PluginOutputLocation;
};

type OutputLocationResult = { location: PluginOutputLocation; repoPath: string | null; sidecarRepoName: string };

const OUTPUT_LOCATION_LABELS: Record<PluginOutputLocation, string> = {
  leading: "Leading repo",
  sidecar: "Dedicated sidecar repo",
};

type ScriptRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type EnableReport = {
  prefKey: string;
  scaffoldWritten: boolean;
  scaffoldPlaceholders: number;
  warnings: string[];
};

type PluginsSettingsProps = {
  activeProjectId?: string | null;
};

/** Settings → Plugins tab: install, list, per-project enable/disable, and run plugin scripts. */
export function PluginsSettings({ activeProjectId }: PluginsSettingsProps) {
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [changingOutputLocationId, setChangingOutputLocationId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Script runs keyed `${pluginRowId}:${scriptName}`.
  const [runningScript, setRunningScript] = useState<string | null>(null);
  const [scriptResults, setScriptResults] = useState<Record<string, ScriptRunResult>>({});

  const refetch = useCallback(async () => {
    try {
      const query = activeProjectId ? `?projectId=${activeProjectId}` : "";
      const rows = await apiFetch<PluginListItem[]>(`/api/plugins${query}`);
      setPlugins(rows);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load plugins", "error");
    } finally {
      setLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function handleInstall() {
    const source = installSource.trim();
    if (!source || installing) return;
    setInstalling(true);
    try {
      await apiPost("/api/plugins", { source });
      setInstallSource("");
      showToast("Plugin installed", "success");
      await refetch();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Install failed", "error");
    } finally {
      setInstalling(false);
    }
  }

  async function handleToggleEnabled(plugin: PluginListItem) {
    if (!activeProjectId || togglingId) return;
    setTogglingId(plugin.id);
    try {
      const action = plugin.enabled ? "disable" : "enable";
      const result = await apiPost<EnableReport | { prefKey: string; skillsRemoved: string[] }>(
        `/api/plugins/${plugin.id}/${action}`,
        { projectId: activeProjectId },
      );
      setPlugins((rows) => rows.map((p) => (p.id === plugin.id ? { ...p, enabled: !plugin.enabled } : p)));
      if (action === "enable" && "warnings" in result && result.warnings.length > 0) {
        for (const warning of result.warnings) showToast(warning, "error");
      } else {
        showToast(`${plugin.name} ${action}d for this project`, "success");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Toggle failed", "error");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleChangeOutputLocation(plugin: PluginListItem, location: PluginOutputLocation) {
    if (!activeProjectId || changingOutputLocationId || location === plugin.outputLocation) return;
    setChangingOutputLocationId(plugin.id);
    try {
      const result = await apiPost<OutputLocationResult>(`/api/plugins/${plugin.id}/output-location`, {
        projectId: activeProjectId,
        location,
      });
      setPlugins((rows) => rows.map((p) => (p.id === plugin.id ? { ...p, outputLocation: result.location } : p)));
      showToast(
        result.location === "sidecar"
          ? `Extracted output now goes to the sidecar repo "${result.sidecarRepoName}"`
          : "Extracted output now goes to the leading repo",
        "success",
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to change output location", "error");
    } finally {
      setChangingOutputLocationId(null);
    }
  }

  async function handleDelete(plugin: PluginListItem) {
    if (deletingId) return;
    if (!window.confirm(`Remove plugin "${plugin.name}"? Files on disk are kept; the plugin is disabled everywhere.`)) return;
    setDeletingId(plugin.id);
    try {
      await apiDelete(`/api/plugins/${plugin.id}`);
      setPlugins((rows) => rows.filter((p) => p.id !== plugin.id));
      showToast(`Removed "${plugin.name}"`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRunScript(plugin: PluginListItem, scriptName: string) {
    if (!activeProjectId || runningScript) return;
    const key = `${plugin.id}:${scriptName}`;
    setRunningScript(key);
    try {
      const result = await apiPost<ScriptRunResult>(
        `/api/plugins/${plugin.id}/scripts/${encodeURIComponent(scriptName)}/run`,
        { projectId: activeProjectId },
      );
      setScriptResults((r) => ({ ...r, [key]: result }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Script run failed", "error");
    } finally {
      setRunningScript(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Plugins are git repos (or local directories) carrying a <span className="font-mono">kanban-plugin.json</span> manifest
        that declares agent skills, embeddable iframe views, runnable scripts, and butler prompt fragments.
        Install once, then enable per project. Scripts run as one-shot subprocesses here; skills need
        judgment (and a prompt), so they are launched as a ticket + workspace from the Plugins board view.
      </p>

      {/* Install form */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-md p-3 space-y-2">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Install a plugin</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={installSource}
            onChange={(e) => setInstallSource(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleInstall(); }}
            placeholder="Local directory path or git URL"
            className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-800 dark:text-gray-200"
            data-testid="plugin-install-source"
          />
          <button
            onClick={() => void handleInstall()}
            disabled={!installSource.trim() || installing}
            className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            data-testid="plugin-install-button"
          >
            {installing ? "Installing…" : "Install"}
          </button>
        </div>
      </div>

      {/* Installed plugins */}
      {loading ? (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading plugins…</div>
      ) : plugins.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400" data-testid="plugins-empty-state">
          No plugins installed yet. Install one from a local directory or a git URL above.
        </div>
      ) : (
        <div className="space-y-3">
          {plugins.map((plugin) => {
            const scripts = plugin.manifest?.scripts ?? [];
            const views = plugin.manifest?.views ?? [];
            const skills = (plugin.manifest?.skills ?? []).map((s) => s.dir.split("/").pop() || s.dir);
            const producesOutput = Boolean(plugin.manifest?.scaffold || plugin.manifest?.loops?.length || scripts.length > 0);
            return (
              <div key={plugin.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{plugin.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded font-mono">{plugin.pluginId}</span>
                      {plugin.version && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 rounded">v{plugin.version}</span>
                      )}
                      {activeProjectId && (
                        plugin.enabled ? (
                          <span className="text-[10px] px-1.5 py-0.5 bg-green-50 text-green-600 dark:bg-green-900/40 dark:text-green-300 rounded">enabled</span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded">disabled</span>
                        )
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 break-all">
                      {plugin.sourceUrl || plugin.localPath}
                    </p>
                    {plugin.manifestError && (
                      <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">Manifest error: {plugin.manifestError}</p>
                    )}
                    {(views.length > 0 || scripts.length > 0 || skills.length > 0) && (
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                        {[
                          views.length > 0 && `${views.length} view${views.length === 1 ? "" : "s"}`,
                          scripts.length > 0 && `${scripts.length} script${scripts.length === 1 ? "" : "s"}`,
                          skills.length > 0 && `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
                        ].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0 items-center">
                    {activeProjectId && !plugin.manifestError && (
                      <button
                        onClick={() => void handleToggleEnabled(plugin)}
                        disabled={togglingId === plugin.id}
                        className={`text-xs px-2 py-1 rounded border disabled:opacity-50 ${
                          plugin.enabled
                            ? "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                            : "border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30"
                        }`}
                      >
                        {togglingId === plugin.id ? "…" : plugin.enabled ? "Disable" : "Enable"}
                      </button>
                    )}
                    <button
                      onClick={() => void handleDelete(plugin)}
                      disabled={deletingId === plugin.id}
                      className="text-xs text-gray-400 hover:text-red-600 px-1 disabled:opacity-50"
                    >
                      {deletingId === plugin.id ? "…" : "Delete"}
                    </button>
                  </div>
                </div>

                {/* Output location — where scaffold/script/loop output (e.g. extracted requirements) is written */}
                {activeProjectId && producesOutput && !plugin.manifestError && (
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-2 space-y-1">
                    <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Output location</div>
                    <div className="flex items-center gap-2">
                      <select
                        value={plugin.outputLocation ?? "leading"}
                        onChange={(e) => void handleChangeOutputLocation(plugin, e.target.value as PluginOutputLocation)}
                        disabled={changingOutputLocationId === plugin.id}
                        className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 dark:bg-gray-800 dark:text-gray-200 disabled:opacity-50"
                        data-testid={`plugin-output-location-${plugin.id}`}
                      >
                        {PLUGIN_OUTPUT_LOCATIONS.map((loc) => (
                          <option key={loc} value={loc}>{OUTPUT_LOCATION_LABELS[loc]}</option>
                        ))}
                      </select>
                      {changingOutputLocationId === plugin.id && <span className="text-[11px] text-gray-400">Saving…</span>}
                    </div>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500">
                      Where this plugin's scaffold, scripts and loops write output (e.g. extracted requirements). Leading repo
                      by default — for a single-repo project that IS the repo. Sidecar creates/uses a dedicated
                      "{plugin.pluginId}-requirements" repo, added to this project.
                    </p>
                  </div>
                )}

                {/* Scripts */}
                {scripts.length > 0 && (
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-2 space-y-1.5">
                    <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Scripts</div>
                    {scripts.map((script) => {
                      const key = `${plugin.id}:${script.name}`;
                      const result = scriptResults[key];
                      return (
                        <div key={script.name} className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{script.name}</span>
                            <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate flex-1" title={script.command}>{script.command}</span>
                            <button
                              onClick={() => void handleRunScript(plugin, script.name)}
                              disabled={!activeProjectId || runningScript !== null}
                              title={activeProjectId ? "Run against the active project" : "Select a project to run scripts"}
                              className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 shrink-0"
                            >
                              {runningScript === key ? "Running…" : "Run"}
                            </button>
                          </div>
                          {result && (
                            <details className="text-xs" open>
                              <summary className="cursor-pointer text-gray-500 dark:text-gray-400">
                                {result.timedOut
                                  ? "Timed out"
                                  : `Exit code ${result.code ?? "?"}`}
                                {result.code === 0 && !result.timedOut ? " ✓" : ""}
                              </summary>
                              <pre className="mt-1 p-2 rounded bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-800 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-gray-700 dark:text-gray-300">
                                {[
                                  result.stdout && `── stdout ──\n${result.stdout}`,
                                  result.stderr && `── stderr ──\n${result.stderr}`,
                                ].filter(Boolean).join("\n\n") || "(no output)"}
                              </pre>
                            </details>
                          )}
                        </div>
                      );
                    })}
                    {!activeProjectId && (
                      <p className="text-[11px] text-gray-400 dark:text-gray-500">Open a project to run scripts and toggle per-project enablement.</p>
                    )}
                  </div>
                )}

                {/* Skills — listed here, LAUNCHED from the Plugins board view.
                    Settings deliberately does not launch them: a skill launch takes
                    minutes (worktree → setup script → agent) and needs a title, a
                    free-text prompt and a workflow choice, none of which fit a
                    settings row. The board view streams the launch stage by stage;
                    this tab's old "Run" button awaited the whole thing behind a
                    static "Launching…" label, indistinguishable from a dead button. */}
                {skills.length > 0 && (
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-2 space-y-1.5">
                    <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Skills</div>
                    <div className="flex flex-wrap gap-1">
                      {skills.map((skillName) => (
                        <span
                          key={skillName}
                          className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                        >
                          {skillName}
                        </span>
                      ))}
                    </div>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500">
                      Run these from the{" "}
                      <a
                        href={getViewRoutePath("plugin-views")}
                        className="text-brand-600 dark:text-brand-400 hover:underline"
                        data-testid="plugin-skills-open-board-view"
                      >
                        Plugins board view
                      </a>
                      , where a launch can carry a title, a prompt and a workflow, and streams its progress.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
