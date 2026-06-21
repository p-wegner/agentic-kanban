import { useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch, apiPost, apiDelete } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface MoveToDoneDialogProps {
  issue: IssueWithStatus;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export function MoveToDoneDialog({ issue, onConfirm, onCancel }: MoveToDoneDialogProps) {
  const [loading, setLoading] = useState(false);
  const ws = issue.workspaceSummary?.main;

  async function handle(action: "stop" | "close" | "move_only") {
    setLoading(true);
    try {
      if (action === "stop" && ws) {
        await apiPost(`/api/workspaces/${ws.id}/stop`);
      } else if (action === "close" && ws) {
        await apiDelete(`/api/workspaces/${ws.id}`);
      }
      await onConfirm();
    } catch (err) {
      // Surface the server's AK-535 guard message ("…has an open workspace that has
      // not been merged. Merge the workspace first…") instead of a generic failure,
      // so "Just move to Done" / "Stop & move to Done" on a non-direct unmerged
      // branch explains WHY it was blocked (use "Delete workspace & move to Done").
      showToast(err instanceof Error ? err.message : "Action failed", "error");
    } finally {
      setLoading(false);
    }
  }

  const isActive = ws?.status === "active";
  const branch = ws?.branch ?? "workspace";

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-md max-h-[90vh] flex flex-col p-6">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1 shrink-0">Move to Done</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 shrink-0">
          This issue has an open workspace on branch{" "}
          <span className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">{branch}</span>
          {" "}({ws?.status}). What should happen to it?
        </p>

        <div className="flex flex-col gap-2 overflow-y-auto">
          {isActive && (
            <button
              onClick={() => handle("stop")}
              disabled={loading}
              className="w-full text-left px-4 py-3 rounded-md border border-amber-300 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 transition-colors"
            >
              <div className="font-medium text-amber-900 text-sm">Stop agent & move to Done</div>
              <div className="text-xs text-amber-700 mt-0.5">Stops the running agent. The worktree and branch are kept.</div>
            </button>
          )}

          <button
            onClick={() => handle("close")}
            disabled={loading}
            className="w-full text-left px-4 py-3 rounded-md border border-red-300 bg-red-50 hover:bg-red-100 disabled:opacity-50 transition-colors"
          >
            <div className="font-medium text-red-900 text-sm">Delete workspace & move to Done</div>
            <div className="text-xs text-red-700 mt-0.5">Removes the worktree and all session data. Branch is kept in git.</div>
          </button>

          <button
            onClick={() => handle("move_only")}
            disabled={loading}
            className="w-full text-left px-4 py-3 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            <div className="font-medium text-gray-900 dark:text-gray-100 text-sm">Just move to Done</div>
            <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">Keeps the workspace open as-is.</div>
          </button>

          <button
            onClick={onCancel}
            disabled={loading}
            className="w-full px-4 py-2 rounded-md border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors mt-1"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
