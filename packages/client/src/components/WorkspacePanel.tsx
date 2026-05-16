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
  DiffComment,
  CreateDiffCommentRequest,
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
  stats: string | null;
  claudeSessionId: string | null;
}

interface SessionStats {
  durationMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  model: string;
  success: boolean;
}

interface WorkspacePanelProps {
  issue: IssueWithStatus;
  project: Project | null;
  onClose: () => void;
  onWorkspaceChange?: () => void;
  initialWorkspaceId?: string;
  initialSessionId?: string;
  autoSelectId?: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  reviewing: "bg-purple-100 text-purple-700",
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

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function parseStats(statsStr: string | null | undefined): SessionStats | null {
  if (!statsStr) return null;
  try {
    return JSON.parse(statsStr);
  } catch {
    return null;
  }
}

function SessionStatsBadge({ stats }: { stats: string | null | undefined }) {
  const s = parseStats(stats);
  if (!s) return null;
  return (
    <span className="text-[10px] text-gray-400" title={`Tokens: ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out\nCost: $${s.totalCostUsd.toFixed(4)}\nDuration: ${(s.durationMs / 1000).toFixed(0)}s`}>
      ${s.totalCostUsd.toFixed(2)}
    </span>
  );
}

function SessionStatsSummary({ stats }: { stats: string | null | undefined }) {
  const s = parseStats(stats);
  if (!s) return null;
  return (
    <div className="flex items-center gap-3 text-xs text-gray-500 py-1 px-1">
      <span title="Input / output tokens">{formatTokenCount(s.inputTokens)} in / {formatTokenCount(s.outputTokens)} out</span>
      <span>${s.totalCostUsd.toFixed(2)}</span>
      <span>{(s.durationMs / 1000).toFixed(0)}s</span>
      {s.numTurns > 1 && <span>{s.numTurns} turns</span>}
    </div>
  );
}

import { suggestBranchName, sanitizeBranchName } from "../lib/branch.js";

export function WorkspacePanel({ issue, project, onClose, onWorkspaceChange, initialWorkspaceId, initialSessionId, autoSelectId }: WorkspacePanelProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(initialWorkspaceId ?? null);
  const [activeSession, setActiveSession] = useState<string | null>(initialSessionId || null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [diffComments, setDiffComments] = useState<DiffComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Session history state
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, SessionInfo[]>>({});
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [historyMessages, setHistoryMessages] = useState<AgentOutputMessage[]>([]);

  // Chat-like state: tracks the last session per workspace for resume
  const [lastSessionPerWorkspace, setLastSessionPerWorkspace] = useState<Record<string, string>>({});
  // Track messages from completed sessions so TerminalView stays visible after exit
  const [completedMessages, setCompletedMessages] = useState<AgentOutputMessage[]>([]);
  const [lastPrompt, setLastPrompt] = useState<string>(
    initialSessionId ? `${issue.title}${issue.description ? `\n\n${issue.description}` : ""}` : ""
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Create form
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [isDirect, setIsDirect] = useState(false);
  const [requiresReview, setRequiresReview] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<{ local: string[]; remote: string[] } | null>(null);
  const suggestion = suggestBranchName(issue);

  const { state: wsState, messages, disconnect, isWaitingForInput } = useWebSocket(activeSession);

  // Derive whether agent is currently running (processing a turn)
  const isRunning = activeSession !== null && !messages.some(m => m.type === "exit");
  // Whether a session is alive (may be processing or waiting for input)
  const isSessionAlive = activeSession !== null && isRunning;
  // Whether we can resume (workspace active, no session running, has previous session)
  const canResume = (ws: WorkspaceResponse) =>
    ws.status === "active" && !isRunning && !activeSession && !!lastSessionPerWorkspace[ws.id];

  // Auto-clear activeSession when agent completes.
  // Primary: detect exit via WS messages.
  // Fallback: poll session output API (WS is unreliable via Vite proxy).
  useEffect(() => {
    if (!activeSession) return;

    const wsId = selectedWorkspace;
    const sid = activeSession;
    let completed = false;

    function completeSession(output: AgentOutputMessage[]) {
      if (completed) return;
      completed = true;
      clearInterval(pollInterval);
      if (wsId) {
        setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: sid }));
        setCompletedMessages(output);
        setWorkspaceSessions((prev) => {
          const next = { ...prev };
          delete next[wsId];
          return next;
        });
      }
      setActiveSession(null);
      fetchWorkspaces();
    }

    // WS path: if exit message already in messages, complete immediately
    const exitMsg = messages.find(m => m.type === "exit");
    if (exitMsg) {
      apiFetch<AgentOutputMessage[]>(`/api/sessions/${sid}/output`)
        .then((data) => completeSession(data))
        .catch(() => completeSession([...messages]));
      return;
    }

    // Polling fallback: check session output every 1.5s
    const pollInterval = setInterval(() => {
      apiFetch<AgentOutputMessage[]>(`/api/sessions/${sid}/output`)
        .then((data) => {
          if (data.some(m => m.type === "exit")) {
            completeSession(data);
          }
        })
        .catch(() => { /* ignore poll errors */ });
    }, 1500);

    return () => clearInterval(pollInterval);
  }, [messages, activeSession]);

  async function fetchWorkspaces() {
    try {
      const data = await apiFetch<WorkspaceResponse[]>(
        `/api/issues/${issue.id}/workspaces`,
      );
      setWorkspaces(data);
      // Auto-expand: if a specific workspace was requested, or only one exists
      if (data.length > 0 && !selectedWorkspace) {
        const targetId = autoSelectId ?? (data.length === 1 ? data[0].id : undefined);
        if (targetId) {
          setSelectedWorkspace(targetId);
        }
      }
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

  // Fetch branches & pre-fill branch name when create form opens
  useEffect(() => {
    if (!showCreate || !project) return;
    setBranchName(suggestion);
    apiFetch<{ local: string[]; remote: string[] }>(`/api/projects/${project.id}/branches`)
      .then((data) => setBranches(data))
      .catch(() => setBranches(null));
  }, [showCreate]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (selectedHistoryId) {
          setSelectedHistoryId(null);
          setHistoryMessages([]);
          return;
        }
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, selectedHistoryId]);

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

  // Auto-load session output when expanding a workspace
  useEffect(() => {
    if (!selectedWorkspace) return;
    const sessions = workspaceSessions[selectedWorkspace];
    if (!sessions || sessions.length === 0) return;
    if (completedMessages.length > 0 || activeSession) return;

    const wsId = selectedWorkspace;
    const defaultPrompt = `${issue.title}${issue.description ? `\n\n${issue.description}` : ""}`;

    // If there's a running session, check if it's actually alive before connecting
    const running = sessions.find(s => s.status === "running");
    if (running) {
      apiFetch<AgentOutputMessage[]>(`/api/sessions/${running.id}/output`)
        .then((msgs) => {
          if (msgs.some(m => m.type === "exit")) {
            // Has exit message — definitely stale
            setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: running.id }));
            setCompletedMessages(msgs);
          } else if (msgs.length === 0) {
            // 0 output — stale if running >2min
            const ageMs = Date.now() - new Date(running.startedAt).getTime();
            if (ageMs > 2 * 60 * 1000) {
              setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: running.id }));
              setCompletedMessages(msgs);
            } else {
              setActiveSession(running.id);
              setLastPrompt(defaultPrompt);
            }
          } else {
            // Has output, no exit — actually running
            setActiveSession(running.id);
            setLastPrompt(defaultPrompt);
          }
        })
        .catch(() => {
          setActiveSession(running.id);
          setLastPrompt(defaultPrompt);
        });
      return;
    }

    // Otherwise load latest completed session that has output (skip empty sessions)
    const sortedCompleted = sessions
      .filter(s => s.status !== "running")
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    (async () => {
      for (const session of sortedCompleted) {
        try {
          const msgs = await apiFetch<AgentOutputMessage[]>(`/api/sessions/${session.id}/output`);
          setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: session.id }));
          if (msgs.length > 0) {
            setCompletedMessages(msgs);
            break;
          }
        } catch {
          break;
        }
      }
    })();
  }, [selectedWorkspace, workspaceSessions, activeSession]);

  async function handleViewHistory(sessionId: string) {
    try {
      const msgs = await apiFetch<AgentOutputMessage[]>(`/api/sessions/${sessionId}/output`);
      setHistoryMessages(msgs);
      setSelectedHistoryId(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session output");
    }
  }

  async function handleCreateWorkspace() {
    if (!isDirect && !branchName.trim()) return;
    setActionLoading(true);
    setError(null);
    setCompletedMessages([]);
    try {
      const body: Record<string, unknown> = { issueId: issue.id, isDirect, requiresReview, planMode };
      if (!isDirect) {
        body.branch = branchName.trim();
        if (baseBranch.trim()) {
          body.baseBranch = baseBranch.trim();
        }
      }
      const result = await apiFetch<WorkspaceResponse & { sessionId?: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setBranchName("");
      setBaseBranch("");
      setIsDirect(false);
      setShowCreate(false);
      // If auto-launched, set active session to show terminal immediately
      if (result.sessionId) {
        setSelectedWorkspace(result.id);
        setActiveSession(result.sessionId);
        setLastPrompt(`${issue.title}${issue.description ? `\n\n${issue.description}` : ""}`);
      }
      await fetchWorkspaces();
      onWorkspaceChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleLaunch(wsId: string) {
    if (!prompt.trim()) return;
    setActionLoading(true);
    setError(null);
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

  async function handleSendTurn(wsId: string) {
    if (!prompt.trim()) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch<{ ok: boolean }>(
        `/api/workspaces/${wsId}/turn`,
        {
          method: "POST",
          body: JSON.stringify({ content: prompt.trim() }),
        },
      );
      setLastPrompt(prompt.trim());
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
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
      setDiffComments(result.comments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get diff");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCreateComment(data: CreateDiffCommentRequest) {
    if (!selectedWorkspace) return;
    try {
      const result = await apiFetch<DiffComment>(`/api/workspaces/${selectedWorkspace}/comments`, {
        method: "POST",
        body: JSON.stringify(data),
      });
      setDiffComments(prev => [...prev, result]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create comment");
    }
  }

  async function handleEditComment(commentId: string, body: string) {
    if (!selectedWorkspace) return;
    try {
      await apiFetch(`/api/workspaces/${selectedWorkspace}/comments/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      setDiffComments(prev => prev.map(c => c.id === commentId ? { ...c, body, updatedAt: new Date().toISOString() } : c));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update comment");
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (!selectedWorkspace) return;
    try {
      await apiFetch(`/api/workspaces/${selectedWorkspace}/comments/${commentId}`, { method: "DELETE" });
      setDiffComments(prev => prev.filter(c => c.id !== commentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete comment");
    }
  }

  async function handleMerge(wsId: string) {
    if (isRunning && !window.confirm("Agent is still running. Stop and merge?")) return;
    setActionLoading(true);
    setError(null);
    try {
      if (isRunning) {
        await apiFetch(`/api/workspaces/${wsId}/stop`, { method: "POST" });
        setActiveSession(null);
        setCompletedMessages([]);
      }
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

  async function handleOpenTerminal(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${wsId}/terminal`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open terminal");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleResume(wsId: string) {
    setActionLoading(true);
    setError(null);
    const resumePrompt = "Continue where you left off. If you were in the middle of implementing something, pick up from where you stopped. If the implementation is complete, commit your changes and move this issue to In Review.";
    try {
      const body: Record<string, string> = {
        prompt: resumePrompt,
        resumeFromId: lastSessionPerWorkspace[wsId] || "",
      };
      const result = await apiFetch<{ sessionId: string }>(
        `/api/workspaces/${wsId}/launch`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setActiveSession(result.sessionId);
      setLastPrompt(resumePrompt);
      setPrompt("");
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleContinueFromSession(wsId: string, sessionId: string) {
    setActionLoading(true);
    setError(null);
    const continuePrompt = "Continue where you left off. If you were in the middle of implementing something, pick up from where you stopped. If the implementation is complete, commit your changes and move this issue to In Review.";
    try {
      const body: Record<string, string> = {
        prompt: continuePrompt,
        resumeFromId: sessionId,
      };
      const result = await apiFetch<{ sessionId: string }>(
        `/api/workspaces/${wsId}/launch`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setActiveSession(result.sessionId);
      setLastPrompt(continuePrompt);
      setPrompt("");
      setSelectedHistoryId(null);
      setHistoryMessages([]);
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Continue failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDeleteWorkspace(wsId: string) {
    const suffix = isRunning ? " The running agent will be stopped." : "";
    if (!window.confirm(`Delete this workspace? This removes the workspace record and all session data.${suffix}`)) return;
    setActionLoading(true);
    setError(null);
    try {
      if (isRunning) {
        await apiFetch(`/api/workspaces/${wsId}/stop`, { method: "POST" });
        setActiveSession(null);
        setCompletedMessages([]);
      }
      await apiFetch(`/api/workspaces/${wsId}`, { method: "DELETE" });
      await fetchWorkspaces();
      onWorkspaceChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[min(480px,100vw)] bg-white shadow-xl z-50 flex flex-col border-l border-gray-200 animate-slide-in-right">
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
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={isDirect}
                  onChange={(e) => setIsDirect(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span>Work directly on main checkout</span>
              </label>
              {isDirect && (
                <p className="text-xs text-gray-400">
                  Agent will work on the current branch of the main repository (no worktree created).
                </p>
              )}
              {!isDirect && (
                <>
                  <label className="text-xs font-medium text-gray-600 block">
                    Branch Name
                  </label>
                  <input
                    type="text"
                    value={branchName}
                    onChange={(e) => setBranchName(sanitizeBranchName(e.target.value))}
                    placeholder={suggestion}
                    className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <label className="text-xs font-medium text-gray-600 block mt-2">
                    Base Branch
                  </label>
                  {branches ? (
                    <select
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="">Default ({project?.defaultBranch || "main"})</option>
                      {branches.local.map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                      {branches.remote.length > 0 && (
                        <optgroup label="Remote">
                          {branches.remote.map((b) => (
                            <option key={`r/${b}`} value={b}>{b}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                      placeholder={project?.defaultBranch || "main"}
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  )}
                </>
              )}
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={requiresReview}
                  onChange={(e) => setRequiresReview(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span>Request code review before merge</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={planMode}
                  onChange={(e) => setPlanMode(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span>Plan mode (agent plans before implementing)</span>
              </label>
              <div className="flex gap-2">
                <button
                  onClick={handleCreateWorkspace}
                  disabled={actionLoading || (!isDirect && !branchName.trim())}
                  className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {actionLoading ? "Creating..." : isDirect ? "Create Direct & Launch" : "Create & Launch"}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setBaseBranch(""); setBranchName(""); setIsDirect(false); setRequiresReview(false); setPlanMode(false); }}
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
                onClick={() => { setSelectedWorkspace(isSelected ? null : ws.id); setSelectedHistoryId(null); setHistoryMessages([]); }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900">
                    {ws.branch}
                    {ws.isDirect && (
                      <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">direct</span>
                    )}
                  </span>
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${badgeColor}`}>
                    {ws.status}
                  </span>
                </div>

                {ws.workingDir && (
                  <p className="text-xs text-gray-500 truncate">{ws.workingDir}</p>
                )}

                <div className="flex gap-3 text-xs text-gray-400">
                  <span>Created {formatRelativeTime(ws.createdAt)}</span>
                  {ws.closedAt && <span>Closed {formatRelativeTime(ws.closedAt)}</span>}
                </div>

                {isSelected && (
                  <div className="space-y-2 pt-2 border-t border-gray-200" onClick={(e) => e.stopPropagation()}>
                    {/* Session selector — shown when there are completed sessions and workspace is idle */}
                    {completedSessions.length > 0 && !isRunning && ws.workingDir && ws.status !== "closed" && (
                      <div className="space-y-0.5">
                        {/* Latest tab */}
                        <button
                          onClick={() => { setSelectedHistoryId(null); setHistoryMessages([]); }}
                          className={`w-full flex items-center gap-2 py-1 px-2 rounded text-left text-xs ${
                            selectedHistoryId === null
                              ? "bg-blue-50 text-blue-700 font-medium"
                              : "hover:bg-gray-50 text-gray-600"
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${completedMessages.length > 0 ? "bg-green-500" : "bg-gray-300"}`} />
                          <span>Latest</span>
                          {completedMessages.length > 0 && (
                            <span className="text-[10px] text-gray-400 ml-auto">just now</span>
                          )}
                        </button>
                        {/* Past sessions */}
                        {completedSessions.map((session) => {
                          const sessionBadge = SESSION_STATUS_COLORS[session.status] ?? "bg-gray-100 text-gray-500";
                          const isActive = selectedHistoryId === session.id;
                          return (
                            <div key={session.id} className="flex items-center gap-1">
                              <button
                                onClick={() => handleViewHistory(session.id)}
                                className={`flex-1 flex items-center gap-2 py-1 px-2 rounded text-left text-xs ${
                                  isActive
                                    ? "bg-blue-50 text-blue-700 font-medium"
                                    : "hover:bg-gray-50 text-gray-600"
                                }`}
                              >
                                <span className={`w-1.5 h-1.5 rounded-full ${session.status === "completed" ? "bg-green-500" : session.status === "stopped" ? "bg-yellow-500" : "bg-gray-300"}`} />
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${sessionBadge}`}>
                                  {session.status}
                                </span>
                                <span className="text-xs text-gray-600">
                                  {formatRelativeTime(session.startedAt)}
                                </span>
                                <span className="text-[10px] text-gray-400 ml-auto">
                                  ({formatDuration(session.startedAt, session.endedAt)})
                                </span>
                                <SessionStatsBadge stats={session.stats} />
                              </button>
                              {session.claudeSessionId && ws.status !== "closed" && (
                                <button
                                  onClick={() => handleContinueFromSession(ws.id, session.id)}
                                  disabled={actionLoading}
                                  className="text-[10px] bg-green-600 text-white px-1.5 py-0.5 rounded hover:bg-green-700 disabled:opacity-50 shrink-0"
                                  title="Continue this session with --resume"
                                >
                                  Continue
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* TerminalView — show history output or live/completed output */}
                    {ws.workingDir && ws.status !== "closed" && (
                      (selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) ? (
                        <TerminalView
                          messages={selectedHistoryId ? historyMessages : (activeSession ? messages : completedMessages)}
                          connectionState={selectedHistoryId ? "closed" : (activeSession ? wsState : "closed")}
                          parseOutput={prefs.output_parser !== "false"}
                          prompt={selectedHistoryId ? undefined : lastPrompt}
                          title={issue.title}
                          multiTurn={isSessionAlive}
                          footer={!selectedHistoryId ? (
                            <div className="flex gap-2">
                              <textarea
                                ref={textareaRef}
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && e.ctrlKey) {
                                    e.preventDefault();
                                    if (isSessionAlive && !isWaitingForInput) {
                                      handleStop(ws.id);
                                    } else if (isWaitingForInput && prompt.trim()) {
                                      handleSendTurn(ws.id);
                                    } else if (!isRunning && prompt.trim()) {
                                      handleLaunch(ws.id);
                                    }
                                  }
                                }}
                                placeholder={isSessionAlive && !isWaitingForInput ? "Agent is working..." : "Message Claude Code..."}
                                rows={2}
                                disabled={isSessionAlive && !isWaitingForInput}
                                className="flex-1 text-sm bg-white text-gray-900 border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none disabled:bg-gray-50 disabled:text-gray-400"
                                onClick={(e) => e.stopPropagation()}
                              />
                              {isSessionAlive && !isWaitingForInput ? (
                                <button
                                  onClick={() => handleStop(ws.id)}
                                  disabled={actionLoading}
                                  className="text-sm bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-50 self-end"
                                >
                                  Stop
                                </button>
                              ) : (
                                <button
                                  onClick={() => isWaitingForInput ? handleSendTurn(ws.id) : handleLaunch(ws.id)}
                                  disabled={actionLoading || !prompt.trim()}
                                  className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50 self-end"
                                >
                                  Send
                                </button>
                              )}
                            </div>
                          ) : undefined}
                        />
                      ) : null
                    )}

                    {/* Session stats summary — shown below terminal for completed sessions */}
                    {ws.workingDir && ws.status !== "closed" && !isRunning && (
                      <SessionStatsSummary
                        stats={selectedHistoryId
                          ? completedSessions.find(s => s.id === selectedHistoryId)?.stats ?? null
                          : completedSessions.find(s => s.id === lastSessionPerWorkspace[ws.id])?.stats ?? null
                        }
                      />
                    )}

                    {/* "Back to latest" link when viewing history */}
                    {selectedHistoryId && ws.workingDir && ws.status !== "closed" && (
                      <button
                        onClick={() => { setSelectedHistoryId(null); setHistoryMessages([]); }}
                        className="text-xs text-blue-600 hover:text-blue-700"
                      >
                        &larr; Back to latest session
                      </button>
                    )}

                    {/* Chat input — only when TerminalView is not shown */}
                    {!selectedHistoryId && ws.workingDir && ws.status !== "closed" && !(selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) && (
                      <div className="flex gap-2">
                        <textarea
                          ref={textareaRef}
                          value={prompt}
                          onChange={(e) => setPrompt(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && e.ctrlKey) {
                              e.preventDefault();
                              if (isSessionAlive && !isWaitingForInput) {
                                handleStop(ws.id);
                              } else if (prompt.trim()) {
                                handleLaunch(ws.id);
                              }
                            }
                          }}
                          placeholder={isSessionAlive && !isWaitingForInput ? "Agent is working..." : "Message Claude Code..."}
                          rows={2}
                          disabled={isSessionAlive && !isWaitingForInput}
                          className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none disabled:bg-gray-50 disabled:text-gray-400"
                          onClick={(e) => e.stopPropagation()}
                        />
                        {isSessionAlive && !isWaitingForInput ? (
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

                    {/* Action buttons — visible even while agent runs */}
                    {!selectedHistoryId && ws.workingDir && ws.status !== "closed" && (
                      <div className="flex gap-2 flex-wrap">
                        {/* Resume button — shown when workspace active but no session running */}
                        {canResume(ws) && (
                          <button
                            onClick={() => handleResume(ws.id)}
                            disabled={actionLoading}
                            className="text-sm bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 disabled:opacity-50"
                          >
                            Resume
                          </button>
                        )}
                        <button
                          onClick={() => handleOpenTerminal(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-gray-700 text-white px-3 py-1.5 rounded hover:bg-gray-800 disabled:opacity-50"
                          title="Open terminal in workspace directory"
                        >
                          Terminal
                        </button>
                        <button
                          onClick={() => handleViewDiff(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-purple-600 text-white px-3 py-1.5 rounded hover:bg-purple-700 disabled:opacity-50 flex-1"
                        >
                          {ws.isDirect ? "View Changes" : "View Diff"}
                        </button>
                        <button
                          onClick={() => handleMerge(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-orange-600 text-white px-3 py-1.5 rounded hover:bg-orange-700 disabled:opacity-50 flex-1"
                        >
                          {ws.isDirect ? "Close" : "Merge"}
                        </button>
                        <button
                          onClick={() => handleDeleteWorkspace(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    )}

                    {/* Delete button for closed workspaces */}
                    {!selectedHistoryId && ws.status === "closed" && (
                      <div className="pt-2 border-t border-gray-200">
                        <button
                          onClick={() => handleDeleteWorkspace(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-50 w-full"
                        >
                          Delete
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
              <DiffViewer
                diff={diff.diff}
                stats={diff.stats}
                comments={diffComments}
                onCreateComment={handleCreateComment}
                onEditComment={handleEditComment}
                onDeleteComment={handleDeleteComment}
              />
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
