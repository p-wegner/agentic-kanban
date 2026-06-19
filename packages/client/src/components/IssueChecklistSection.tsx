import { useEffect, useState } from "react";
import { apiPatch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import {
  addChecklistItem,
  toggleChecklistItem,
  removeChecklistItem,
  checklistProgress,
  type ChecklistItem,
} from "../lib/checklist.js";

interface IssueChecklistSectionProps {
  issueId: string;
  /** The persisted checklist from the issue payload; seeds local state. */
  initialChecklist: ChecklistItem[] | undefined;
}

/**
 * Acceptance-criteria checklist. Self-contained section (extracted from the
 * IssueDetailPanel god-component): owns its draft state, persists each change
 * immediately via PATCH, and re-seeds when navigated to a different issue.
 *
 * Checklist edits persist immediately and have no draft/edit-mode coupling, so —
 * unlike the panel's edit-form fields — re-seeding on issue change is always safe.
 */
export function IssueChecklistSection({ issueId, initialChecklist }: IssueChecklistSectionProps) {
  const [checklist, setChecklist] = useState<ChecklistItem[]>(initialChecklist ?? []);
  const [newItem, setNewItem] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-seed when switching to a different issue (the panel reuses one instance
  // across trail navigation). Keyed on issueId — same-issue board refreshes don't
  // clobber the locally-persisted list.
  useEffect(() => {
    setChecklist(initialChecklist ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  async function persist(updated: ChecklistItem[]) {
    setSaving(true);
    try {
      await apiPatch(`/api/issues/${issueId}`, { checklist: updated });
    } catch {
      showToast("Failed to save checklist", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleAdd() {
    if (saving) return;
    const updated = addChecklistItem(checklist, newItem);
    if (!updated) return;
    setChecklist(updated);
    setNewItem("");
    await persist(updated);
  }

  async function handleToggle(itemId: string) {
    const updated = toggleChecklistItem(checklist, itemId);
    setChecklist(updated);
    await persist(updated);
  }

  async function handleRemove(itemId: string) {
    const updated = removeChecklistItem(checklist, itemId);
    setChecklist(updated);
    await persist(updated);
  }

  const progress = checklistProgress(checklist);

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Acceptance Criteria
        </label>
        {progress.total > 0 && (
          <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${
            progress.allComplete
              ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
              : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
          }`}>
            {progress.done}/{progress.total}
          </span>
        )}
      </div>
      {checklist.length > 0 && (
        <ul className="space-y-1 mb-2">
          {checklist.map((item) => (
            <li key={item.id} className="flex items-start gap-2 group">
              <button
                type="button"
                onClick={() => handleToggle(item.id)}
                disabled={saving}
                title={item.completed ? "Mark incomplete" : "Mark complete"}
                className={`mt-0.5 h-4 w-4 shrink-0 rounded border transition-colors disabled:opacity-50 flex items-center justify-center ${
                  item.completed
                    ? "bg-green-500 border-green-500 text-white"
                    : "border-gray-300 dark:border-gray-600 hover:border-green-400"
                }`}
              >
                {item.completed && (
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
              <span className={`flex-1 text-sm leading-tight ${item.completed ? "line-through text-gray-400 dark:text-gray-500" : "text-gray-700 dark:text-gray-300"}`}>
                {item.text}
              </span>
              <button
                type="button"
                onClick={() => handleRemove(item.id)}
                disabled={saving}
                className="opacity-0 group-hover:opacity-100 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-opacity disabled:opacity-0 shrink-0"
                title="Remove item"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-1.5">
        <input
          type="text"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleAdd(); } }}
          placeholder="Add acceptance criterion..."
          className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={!newItem.trim() || saving}
          className="text-xs px-2 py-1 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add
        </button>
      </div>
    </div>
  );
}
