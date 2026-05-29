import { useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import type { IssueWithStatus, ShowdownResponse } from "@agentic-kanban/shared";
import { CLAUDE_MODEL_OPTIONS } from "@agentic-kanban/shared";

interface Contestant {
  skillId: string;
  skillName: string;
  model: string;
}

interface Skill {
  id: string;
  name: string;
  description?: string;
}

interface ShowdownDialogProps {
  issue: IssueWithStatus;
  skills: Skill[];
  onCreated: (showdown: ShowdownResponse) => void;
  onCancel: () => void;
}

const SLOT_LABELS = ["A", "B", "C", "D"] as const;
const SLOT_COLORS = [
  "border-blue-300 dark:border-blue-700",
  "border-purple-300 dark:border-purple-700",
  "border-teal-300 dark:border-teal-700",
  "border-orange-300 dark:border-orange-700",
] as const;

export function ShowdownDialog({ issue, skills, onCreated, onCancel }: ShowdownDialogProps) {
  const [contestants, setContestants] = useState<Contestant[]>([
    { skillId: "", skillName: "", model: "" },
    { skillId: "", skillName: "", model: "" },
  ]);
  const [loading, setLoading] = useState(false);

  function updateContestant(idx: number, field: keyof Contestant, value: string) {
    setContestants(prev => prev.map((c, i) => {
      if (i !== idx) return c;
      const updated = { ...c, [field]: value };
      // If picking a skill by ID, also set skillName
      if (field === "skillId") {
        const skill = skills.find(s => s.id === value);
        updated.skillName = skill?.name ?? "";
      }
      return updated;
    }));
  }

  function addContestant() {
    if (contestants.length >= 4) return;
    setContestants(prev => [...prev, { skillId: "", skillName: "", model: "" }]);
  }

  function removeContestant(idx: number) {
    if (contestants.length <= 2) return;
    setContestants(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleStart() {
    if (loading) return;
    setLoading(true);
    try {
      const result = await apiFetch<ShowdownResponse>(`/api/issues/${issue.id}/showdown`, {
        method: "POST",
        body: JSON.stringify({
          contestants: contestants.map(c => ({
            skillId: c.skillId || undefined,
            model: c.model || undefined,
          })),
        }),
      });
      showToast(`Showdown started with ${result.contestants.length} contestants`, "success");
      onCreated(result);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to start showdown", "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg border border-gray-200 dark:border-gray-700">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <span className="text-lg">⚔️</span>
              Start Showdown
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Run the same ticket with different skills or models simultaneously
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {contestants.map((contestant, idx) => (
            <div
              key={idx}
              className={`rounded-lg border-2 p-3 bg-gray-50 dark:bg-gray-800/50 ${SLOT_COLORS[idx]}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">
                  Contestant {SLOT_LABELS[idx]}
                </span>
                {contestants.length > 2 && (
                  <button
                    onClick={() => removeContestant(idx)}
                    className="text-gray-400 hover:text-red-500 text-sm leading-none"
                    title="Remove contestant"
                  >
                    &times;
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-0.5">Skill</label>
                  <select
                    value={contestant.skillId}
                    onChange={e => updateContestant(idx, "skillId", e.target.value)}
                    className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Default (no skill)</option>
                    {skills.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-0.5">Model</label>
                  <select
                    value={contestant.model}
                    onChange={e => updateContestant(idx, "model", e.target.value)}
                    className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {CLAUDE_MODEL_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ))}

          {contestants.length < 4 && (
            <button
              onClick={addContestant}
              className="w-full text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg py-2 transition-colors"
            >
              + Add Contestant ({contestants.length}/4)
            </button>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={loading}
            className="px-4 py-1.5 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {loading ? (
              <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
            ) : (
              <span>⚔️</span>
            )}
            {loading ? "Starting..." : `Start Showdown (${contestants.length} contestants)`}
          </button>
        </div>
      </div>
    </div>
  );
}
