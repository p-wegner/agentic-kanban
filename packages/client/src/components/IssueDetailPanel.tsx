import { useEffect, useState } from "react";
import type { IssueWithStatus, UpdateIssueRequest } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";

interface IssueDetailPanelProps {
  issue: IssueWithStatus;
  onUpdate: (id: string, data: UpdateIssueRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
  onManageWorkspaces: (issue: IssueWithStatus) => void;
}

export function IssueDetailPanel({
  issue,
  onUpdate,
  onDelete,
  onClose,
  onManageWorkspaces,
}: IssueDetailPanelProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? "");
  const [priority, setPriority] = useState(issue.priority);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [issueTags, setIssueTags] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [allTags, setAllTags] = useState<{ id: string; name: string; color: string | null }[]>([]);

  useEffect(() => {
    async function loadData() {
      try {
        const [ws, tags, available] = await Promise.all([
          apiFetch<{ id: string }[]>(`/api/issues/${issue.id}/workspaces`),
          apiFetch<{ id: string; name: string; color: string | null }[]>(`/api/issues/${issue.id}/tags`),
          apiFetch<{ id: string; name: string; color: string | null }[]>(`/api/tags`),
        ]);
        setWorkspaceCount(ws.length);
        setIssueTags(tags);
        setAllTags(available);
      } catch {
        // Ignore — non-critical
      }
    }
    loadData();
  }, [issue.id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (editing) {
          setEditing(false);
          setTitle(issue.title);
          setDescription(issue.description ?? "");
          setPriority(issue.priority);
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, issue, onClose]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      await onUpdate(issue.id, {
        title: title.trim(),
        description: description.trim() || undefined,
        priority: priority as UpdateIssueRequest["priority"],
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    try {
      await onDelete(issue.id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />
      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-96 bg-white shadow-xl z-50 flex flex-col border-l border-gray-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">
            {editing ? "Edit Issue" : "Issue Details"}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {editing ? (
            <>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  Priority
                </label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </>
          ) : (
            <>
              <div>
                <h3 className="text-base font-medium text-gray-900">
                  {issue.title}
                </h3>
              </div>
              {issue.description && (
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">
                    Description
                  </label>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">
                    {issue.description}
                  </p>
                </div>
              )}
              <div className="flex gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">
                    Priority
                  </label>
                  <span className="text-sm text-gray-900 capitalize">
                    {issue.priority}
                  </span>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">
                    Status
                  </label>
                  <span className="text-sm text-gray-900">
                    {issue.statusName}
                  </span>
                </div>
              </div>

              {/* Workspaces section */}
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  Workspaces
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-900">
                    {workspaceCount} workspace{workspaceCount !== 1 ? "s" : ""}
                  </span>
                  <button
                    onClick={() => onManageWorkspaces(issue)}
                    className="text-xs text-blue-600 hover:text-blue-700"
                  >
                    Manage
                  </button>
                </div>
              </div>

              {/* Tags section */}
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  Tags
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {issueTags.map((tag) => (
                    <span
                      key={tag.id}
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700"
                      style={tag.color ? { backgroundColor: tag.color + "22", color: tag.color } : undefined}
                    >
                      {tag.name}
                      <button
                        onClick={async () => {
                          try {
                            await apiFetch(`/api/issues/${issue.id}/tags/${tag.id}`, { method: "DELETE" });
                            setIssueTags((prev) => prev.filter((t) => t.id !== tag.id));
                          } catch {}
                        }}
                        className="text-gray-400 hover:text-gray-600"
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                  {allTags.filter((t) => !issueTags.some((it) => it.id === t.id)).length > 0 && (
                    <select
                      className="text-xs border border-gray-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      value=""
                      onChange={async (e) => {
                        const tagId = e.target.value;
                        if (!tagId) return;
                        try {
                          await apiFetch(`/api/issues/${issue.id}/tags`, {
                            method: "POST",
                            body: JSON.stringify({ tagId }),
                          });
                          const tag = allTags.find((t) => t.id === tagId);
                          if (tag) setIssueTags((prev) => [...prev, tag]);
                        } catch {}
                      }}
                    >
                      <option value="">+ Add tag</option>
                      {allTags
                        .filter((t) => !issueTags.some((it) => it.id === t.id))
                        .map((tag) => (
                          <option key={tag.id} value={tag.id}>{tag.name}</option>
                        ))}
                    </select>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-gray-200 flex gap-2">
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving || !title.trim()}
                className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setTitle(issue.title);
                  setDescription(issue.description ?? "");
                  setPriority(issue.priority);
                }}
                className="text-sm text-gray-500 px-4 py-1.5 hover:text-gray-700"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setEditing(true)}
                className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700"
              >
                Edit
              </button>
              <button
                onClick={handleDelete}
                disabled={saving}
                className={`text-sm px-4 py-1.5 rounded ${
                  confirmDelete
                    ? "bg-red-600 text-white hover:bg-red-700"
                    : "text-red-600 hover:bg-red-50"
                } disabled:opacity-50`}
              >
                {confirmDelete ? "Confirm Delete" : "Delete"}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
