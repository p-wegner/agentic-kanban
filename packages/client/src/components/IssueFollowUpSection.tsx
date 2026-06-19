import { useState } from "react";
import { apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface IssueFollowUpSectionProps {
  /** The issue the new task should depend on. */
  parentIssueId: string;
  projectId: string;
  /** Called after a follow-up is created (e.g. to invalidate caches). */
  onCreated?: () => void;
}

/**
 * "Create follow-up task" control. Self-contained (extracted from
 * IssueDetailPanel): creates a new issue that depends on the current one. Cache
 * invalidation lives in the parent via onCreated.
 */
export function IssueFollowUpSection({ parentIssueId, projectId, onCreated }: IssueFollowUpSectionProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  async function create() {
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      const newIssue = await apiPost<{ id: string }>("/api/issues", { title: title.trim(), description: "", priority: "medium", projectId });
      await apiPost(`/api/issues/${newIssue.id}/dependencies`, { dependsOnId: parentIssueId, type: "depends_on" }).catch(() => {});
      onCreated?.();
      setTitle("");
      setOpen(false);
      showToast("Follow-up task created", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create follow-up", "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="pt-2">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="text-xs text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 flex items-center gap-1"
        >
          <span className="font-bold text-sm leading-none">+</span> Create follow-up task
        </button>
      ) : (
        <div className="flex gap-1.5 items-center">
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void create(); if (e.key === "Escape") { setOpen(false); setTitle(""); } }}
            placeholder="Follow-up task title..."
            className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button
            onClick={create}
            disabled={!title.trim() || creating}
            className="text-xs bg-brand-600 text-white px-2 py-1 rounded hover:bg-brand-700 disabled:opacity-50 whitespace-nowrap"
          >{creating ? "…" : "Create"}</button>
          <button onClick={() => { setOpen(false); setTitle(""); }} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">✕</button>
        </div>
      )}
    </div>
  );
}
