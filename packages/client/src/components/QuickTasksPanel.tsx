import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface Skill {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  isBuiltin: boolean;
}

interface QuickTasksPanelProps {
  projectId: string;
  onClose: () => void;
  onLaunched: () => void;
}

export function QuickTasksPanel({ projectId, onClose, onLaunched }: QuickTasksPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [extraContext, setExtraContext] = useState("");
  const [showContext, setShowContext] = useState(false);

  useEffect(() => {
    apiFetch<Skill[]>(`/api/agent-skills?projectId=${projectId}`)
      .then(setSkills)
      .catch(() => showToast("Failed to load skills", "error"))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function launch(skillId: string | null, prompt: string) {
    if (!prompt.trim()) return;
    setLaunching(skillId ?? "custom");
    const fullPrompt = extraContext.trim()
      ? `${prompt.trim()}\n\nAdditional context: ${extraContext.trim()}`
      : prompt.trim();
    try {
      // Create a temporary issue for this task, then a direct workspace
      const issue = await apiFetch<{ id: string }>("/api/issues", {
        method: "POST",
        body: JSON.stringify({ title: fullPrompt.slice(0, 100), projectId }),
      });
      await apiFetch("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ issueId: issue.id, isDirect: true, skillId: skillId ?? undefined }),
      });
      showToast("Task launched", "success");
      onLaunched();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Launch failed", "error");
      setLaunching(null);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-xl shadow-2xl z-50 border border-gray-200 overflow-hidden flex flex-col max-h-[85vh] animate-slide-in-right">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Quick Tasks</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        <div className="p-3 space-y-1.5 overflow-y-auto flex-1 min-h-0">
          {loading && <p className="text-xs text-gray-400 text-center py-4">Loading skills...</p>}

          {!loading && skills.map((skill) => (
            <button
              key={skill.id}
              disabled={!!launching}
              onClick={() => launch(skill.id, skill.description ?? skill.name)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-blue-50 border border-transparent hover:border-blue-200 transition-colors disabled:opacity-50 group"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-800">{skill.name}</span>
                <div className="flex items-center gap-1.5">
                  {skill.model && <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{skill.model}</span>}
                  {launching === skill.id
                    ? <span className="text-xs text-blue-500">Launching...</span>
                    : <span className="text-xs text-gray-400 opacity-0 group-hover:opacity-100">▶ Run</span>}
                </div>
              </div>
              {skill.description && (
                <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{skill.description}</p>
              )}
            </button>
          ))}

          {!loading && skills.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-4">No skills configured. Add skills in Settings → Skills.</p>
          )}
        </div>

        <div className="px-3 pb-3 border-t border-gray-100 pt-2 space-y-2">
          {showContext && (
            <div>
              <textarea
                autoFocus={!showCustom}
                value={extraContext}
                onChange={(e) => setExtraContext(e.target.value)}
                placeholder="Extra context appended to any task (e.g. 'focus on the auth module', 'issue #42')..."
                rows={2}
                className="w-full text-xs border border-amber-200 bg-amber-50 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400 resize-none"
                onKeyDown={(e) => { if (e.key === "Escape") { setShowContext(false); setExtraContext(""); } }}
              />
            </div>
          )}
          {showCustom ? (
            <div className="space-y-2">
              <textarea
                autoFocus
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Describe the task for the agent..."
                rows={3}
                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                onKeyDown={(e) => { if (e.key === "Escape") setShowCustom(false); }}
              />
              <div className="flex gap-2">
                <button
                  disabled={!customPrompt.trim() || !!launching}
                  onClick={() => launch(null, customPrompt)}
                  className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {launching === "custom" ? "Launching..." : "Run"}
                </button>
                <button onClick={() => setShowCustom(false)} className="text-sm text-gray-500 px-3 py-1.5 hover:text-gray-700">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <button
                onClick={() => setShowCustom(true)}
                className="text-xs text-gray-400 hover:text-gray-600 py-1.5 text-left"
              >
                + Custom task prompt...
              </button>
              <button
                onClick={() => { setShowContext(!showContext); if (showContext) setExtraContext(""); }}
                className={`text-xs py-1.5 px-2 rounded ${showContext ? "text-amber-600 bg-amber-50" : "text-gray-400 hover:text-gray-600"}`}
                title="Add extra context appended to every task"
              >
                {showContext ? "− context" : "+ context"}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
