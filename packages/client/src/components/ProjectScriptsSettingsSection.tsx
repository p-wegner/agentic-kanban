import { useEffect, useState } from "react";
import type { ProjectScriptShortcutResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface ProjectScriptsSettingsSectionProps {
  projectId: string;
}

type Draft = {
  id?: string;
  name: string;
  command: string;
  workingDir: string;
};

const EMPTY_DRAFT: Draft = { name: "", command: "", workingDir: "" };

export function ProjectScriptsSettingsSection({ projectId }: ProjectScriptsSettingsSectionProps) {
  const [scripts, setScripts] = useState<ProjectScriptShortcutResponse[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function loadScripts() {
    setLoading(true);
    try {
      setScripts(await apiFetch<ProjectScriptShortcutResponse[]>(`/api/projects/${projectId}/scripts`));
    } catch {
      showToast("Failed to load script shortcuts", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setDraft(EMPTY_DRAFT);
    loadScripts();
  }, [projectId]);

  async function saveDraft() {
    if (!draft.name.trim() || !draft.command.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        command: draft.command.trim(),
        workingDir: draft.workingDir.trim() || null,
      };
      if (draft.id) {
        await apiFetch(`/api/projects/${projectId}/scripts/${draft.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch(`/api/projects/${projectId}/scripts`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      setDraft(EMPTY_DRAFT);
      await loadScripts();
      showToast("Script shortcut saved", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save script", "error");
    } finally {
      setSaving(false);
    }
  }

  async function deleteScript(script: ProjectScriptShortcutResponse) {
    setSaving(true);
    try {
      await apiFetch(`/api/projects/${projectId}/scripts/${script.id}`, { method: "DELETE" });
      if (draft.id === script.id) setDraft(EMPTY_DRAFT);
      await loadScripts();
      showToast("Script shortcut deleted", "success");
    } catch {
      showToast("Failed to delete script shortcut", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-md p-3 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">Script Shortcuts</h3>
        <p className="text-xs text-gray-500 mt-0.5">Run common project commands from the board header without creating a workspace.</p>
      </div>

      <div className="space-y-2">
        {loading && <p className="text-xs text-gray-500">Loading scripts...</p>}
        {!loading && scripts.length === 0 && <p className="text-xs text-gray-500">No script shortcuts configured.</p>}
        {scripts.map((script) => (
          <div key={script.id} className="flex items-start gap-2 rounded border border-gray-200 dark:border-gray-700 p-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{script.name}</span>
                {script.lastRun && (
                  <span className="text-[10px] text-gray-500 dark:text-gray-400 shrink-0">{script.lastRun.status}</span>
                )}
              </div>
              <div className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">{script.command}</div>
              {script.workingDir && <div className="text-xs text-gray-400 dark:text-gray-500 truncate">cwd: {script.workingDir}</div>}
            </div>
            <button
              type="button"
              onClick={() => setDraft({
                id: script.id,
                name: script.name,
                command: script.command,
                workingDir: script.workingDir ?? "",
              })}
              className="text-xs px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => deleteScript(script)}
              disabled={saving}
              className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      <div className="grid gap-2 md:grid-cols-[1fr_1.5fr_1fr_auto] items-end">
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">Name</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
            placeholder="Test mine"
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">Command</span>
          <input
            value={draft.command}
            onChange={(event) => setDraft((value) => ({ ...value, command: event.target.value }))}
            placeholder="pnpm test:mine"
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">Working directory</span>
          <input
            value={draft.workingDir}
            onChange={(event) => setDraft((value) => ({ ...value, workingDir: event.target.value }))}
            placeholder="packages/server"
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <div className="flex gap-2">
          {draft.id && (
            <button
              type="button"
              onClick={() => setDraft(EMPTY_DRAFT)}
              className="text-sm px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={saveDraft}
            disabled={saving || !draft.name.trim() || !draft.command.trim()}
            className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {draft.id ? "Update" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
