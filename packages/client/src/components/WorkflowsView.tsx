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

export function WorkflowsView({ projectId }: { projectId: string }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<{ templateId: string | null } | null>(null);

  const load = useCallback(() => {
    apiFetch<Template[]>(`/api/workflows/templates?projectId=${projectId}&graph=1`).then(setTemplates).catch(() => {});
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

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
      <div className="flex items-center mb-3">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Workflows</h2>
        <button onClick={() => setEditing({ templateId: null })} className="ml-auto text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700">
          + New workflow
        </button>
      </div>
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
