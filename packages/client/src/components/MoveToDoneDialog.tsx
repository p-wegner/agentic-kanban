import { useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
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
        await apiFetch(`/api/workspaces/${ws.id}/stop`, { method: "POST" });
      } else if (action === "close" && ws) {
        await apiFetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
      }
      await onConfirm();
    } catch {
      showToast("Action failed", "error");
    } finally {
      setLoading(false);
    }
  }

  const isActive = ws?.status === "active";
  const branch = ws?.branch ?? "workspace";

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Move to Done</h2>
        <p className="text-sm text-gray-600 mb-4">
          This issue has an open workspace on branch{" "}
          <span className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">{branch}</span>
          {" "}({ws?.status}). What should happen to it?
        </p>

        <div className="flex flex-col gap-2">
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
            className="w-full text-left px-4 py-3 rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 disabled:opacity-50 transition-colors"
          >
            <div className="font-medium text-gray-900 text-sm">Just move to Done</div>
            <div className="text-xs text-gray-600 mt-0.5">Keeps the workspace open as-is.</div>
          </button>

          <button
            onClick={onCancel}
            disabled={loading}
            className="w-full px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors mt-1"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
