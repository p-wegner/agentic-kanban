import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
  workspace?: {
    id: string;
    status: string;
    isDirect: boolean;
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
  };
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

interface WorktreeOverviewProps {
  projectId: string;
  onClose: () => void;
  onIssueClick: (issueId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  idle: "bg-yellow-100 text-yellow-700",
  closed: "bg-gray-100 text-gray-500",
};

function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  return "..." + path.slice(path.length - maxLen + 3);
}

export function WorktreeOverview({ projectId, onClose, onIssueClick }: WorktreeOverviewProps) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await apiFetch<WorktreeInfo[]>(`/api/projects/${projectId}/worktrees`);
        setWorktrees(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load worktrees");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [projectId]);

  const additionalWorktrees = worktrees.filter((wt) => !wt.isMain);
  const mainWorktree = worktrees.find((wt) => wt.isMain);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(480px,100vw)] bg-white shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <h2 className="text-lg font-semibold text-gray-900">Worktrees</h2>
            <span className="text-sm text-gray-500">({worktrees.length})</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-sm text-gray-500">Loading...</div>
          ) : error ? (
            <div className="p-4 text-sm text-red-600">{error}</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {/* Main checkout */}
              {mainWorktree && (
                <div className="px-4 py-3 bg-gray-50">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-900">
                      {mainWorktree.branch}
                    </span>
                    <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">main</span>
                    {mainWorktree.workspace?.isDirect && (
                      <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">direct</span>
                    )}
                    {mainWorktree.workspace && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[mainWorktree.workspace.status] ?? "bg-gray-100 text-gray-600"}`}>
                        {mainWorktree.workspace.status}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 font-mono">
                    {truncatePath(mainWorktree.path, 60)}
                  </div>
                  {mainWorktree.workspace && mainWorktree.workspace.issueNumber != null && (
                    <button
                      onClick={() => onIssueClick(mainWorktree.workspace!.issueId)}
                      className="mt-1.5 text-xs text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      #{mainWorktree.workspace.issueNumber} {mainWorktree.workspace.issueTitle}
                    </button>
                  )}
                </div>
              )}

              {/* Additional worktrees */}
              {additionalWorktrees.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-gray-500">
                  No additional worktrees
                </div>
              ) : (
                additionalWorktrees.map((wt) => (
                  <div key={wt.path} className="px-4 py-3 hover:bg-gray-50">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">
                        {wt.branch}
                      </span>
                      {wt.workspace?.isDirect && (
                        <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">direct</span>
                      )}
                      {wt.workspace && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[wt.workspace.status] ?? "bg-gray-100 text-gray-600"}`}>
                          {wt.workspace.status}
                        </span>
                      )}
                      {wt.diffStats && wt.diffStats.filesChanged > 0 && (
                        <span className="text-xs text-gray-500 ml-auto">
                          {wt.diffStats.filesChanged} file{wt.diffStats.filesChanged !== 1 ? "s" : ""},
                          {" "}{" "}
                          <span className="text-green-600">+{wt.diffStats.insertions}</span>
                          {" "}/{" "}
                          <span className="text-red-600">-{wt.diffStats.deletions}</span>
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 font-mono">
                      {truncatePath(wt.path, 60)}
                    </div>
                    {wt.workspace && wt.workspace.issueNumber != null && (
                      <button
                        onClick={() => onIssueClick(wt.workspace!.issueId)}
                        className="mt-1.5 text-xs text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        #{wt.workspace.issueNumber} {wt.workspace.issueTitle}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
