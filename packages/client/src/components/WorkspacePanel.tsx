import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { useWebSocket } from "../lib/useWebSocket.js";
import { TerminalView } from "./TerminalView.js";
import { DiffViewer } from "./DiffViewer.js";
import type {
  AgentOutputMessage,
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

interface SessionInfo {
  id: string;
  workspaceId: string;
  executor: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: string | null;
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

const SESSION_STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  stopped: "bg-yellow-100 text-yellow-700",
};

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "running";
  const diffMs = new Date(end).getTime() - new Date(start).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

export function WorkspacePanel({ issue, project, onClose, onWorkspaceChange }: WorkspacePanelProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Session history state
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, SessionInfo[]>>({});
  const [historySessionId, setHistorySessionId] = useState<string | null>(null);
  const [historyMessages, setHistoryMessages] = useState<AgentOutputMessage[]>([]);

  // Chat-like state: tracks the last session per workspace for resume
  const [lastSessionPerWorkspace, setLastSessionPerWorkspace] = useState<Record<string, string>>({});
  // Track messages from completed sessions so TerminalView stays visible after exit
  const [completedMessages, setCompletedMessages] = useState<AgentOutputMessage[]>([]);
  const [lastPrompt, setLastPrompt] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Create form
  const [branchName, setBranchName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [prefs, setPrefs] = useState<Record<string, string>>({});

  const { state: wsState, messages, disconnect } = useWebSocket(activeSession);

  // Derive whether agent is currently running
  const isRunning = activeSession !== null && !messages.some(m => m.type === "exit");

  // Auto-clear activeSession when agent completes (exit message received)
  useEffect(() => {
    if (!activeSession) return;
    const exitMsg = messages.find(m => m.type === "exit");
    if (!exitMsg) return;

    // Agent has exited — store session for resume and clear active state
    const wsId = selectedWorkspace;
    const sid = activeSession;
    if (wsId) {
      setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: sid }));

      // Use WS messages if we got meaningful output; otherwise fetch from API
      const wsMessages = [...messages];
      const hasOutput = wsMessages.some(m => m.type === "stdout");
      if (hasOutput) {
        setCompletedMessages(wsMessages);
      } else {
        // WS missed output (common for fast agents via Vite proxy) — fetch from API
        apiFetch<AgentOutputMessage[]>(`/api/sessions/${sid}/output`)
          .then((data) => setCompletedMessages(data))
          .catch(() => setCompletedMessages(wsMessages));
      }

      // Refresh sessions for current workspace
      setWorkspaceSessions((prev) => {
        const next = { ...prev };
        delete next[wsId];
        return next;
      });
    }
    setActiveSession(null);
    fetchWorkspaces();
  }, [messages, activeSession]);

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
    // Load preferences (output_parser, mock_agent)
    apiFetch<Record<string, string>>("/api/preferences/settings")
      .then((s) => setPrefs(s))
      .catch(() => {});
  }, [issue.id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (historySessionId) {
          setHistorySessionId(null);
          setHistoryMessages([]);
          return;
        }
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, historySessionId]);

  // Fetch sessions for a workspace when it's expanded
  useEffect(() => {
    if (!selectedWorkspace) return;
    if (workspaceSessions[selectedWorkspace]) return;

    apiFetch<SessionInfo[]>(`/api/workspaces/${selectedWorkspace}/sessions`)
      .then((sessions) => {
        setWorkspaceSessions((prev) => ({ ...prev, [selectedWorkspace!]: sessions }));
      })
      .catch(() => {});
  }, [selectedWorkspace]);

  async function handleViewHistory(sessionId: string) {
    try {
      const msgs = await apiFetch<AgentOutputMessage[]>(`/api/sessions/${sessionId}/output`);
      setHistoryMessages(msgs);
      setHistorySessionId(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session output");
    }
  }

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
    setCompletedMessages([]);
    try {
      const body: Record<string, string> = { prompt: prompt.trim() };
      // Attach resumeFromId if we have a previous session for this workspace
      const resumeId = lastSessionPerWorkspace[wsId];
      if (resumeId) {
        body.resumeFromId = resumeId;
      }
      const result = await apiFetch<{ sessionId: string }>(
        `/api/workspaces/${wsId}/launch`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      setActiveSession(result.sessionId);
      setLastPrompt(prompt.trim());
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
      // Store session for resume before clearing
      if (activeSession) {
        setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: activeSession }));
        setCompletedMessages(messages);
      }
      setActiveSession(null);
      await fetchWorkspaces();
      // Refresh sessions for this workspace
      setWorkspaceSessions((prev) => {
        const next = { ...prev };
        delete next[wsId];
        return next;
      });
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

  // History overlay
  if (historySessionId) {
    return (
      <>
        <div className="fixed inset-0 bg-black/30 z-40" onClick={() => { setHistorySessionId(null); setHistoryMessages([]); }} />
        <div className="fixed right-0 top-0 h-full w-[480px] bg-white shadow-xl z-50 flex flex-col border-l border-gray-200">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-900">
              Session Output
            </h2>
            <button
              onClick={() => { setHistorySessionId(null); setHistoryMessages([]); }}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              &times;
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <TerminalView
              messages={historyMessages}
              connectionState="closed"
              parseOutput={prefs.output_parser !== "false"}
            />
          </div>
          <div className="px-4 py-3 border-t border-gray-200">
            <button
              onClick={() => { setHistorySessionId(null); setHistoryMessages([]); }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Back to Workspaces
            </button>
          </div>
        </div>
      </>
    );
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
            const sessions = workspaceSessions[ws.id] ?? [];
            const completedSessions = sessions.filter((s) => s.status !== "running");

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

                    {/* TerminalView — shown whenever there's output (active or completed) */}
                    {(activeSession || completedMessages.length > 0) && ws.workingDir && ws.status !== "closed" && (
                      <TerminalView
                        messages={activeSession ? messages : completedMessages}
                        connectionState={activeSession ? wsState : "closed"}
                        parseOutput={prefs.output_parser !== "false"}
                        prompt={lastPrompt}
                      />
                    )}

                    {/* Chat input — always visible for active workspaces */}
                    {ws.workingDir && ws.status !== "closed" && (
                      <div className="flex gap-2">
                        <textarea
                          ref={textareaRef}
                          value={prompt}
                          onChange={(e) => setPrompt(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && e.ctrlKey) {
                              e.preventDefault();
                              if (isRunning) {
                                handleStop(ws.id);
                              } else if (prompt.trim()) {
                                handleLaunch(ws.id);
                              }
                            }
                          }}
                          placeholder={isRunning ? "Agent is running..." : "Message Claude Code..."}
                          rows={2}
                          disabled={isRunning}
                          className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none disabled:bg-gray-50 disabled:text-gray-400"
                          onClick={(e) => e.stopPropagation()}
                        />
                        {isRunning ? (
                          <button
                            onClick={() => handleStop(ws.id)}
                            disabled={actionLoading}
                            className="text-sm bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-50 self-end"
                          >
                            Stop
                          </button>
                        ) : (
                          <button
                            onClick={() => handleLaunch(ws.id)}
                            disabled={actionLoading || !prompt.trim()}
                            className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50 self-end"
                          >
                            Send
                          </button>
                        )}
                      </div>
                    )}

                    {/* Action buttons — only when idle */}
                    {ws.workingDir && ws.status !== "closed" && !isRunning && (
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

                    {/* Past Sessions — only when idle */}
                    {completedSessions.length > 0 && !isRunning && (
                      <div className="space-y-1 pt-2 border-t border-gray-200">
                        <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                          Past Sessions ({completedSessions.length})
                        </h4>
                        {completedSessions.map((session) => {
                          const sessionBadge = SESSION_STATUS_COLORS[session.status] ?? "bg-gray-100 text-gray-500";
                          return (
                            <div
                              key={session.id}
                              className="flex items-center justify-between py-1 px-2 rounded hover:bg-gray-50"
                            >
                              <div className="flex items-center gap-2">
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${sessionBadge}`}>
                                  {session.status}
                                </span>
                                <span className="text-xs text-gray-600">
                                  {formatRelativeTime(session.startedAt)}
                                </span>
                                <span className="text-[10px] text-gray-400">
                                  ({formatDuration(session.startedAt, session.endedAt)})
                                </span>
                              </div>
                              <button
                                onClick={() => handleViewHistory(session.id)}
                                className="text-xs text-blue-600 hover:text-blue-700"
                              >
                                View Output
                              </button>
                            </div>
                          );
                        })}
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
