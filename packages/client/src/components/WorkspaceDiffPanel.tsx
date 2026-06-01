import { apiFetch } from "../lib/api.js";
import { DiffViewer } from "./DiffViewer.js";
import type { DiffResponse, DiffComment, CreateDiffCommentRequest } from "@agentic-kanban/shared";

interface WorkspaceDiffPanelProps {
  diff: DiffResponse;
  diffComments: DiffComment[];
  workspaceId: string;
  onClose: () => void;
  onCommentsChange: (comments: DiffComment[]) => void;
  onError: (msg: string) => void;
}

export function WorkspaceDiffPanel({ diff, diffComments, workspaceId, onClose, onCommentsChange, onError }: WorkspaceDiffPanelProps) {
  async function handleCreateComment(data: CreateDiffCommentRequest) {
    try {
      const result = await apiFetch<DiffComment>(`/api/workspaces/${workspaceId}/comments`, {
        method: "POST",
        body: JSON.stringify(data),
      });
      onCommentsChange([...diffComments, result]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create comment");
    }
  }

  async function handleEditComment(commentId: string, body: string) {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/comments/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      onCommentsChange(diffComments.map(c => c.id === commentId ? { ...c, body, updatedAt: new Date().toISOString() } : c));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update comment");
    }
  }

  async function handleDeleteComment(commentId: string) {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/comments/${commentId}`, { method: "DELETE" });
      onCommentsChange(diffComments.filter(c => c.id !== commentId));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete comment");
    }
  }

  async function handleResolveComment(commentId: string, resolved: boolean) {
    try {
      const result = await apiFetch<DiffComment>(`/api/workspaces/${workspaceId}/comments/${commentId}/resolve`, {
        method: "PATCH",
        body: JSON.stringify({ resolved }),
      });
      onCommentsChange(diffComments.map(c => c.id === commentId ? { ...c, resolvedAt: result.resolvedAt } : c));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update comment");
    }
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Diff</h3>
        <button
          onClick={onClose}
          className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
        >
          Close
        </button>
      </div>
      <div className="max-h-[500px] overflow-y-auto">
      <DiffViewer
        diff={diff.diff}
        stats={diff.stats}
        comments={diffComments}
        onCreateComment={handleCreateComment}
        onEditComment={handleEditComment}
        onDeleteComment={handleDeleteComment}
        onResolveComment={handleResolveComment}
      />
      </div>
    </div>
  );
}
