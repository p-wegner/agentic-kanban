import { useEffect, useState } from "react";
import type { IssueWithStatus, UpdateIssueRequest } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface StatusOption {
  id: string;
  name: string;
}

interface IssueDetailPanelProps {
  issue: IssueWithStatus;
  statuses: StatusOption[];
  onUpdate: (id: string, data: UpdateIssueRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
  onManageWorkspaces: (issue: IssueWithStatus) => void;
  onIssueUpdate: (issue: IssueWithStatus) => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

const priorityColors: Record<string, string> = {
  low: "bg-gray-200 text-gray-700",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700",
};

export function IssueDetailPanel({
  issue,
  statuses,
  onUpdate,
  onDelete,
  onClose,
  onManageWorkspaces,
  onIssueUpdate,
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

  // Track unsaved changes for warning
  const hasChanges = editing && (
    title !== issue.title ||
    description !== (issue.description ?? "") ||
    priority !== issue.priority
  );

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

  // Sync local state when issue prop changes (stale data fix - F6)
  useEffect(() => {
    if (!editing) {
      setTitle(issue.title);
      setDescription(issue.description ?? "");
      setPriority(issue.priority);
    }
  }, [issue, editing]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (editing) {
          handleCancelEdit();
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, hasChanges, issue, onClose]);

  function handleCancelEdit() {
    if (hasChanges) {
      if (!window.confirm("You have unsaved changes. Discard?")) return;
    }
    setEditing(false);
    setTitle(issue.title);
    setDescription(issue.description ?? "");
    setPriority(issue.priority);
  }

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
      // Don't close panel — F1 fix. Parent will re-render with updated data.
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(newStatusId: string) {
    if (newStatusId === issue.statusId) return;
    try {
      await onUpdate(issue.id, { statusId: newStatusId });
    } catch {
      showToast("Failed to change status", "error");
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

  function handleBackdropClick() {
    if (editing && hasChanges) {
      if (!window.confirm("You have unsaved changes. Discard?")) return;
    }
    onClose();
  }

  const badgeColor = priorityColors[issue.priority] ?? "bg-gray-200 text-gray-700";

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={handleBackdropClick}
      />
      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-[min(384px,100vw)] bg-white shadow-xl z-50 flex flex-col border-l border-gray-200 animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            {issue.issueNumber != null && (
              <span className="text-gray-400 font-mono">#{issue.issueNumber}</span>
            )}
            {editing ? "Edit Issue" : "Issue Details"}
          </h2>
          <button
            onClick={handleBackdropClick}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Title - always visible, editable in edit mode */}
          <div>
            {editing ? (
              <>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </>
            ) : (
              <h3 className="text-base font-medium text-gray-900">
                {issue.title}
              </h3>
            )}
          </div>

          {/* Description - always visible, editable in edit mode */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Description
            </label>
            {editing ? (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                placeholder="Add a description..."
              />
            ) : issue.description ? (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">
                {issue.description}
              </p>
            ) : (
              <p className="text-sm text-gray-400 italic">
                No description. Click edit to add one.
              </p>
            )}
          </div>

          {/* Status - always visible, dropdown in view mode */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Status
            </label>
            <select
              value={issue.statusId}
              onChange={(e) => handleStatusChange(e.target.value)}
              disabled={editing}
              className={`w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 ${editing ? "bg-gray-50 text-gray-500" : ""}`}
            >
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Priority - always visible, editable in edit mode */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Priority
            </label>
            {editing ? (
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
            ) : (
              <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded capitalize ${badgeColor}`}>
                {issue.priority}
              </span>
            )}
          </div>

          {/* Workspaces section - always visible */}
          {!editing && (
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
                  {workspaceCount === 0 ? "New Workspace" : "View Workspaces"}
                </button>
              </div>
            </div>
          )}

          {/* Tags section - always visible */}
          {!editing && (
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
                        } catch {
                          showToast("Failed to remove tag", "error");
                        }
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
                      } catch {
                        showToast("Failed to add tag", "error");
                      }
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
          )}

          {/* Timestamps */}
          <div className="pt-2 border-t border-gray-100">
            <div className="flex gap-4 text-xs text-gray-400">
              <span>Created {formatRelativeTime(issue.createdAt)}</span>
              <span>Updated {formatRelativeTime(issue.updatedAt)}</span>
            </div>
          </div>
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
                onClick={handleCancelEdit}
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
