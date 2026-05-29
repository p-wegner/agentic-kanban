import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { WorkflowBuilder } from "./WorkflowBuilder.js";

interface Template {
  id: string;
  name: string;
  description: string | null;
  ticketType: string | null;
  isDefault: boolean;
  isBuiltin: boolean;
  projectId: string | null;
  nodes?: { id: string; name: string; nodeType: string }[];
  edges?: unknown[];
}

interface NodeStat { nodeId: string; nodeName: string; nodeType: string; visits: number; avgDwellMs: number | null; dropoff: number }
interface Analytics { totalWorkspaces: number; nodes: NodeStat[] }

function fmtDwell(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function WorkflowsView({ projectId }: { projectId: string }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<{ templateId: string | null } | null>(null);
  const [tab, setTab] = useState<"templates" | "analytics">("templates");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  const load = useCallback(() => {
    apiFetch<Template[]>(`/api/workflows/templates?projectId=${projectId}&graph=1`).then(setTemplates).catch(() => {});
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== "analytics") return;
    apiFetch<Analytics>(`/api/workflows/analytics?projectId=${projectId}`).then(setAnalytics).catch(() => setAnalytics(null));
  }, [tab, projectId]);

  async function duplicate(t: Template) {
    try {
      await apiFetch(`/api/workflows/templates`, { method: "POST", body: JSON.stringify({ projectId, cloneFrom: t.id }) });
      showToast(`Duplicated "${t.name}"`, "success");
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Duplicate failed", "error");
    }
  }
  async function remove(t: Template) {
    if (!window.confirm(`Delete workflow "${t.name}"?`)) return;
    try {
      await apiFetch(`/api/workflows/templates/${t.id}`, { method: "DELETE" });
      showToast("Workflow deleted", "success");
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed", "error");
    }
  }

  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="flex items-center mb-3 gap-2">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Workflows</h2>
        <div className="flex gap-1 ml-2">
          <button onClick={() => setTab("templates")} className={`text-xs px-2 py-1 rounded ${tab === "templates" ? "bg-blue-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>Templates</button>
          <button onClick={() => setTab("analytics")} className={`text-xs px-2 py-1 rounded ${tab === "analytics" ? "bg-blue-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>Analytics</button>
        </div>
        {tab === "templates" && (
          <button onClick={() => setEditing({ templateId: null })} className="ml-auto text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700">
            + New workflow
          </button>
        )}
      </div>

      {tab === "analytics" ? (
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Per-stage activity across all workspaces. Drop-off counts workspaces currently sitting on a non-terminal stage (stuck or in progress).
          </p>
          {!analytics || analytics.nodes.length === 0 ? (
            <p className="text-sm text-gray-400">No workflow activity yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="py-1.5">Stage</th><th>Type</th><th className="text-right">Visits</th><th className="text-right">Avg dwell</th><th className="text-right">Drop-off</th>
                </tr>
              </thead>
              <tbody>
                {analytics.nodes.map((n) => (
                  <tr key={n.nodeId} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-1.5 text-gray-800 dark:text-gray-200">{n.nodeName}</td>
                    <td className="text-gray-500 dark:text-gray-400 text-xs">{n.nodeType}</td>
                    <td className="text-right text-gray-700 dark:text-gray-300">{n.visits}</td>
                    <td className="text-right text-gray-700 dark:text-gray-300">{fmtDwell(n.avgDwellMs)}</td>
                    <td className={`text-right ${n.dropoff > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-400"}`}>{n.dropoff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
      <>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Workflow graphs route issues of a given ticket type through configurable stages (each mapped to a board status, with an attached skill). Built-in workflows are read-only — duplicate one to customize.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {templates.map((t) => (
          <div key={t.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3 bg-white dark:bg-gray-900">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-gray-800 dark:text-gray-100">{t.name}</span>
              {t.isBuiltin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">built-in</span>}
              {t.ticketType && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">{t.ticketType}{t.isDefault ? " default" : ""}</span>}
            </div>
            {t.description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-3">{t.description}</p>}
            <div className="text-[11px] text-gray-400 mt-2">{t.nodes?.length ?? 0} stages · {(t.edges as unknown[])?.length ?? 0} transitions</div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => setEditing({ templateId: t.id })} className="text-xs text-blue-600 hover:text-blue-700">
                {t.isBuiltin ? "View" : "Edit"}
              </button>
              <button onClick={() => duplicate(t)} className="text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800">Duplicate</button>
              {!t.isBuiltin && <button onClick={() => remove(t)} className="text-xs text-red-600 hover:text-red-700">Delete</button>}
            </div>
          </div>
        ))}
      </div>
      </>
      )}

      {editing && (
        <WorkflowBuilder
          projectId={projectId}
          templateId={editing.templateId}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
