import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { useWebSocket } from "../lib/useWebSocket.js";
import { TerminalView } from "./TerminalView.js";
import { DiffViewer } from "./DiffViewer.js";
import type {
  IssueWithStatus,
  WorkspaceResponse,
  DiffResponse,
} from "@agentic-kanban/shared";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
}

interface WorkspacePanelProps {
  issue: IssueWithStatus;
  project: Project | null;
  onClose: () => void;
  onWorkspaceChange?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  idle: "bg-yellow-100 text-yellow-700",
  closed: "bg-gray-100 text-gray-500",
};

export function WorkspacePanel({ issue, project, onClose, onWorkspaceChange }: WorkspacePanelProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Create form
  const [branchName, setBranchName] = useState("");
  const [prompt, setPrompt] = useState("");

  const { state: wsState, messages, disconnect } = useWebSocket(activeSession);

  async function fetchWorkspaces() {
    try {
      const data = await apiFetch<WorkspaceResponse[]>(
        `/api/issues/${issue.id}/workspaces`,
      );
      setWorkspaces(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchWorkspaces();
  }, [issue.id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleCreateWorkspace() {
    if (!branchName.trim()) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ issueId: issue.id, branch: branchName.trim() }),
      });
      setBranchName("");
      setShowCreate(false);
      await fetchWorkspaces();
      onWorkspaceChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSetup(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${wsId}/setup`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleLaunch(wsId: string) {
    if (!prompt.trim()) return;
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiFetch<{ sessionId: string }>(
        `/api/workspaces/${wsId}/launch`,
        {
          method: "POST",
          body: JSON.stringify({ prompt: prompt.trim() }),
        },
      );
      setActiveSession(result.sessionId);
      setPrompt("");
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStop(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${wsId}/stop`, { method: "POST" });
      disconnect();
      setActiveSession(null);
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleViewDiff(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiFetch<DiffResponse>(`/api/workspaces/${wsId}/diff`);
      setDiff(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get diff");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleMerge(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${wsId}/merge`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await fetchWorkspaces();
      onWorkspaceChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[480px] bg-white shadow-xl z-50 flex flex-col border-l border-gray-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">
            Workspaces — {issue.title}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {error}
              <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">
                Dismiss
              </button>
            </div>
          )}

          {/* Read-only repo info from project */}
          {project && (
            <div className="text-xs text-gray-500 space-y-0.5">
              <div><span className="font-medium text-gray-600">Repo:</span> {project.repoPath}</div>
              <div><span className="font-medium text-gray-600">Branch:</span> {project.defaultBranch}</div>
              {project.remoteUrl && (
                <div><span className="font-medium text-gray-600">Remote:</span> {project.remoteUrl}</div>
              )}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-500">Loading workspaces...</div>
          ) : workspaces.length === 0 && !showCreate ? (
            <div className="text-center py-6">
              <p className="text-sm text-gray-500 mb-3">No workspaces yet</p>
              <button
                onClick={() => setShowCreate(true)}
                className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700"
              >
                New Workspace
              </button>
            </div>
          ) : null}

          {showCreate && (
            <div className="border border-gray-200 rounded p-3 space-y-2">
              <label className="text-xs font-medium text-gray-600 block">
                Branch Name
              </label>
              <input
                type="text"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="e.g. feature/new-thing"
                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreateWorkspace}
                  disabled={actionLoading || !branchName.trim()}
                  className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  Create
                </button>
                <button
                  onClick={() => setShowCreate(false)}
                  className="text-sm text-gray-500 px-3 py-1.5 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {workspaces.map((ws) => {
            const isSelected = selectedWorkspace === ws.id;
            const badgeColor = STATUS_COLORS[ws.status] ?? "bg-gray-100 text-gray-500";

            return (
              <div
                key={ws.id}
                className={`border rounded p-3 space-y-2 cursor-pointer transition-colors ${
                  isSelected ? "border-blue-400 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                }`}
                onClick={() => setSelectedWorkspace(isSelected ? null : ws.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900">{ws.branch}</span>
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${badgeColor}`}>
                    {ws.status}
                  </span>
                </div>

                {ws.workingDir && (
                  <p className="text-xs text-gray-500 truncate">{ws.workingDir}</p>
                )}

                {isSelected && (
                  <div className="space-y-2 pt-2 border-t border-gray-200" onClick={(e) => e.stopPropagation()}>
                    {!ws.workingDir && ws.status === "active" && (
                      <button
                        onClick={() => handleSetup(ws.id)}
                        disabled={actionLoading}
                        className="text-sm bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700 disabled:opacity-50 w-full"
                      >
                        Setup Worktree
                      </button>
                    )}

                    {ws.workingDir && ws.status !== "closed" && !activeSession && (
                      <>
                        <textarea
                          value={prompt}
                          onChange={(e) => setPrompt(e.target.value)}
                          placeholder="Enter prompt for Claude Code..."
                          rows={2}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          onClick={() => handleLaunch(ws.id)}
                          disabled={actionLoading || !prompt.trim()}
                          className="text-sm bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 disabled:opacity-50 w-full"
                        >
                          Launch Agent
                        </button>
                      </>
                    )}

                    {activeSession && (
                      <>
                        <TerminalView messages={messages} connectionState={wsState} />
                        <button
                          onClick={() => handleStop(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-50 w-full"
                        >
                          Stop Agent
                        </button>
                      </>
                    )}

                    {ws.workingDir && ws.status !== "closed" && !activeSession && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleViewDiff(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-purple-600 text-white px-3 py-1.5 rounded hover:bg-purple-700 disabled:opacity-50 flex-1"
                        >
                          View Diff
                        </button>
                        <button
                          onClick={() => handleMerge(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-orange-600 text-white px-3 py-1.5 rounded hover:bg-orange-700 disabled:opacity-50 flex-1"
                        >
                          Merge
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {diff && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-900">Diff</h3>
                <button
                  onClick={() => setDiff(null)}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  Close
                </button>
              </div>
              <DiffViewer diff={diff.diff} stats={diff.stats} />
            </div>
          )}

          {workspaces.length > 0 && (
            <button
              onClick={() => setShowCreate(true)}
              className="text-sm text-blue-600 hover:text-blue-700"
            >
              + New Workspace
            </button>
          )}
        </div>
      </div>
    </>
  );
}
