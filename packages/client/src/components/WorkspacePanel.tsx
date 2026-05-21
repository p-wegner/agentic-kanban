import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { getOutputFormatForAgent } from "../lib/agent-output-parser.js";
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
  SessionSummaryResponse,
} from "@agentic-kanban/shared";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
  setupScript?: string | null;
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
  providerSessionId: string | null;
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
  initialShowCreate?: boolean;
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

export function WorkspacePanel({ issue, project, onClose, onWorkspaceChange, initialWorkspaceId, initialSessionId, autoSelectId, initialShowCreate }: WorkspacePanelProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(initialShowCreate ?? false);
  const [quickDropdownOpen, setQuickDropdownOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(initialWorkspaceId ?? null);
  const [activeSession, setActiveSession] = useState<string | null>(initialSessionId || null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [diffComments, setDiffComments] = useState<DiffComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [conflictState, setConflictState] = useState<{ hasConflicts: boolean; conflictingFiles: string[] } | null>(null);
  const [mergeError, setMergeError] = useState<{ wsId: string; message: string } | null>(null);

  // Session history state
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, SessionInfo[]>>({});
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [historyMessages, setHistoryMessages] = useState<AgentOutputMessage[]>([]);

  // Session summary state
  const [viewMode, setViewMode] = useState<"output" | "summary">("output");
  const [summaryData, setSummaryData] = useState<SessionSummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summarySessionId, setSummarySessionId] = useState<string | null>(null);

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
  const [thoroughReview, setThoroughReview] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [skipSetup, setSkipSetup] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<{ local: string[]; remote: string[] } | null>(null);
  const [availableSkills, setAvailableSkills] = useState<{ id: string; name: string; description: string }[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const suggestion = suggestBranchName(issue);

  const { state: wsState, messages, disconnect, isWaitingForInput } = useWebSocket(activeSession);

  // Derive whether agent is currently running (processing a turn)
  const isRunning = activeSession !== null && !messages.some(m => m.type === "exit");
  // Whether a session is alive (may be processing or waiting for input)
  const isSessionAlive = activeSession !== null && isRunning;
  // Whether we can resume (workspace not closed, no session running, has previous session with providerSessionId)
  const canResume = (ws: WorkspaceResponse, sessions: SessionInfo[]) =>
    (ws.status === "active" || ws.status === "idle") && !isRunning && !activeSession &&
    !!lastSessionPerWorkspace[ws.id] &&
    sessions.some(s => s.id === lastSessionPerWorkspace[ws.id] && s.providerSessionId);
  // Whether we can restart (workspace not closed, no session running, but last session has no providerSessionId)
  const canRestart = (ws: WorkspaceResponse, sessions: SessionInfo[]) =>
    (ws.status === "active" || ws.status === "idle") && !isRunning && !activeSession &&
    !!lastSessionPerWorkspace[ws.id] &&
    sessions.some(s => s.id === lastSessionPerWorkspace[ws.id] && !s.providerSessionId);

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
      .then((s) => {
        setPrefs(s);
        setRequiresReview(s.auto_review !== "false");
      })
      .catch(() => {});
  }, [issue.id]);

  // Fetch branches & profiles & pre-fill branch name when create form opens
  useEffect(() => {
    if (!showCreate || !project) return;
    setBranchName(suggestion);
    apiFetch<{ local: string[]; remote: string[] }>(`/api/projects/${project.id}/branches`)
      .then((data) => setBranches(data))
      .catch(() => setBranches(null));
    apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles")
      .then((data) => {
        setAvailableProfiles(data.profiles);
        // Pre-select the currently configured profile
        apiFetch<Record<string, string>>("/api/preferences/settings")
          .then((s) => setSelectedProfile(s.claude_profile || ""))
          .catch(() => {});
      })
      .catch(() => {});
  }, [showCreate]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
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

  // Auto-load diff/conflicts when an idle non-direct workspace is selected
  useEffect(() => {
    if (!selectedWorkspace) return;
    const ws = workspaces.find(w => w.id === selectedWorkspace);
    if (!ws || ws.isDirect || ws.status !== "idle") return;
    if (diff || conflictState) return;
    apiFetch<DiffResponse>(`/api/workspaces/${selectedWorkspace}/diff`)
      .then((result) => {
        setDiff(result);
        setDiffComments(result.comments ?? []);
        if (result.conflicts) setConflictState(result.conflicts);
      })
      .catch(() => {});
  }, [selectedWorkspace, workspaces]);

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
            setSelectedHistoryId(running.id);
            setHistoryMessages(msgs);
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
            setSelectedHistoryId(session.id);
            setHistoryMessages(msgs);
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
      setViewMode("output");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session output");
    }
  }

  async function handleFetchSummary(sessionId: string, force = false) {
    if (!force && summarySessionId === sessionId && summaryData) return;
    setSummaryLoading(true);
    setSummaryData(null);
    try {
      const data = await apiFetch<SessionSummaryResponse>(`/api/sessions/${sessionId}/summary`);
      setSummaryData(data);
      setSummarySessionId(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session summary");
    } finally {
      setSummaryLoading(false);
    }
  }

  async function handleCreateWorkspace() {
    if (!isDirect && !branchName.trim()) return;
    setActionLoading(true);
    setError(null);
    setCompletedMessages([]);
    try {
      const body: Record<string, unknown> = { issueId: issue.id, isDirect, requiresReview, thoroughReview, planMode, skipSetup };
      if (selectedSkillId) body.skillId = selectedSkillId;
      if (selectedProfile) body.claudeProfile = selectedProfile;
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
      setSelectedSkillId("");
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

  async function handleQuickLaunch(withPlanMode: boolean) {
    setActionLoading(true);
    setError(null);
    setCompletedMessages([]);
    setQuickDropdownOpen(false);
    try {
      const body: Record<string, unknown> = {
        issueId: issue.id,
        isDirect: false,
        requiresReview,
        planMode: withPlanMode,
        branch: suggestion,
      };
      const result = await apiFetch<WorkspaceResponse & { sessionId?: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setShowCreate(false);
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
      setViewMode("output");
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
      const result = await apiFetch<{ ok?: boolean; sessionId?: string; resumed?: boolean }>(
        `/api/workspaces/${wsId}/turn`,
        {
          method: "POST",
          body: JSON.stringify({ content: prompt.trim() }),
        },
      );
      setLastPrompt(prompt.trim());
      setPrompt("");
      // If server resumed via a new process, wire up the new session
      if (result.resumed && result.sessionId) {
        setCompletedMessages([]);
        setActiveSession(result.sessionId);
        setViewMode("output");
      }
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
      if (result.conflicts) {
        setConflictState(result.conflicts);
      }
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
    setMergeError(null);
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
      const message = err instanceof Error ? err.message : "Merge failed";
      setError(message);
      setMergeError({ wsId, message });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleFixAndMerge(wsId: string, errorMessage: string) {
    setActionLoading(true);
    setError(null);
    setMergeError(null);
    try {
      const result = await apiFetch<{ sessionId: string }>(`/api/workspaces/${wsId}/fix-and-merge`, {
        method: "POST",
        body: JSON.stringify({ mergeError: errorMessage }),
      });
      setActiveSession(result.sessionId);
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fix-and-merge launch failed");
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
      setError(err instanceof Error ? err.message : "Terminal launch failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUpdateBase(wsId: string, mode: "rebase" | "merge") {
    setActionLoading(true);
    setError(null);
    setConflictState(null);
    try {
      const result = await apiFetch<{ success: boolean; conflictingFiles?: string[]; error?: string }>(
        `/api/workspaces/${wsId}/update-base`,
        { method: "POST", body: JSON.stringify({ mode }) },
      );
      if (!result.success && result.conflictingFiles?.length) {
        setConflictState({ hasConflicts: true, conflictingFiles: result.conflictingFiles });
      } else if (!result.success) {
        setError(result.error || "Update base failed");
      } else {
        await fetchWorkspaces();
        onWorkspaceChange?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update base failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAbortRebase(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${wsId}/abort-rebase`, { method: "POST" });
      setConflictState(null);
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Abort failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleResolveConflicts(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiFetch<{ sessionId: string }>(
        `/api/workspaces/${wsId}/resolve-conflicts`,
        { method: "POST" },
      );
      setActiveSession(result.sessionId);
      setCompletedMessages([]);
      setConflictState(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolve conflicts failed");
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

  async function handleRestart(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      // Try to fetch the previous session's summary to give the new session context
      const prevSessionId = lastSessionPerWorkspace[wsId];
      let contextSection = "";
      if (prevSessionId) {
        try {
          const summary = await apiFetch<SessionSummaryResponse>(`/api/sessions/${prevSessionId}/summary`);
          const parts: string[] = [];
          if (summary.agentSummary) {
            parts.push(`## Previous session summary\n${summary.agentSummary}`);
          }
          if (summary.filesRead.length > 0) {
            parts.push(`## Files already explored\n${summary.filesRead.join("\n")}`);
          }
          if (summary.filesEdited.length > 0) {
            parts.push(`## Files already modified\n${summary.filesEdited.join("\n")}`);
          }
          if (summary.keyExcerpts.length > 0) {
            parts.push(`## Key findings from previous session\n${summary.keyExcerpts.join("\n")}`);
          }
          if (parts.length > 0) {
            contextSection = `\n\nA previous session worked on this task but was interrupted before finishing. Here is what was already explored so you can pick up without re-reading the same files:\n\n${parts.join("\n\n")}`;
          }
        } catch {
          // Summary fetch failed — proceed without context
        }
      }
      const restartPrompt = `Continue where the previous session left off. If you were in the middle of implementing something, pick up from where it stopped. If the implementation is complete, commit your changes and move this issue to In Review.${contextSection}`;
      const result = await apiFetch<{ sessionId: string }>(
        `/api/workspaces/${wsId}/launch`,
        { method: "POST", body: JSON.stringify({ prompt: restartPrompt }) },
      );
      setActiveSession(result.sessionId);
      setLastPrompt(restartPrompt);
      setPrompt("");
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restart failed");
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

  async function handleReview(wsId: string, thorough = false) {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiFetch<{ sessionId: string }>(`/api/workspaces/${wsId}/review`, {
        method: "POST",
        body: thorough ? JSON.stringify({ thoroughReview: true }) : undefined,
      });
      setActiveSession(result.sessionId);
      setCompletedMessages([]);
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start review");
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
              <button onClick={() => { setError(null); setMergeError(null); }} className="ml-2 text-red-400 hover:text-red-600">
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
              <div className="inline-flex relative">
                <button
                  onClick={() => handleQuickLaunch(false)}
                  disabled={actionLoading}
                  className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-l hover:bg-blue-700 disabled:opacity-50"
                >
                  {actionLoading ? "Creating..." : "New Workspace"}
                </button>
                <button
                  onClick={() => setQuickDropdownOpen((o) => !o)}
                  disabled={actionLoading}
                  className="text-sm bg-blue-600 text-white px-2 py-1.5 rounded-r border-l border-blue-500 hover:bg-blue-700 disabled:opacity-50"
                  title="More options"
                >
                  ▾
                </button>
                {quickDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-gray-200 rounded shadow-lg z-10">
                    <button
                      onClick={() => handleQuickLaunch(false)}
                      className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50"
                    >
                      New Workspace
                    </button>
                    <button
                      onClick={() => handleQuickLaunch(true)}
                      className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50"
                    >
                      New Workspace with Plan Mode
                    </button>
                    <div className="border-t border-gray-100" />
                    <button
                      onClick={() => {
                        setQuickDropdownOpen(false);
                        setShowCreate(true);
                        if (availableSkills.length === 0) {
                          const url = project ? `/api/agent-skills?projectId=${project.id}` : "/api/agent-skills";
                          apiFetch<{ id: string; name: string; description: string }[]>(url)
                            .then(setAvailableSkills)
                            .catch(() => {});
                        }
                      }}
                      className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 text-gray-500"
                    >
                      Custom options...
                    </button>
                  </div>
                )}
              </div>
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
                  checked={thoroughReview}
                  onChange={(e) => setThoroughReview(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span>Use thorough review (more capable model — slower &amp; costlier)</span>
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
              {project?.setupScript && (
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={skipSetup}
                    onChange={(e) => setSkipSetup(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span>Skip setup script</span>
                </label>
              )}
              {availableSkills.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-gray-600 block">
                    Agent Skill
                  </label>
                  <select
                    value={selectedSkillId}
                    onChange={(e) => setSelectedSkillId(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">None (default)</option>
                    {availableSkills.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} — {s.description}</option>
                    ))}
                  </select>
                </div>
              )}
              {availableProfiles.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Profile</label>
                  <select
                    value={selectedProfile}
                    onChange={(e) => setSelectedProfile(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Default ({prefs.claude_profile || "none"})</option>
                    {availableProfiles.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleCreateWorkspace}
                  disabled={actionLoading || (!isDirect && !branchName.trim())}
                  className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {actionLoading ? "Creating..." : isDirect ? "Create Direct & Launch" : "Create & Launch"}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setBaseBranch(""); setBranchName(""); setIsDirect(false); setRequiresReview(false); setThoroughReview(false); setPlanMode(false); setSkipSetup(false); }}
                  className="text-sm text-gray-500 px-3 py-1.5 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {workspaces.map((ws) => {
            const isSelected = selectedWorkspace === ws.id;
            const isThisRunning = isSelected && isRunning;
            const isLaunching = isSelected && ws.status === "active" && activeSession && messages.length === 0;
            const badgeColor = STATUS_COLORS[ws.status] ?? "bg-gray-100 text-gray-500";
            const sessions = workspaceSessions[ws.id] ?? [];
            const completedSessions = sessions.filter((s) => s.status !== "running");

            return (
              <div
                key={ws.id}
                className={`border rounded p-3 space-y-2 cursor-pointer transition-colors ${
                  isSelected ? "border-blue-400 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                }`}
                onClick={() => { setSelectedWorkspace(isSelected ? null : ws.id); setSelectedHistoryId(null); setHistoryMessages([]); setViewMode("output"); }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900">
                    {ws.branch}
                    {ws.isDirect && (
                      <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">direct</span>
                    )}
                    {ws.planMode && (
                      <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">plan</span>
                    )}
                  </span>
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    isThisRunning ? "bg-green-100 text-green-700 animate-pulse" :
                    isLaunching ? "bg-blue-100 text-blue-700 animate-pulse" :
                    badgeColor
                  }`}>
                    {isThisRunning ? "running" : isLaunching ? "launching…" : ws.status}
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
                    {/* Session selector — shown when there are completed sessions */}
                    {completedSessions.length > 0 && !isRunning && (
                      <div className="space-y-0.5">
                        {completedSessions.map((session) => {
                          const sessionBadge = SESSION_STATUS_COLORS[session.status] ?? "bg-gray-100 text-gray-500";
                          const isActive = selectedHistoryId === session.id;
                          return (
                            <div key={session.id} className="flex items-center gap-1">
                              <button
                                data-session-id={session.id}
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
                              {ws.status !== "closed" && (
                                session.providerSessionId ? (
                                  <button
                                    onClick={() => handleContinueFromSession(ws.id, session.id)}
                                    disabled={actionLoading}
                                    className="text-[10px] bg-green-600 text-white px-1.5 py-0.5 rounded hover:bg-green-700 disabled:opacity-50 shrink-0"
                                    title="Continue this session with --resume"
                                  >
                                    Continue
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => handleRestart(ws.id)}
                                    disabled={actionLoading}
                                    className="text-[10px] bg-blue-600 text-white px-1.5 py-0.5 rounded hover:bg-blue-700 disabled:opacity-50 shrink-0"
                                    title="Start a new session (previous session has no resume ID)"
                                  >
                                    Restart
                                  </button>
                                )
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Output/Summary toggle — shown when there is session content */}
                    {(selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) && (
                      <div className="flex border-b border-gray-200">
                        <button
                          onClick={() => { setViewMode("output"); }}
                          className={`flex-1 text-xs py-1.5 text-center font-medium ${
                            viewMode === "output"
                              ? "text-blue-700 border-b-2 border-blue-600"
                              : "text-gray-500 hover:text-gray-700"
                          }`}
                        >
                          Output
                        </button>
                        <button
                          onClick={() => {
                            setViewMode("summary");
                            const sid = selectedHistoryId || activeSession || lastSessionPerWorkspace[ws.id];
                            if (sid) handleFetchSummary(sid, isRunning);
                          }}
                          className={`flex-1 text-xs py-1.5 text-center font-medium ${
                            viewMode === "summary"
                              ? "text-blue-700 border-b-2 border-blue-600"
                              : "text-gray-500 hover:text-gray-700"
                          }`}
                        >
                          Summary
                        </button>
                      </div>
                    )}

                    {/* Summary view */}
                    {viewMode === "summary" && (() => {
                      const sid = selectedHistoryId || activeSession || lastSessionPerWorkspace[ws.id];
                      const summary = sid === summarySessionId ? summaryData : null;
                      const sessionStats = selectedHistoryId
                        ? completedSessions.find(s => s.id === selectedHistoryId)?.stats ?? null
                        : completedSessions.find(s => s.id === lastSessionPerWorkspace[ws.id])?.stats ?? null;
                      return (
                        <div className="border border-gray-200 rounded p-3 space-y-3 text-sm max-h-96 overflow-y-auto">
                          {summaryLoading && (
                            <div className="text-gray-500 text-xs animate-pulse">Loading summary...</div>
                          )}
                          {!summaryLoading && !summary && (
                            <div className="text-gray-400 text-xs">No summary available. Click Summary again to load.</div>
                          )}
                          {summary && (
                            <>
                              {/* Agent Summary — the final result text from Claude Code */}
                              {summary.agentSummary && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Summary</h4>
                                  <div className="text-xs text-gray-700 bg-blue-50 border border-blue-100 rounded p-2.5 whitespace-pre-wrap leading-relaxed">
                                    {summary.agentSummary}
                                  </div>
                                </div>
                              )}

                              {/* Overview */}
                              <div>
                                <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Overview</h4>
                                <p className="text-gray-600 text-xs">{summary.overview}</p>
                                {summary.model && (
                                  <p className="text-gray-400 text-[10px] mt-0.5">Model: {summary.model}</p>
                                )}
                              </div>

                              {/* Stats row */}
                              {summary.stats && (() => {
                                const s = parseStats(JSON.stringify(summary.stats));
                                if (!s) return null;
                                return (
                                  <div className="flex items-center gap-3 text-[10px] text-gray-400">
                                    {s.inputTokens > 0 && <span>{formatTokenCount(s.inputTokens)} in / {formatTokenCount(s.outputTokens)} out</span>}
                                    {s.totalCostUsd > 0 && <span>${s.totalCostUsd.toFixed(2)}</span>}
                                    {s.durationMs > 0 && <span>{(s.durationMs / 1000).toFixed(0)}s</span>}
                                    {s.numTurns > 1 && <span>{s.numTurns} turns</span>}
                                    {summary.duration && <span>({summary.duration})</span>}
                                  </div>
                                );
                              })()}

                              {/* Tasks */}
                              {summary.tasks && summary.tasks.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                                    Tasks ({summary.tasks.filter(t => t.status === "completed").length}/{summary.tasks.length})
                                  </h4>
                                  <ul className="space-y-1">
                                    {summary.tasks.filter(t => t.status !== "deleted").map((task) => (
                                      <li key={task.id} className="flex items-start gap-1.5 text-xs">
                                        <span className="mt-0.5 shrink-0">
                                          {task.status === "completed" ? "✓" : task.status === "in_progress" ? "⟳" : "○"}
                                        </span>
                                        <span className={task.status === "completed" ? "text-gray-400 line-through" : "text-gray-700"}>
                                          {task.subject}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {/* Files read */}
                              {summary.filesRead.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Files Read ({summary.filesRead.length})</h4>
                                  <ul className="text-xs text-gray-500 space-y-0.5">
                                    {summary.filesRead.slice(0, 20).map((f) => (
                                      <li key={f} className="font-mono text-[11px] truncate">{f}</li>
                                    ))}
                                    {summary.filesRead.length > 20 && (
                                      <li className="text-gray-400">...and {summary.filesRead.length - 20} more</li>
                                    )}
                                  </ul>
                                </div>
                              )}

                              {/* Files edited */}
                              {summary.filesEdited.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Files Edited ({summary.filesEdited.length})</h4>
                                  <ul className="text-xs text-gray-500 space-y-0.5">
                                    {summary.filesEdited.map((f) => (
                                      <li key={f} className="font-mono text-[11px] truncate">{f}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {/* Files written */}
                              {summary.filesWritten.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Files Written ({summary.filesWritten.length})</h4>
                                  <ul className="text-xs text-gray-500 space-y-0.5">
                                    {summary.filesWritten.map((f) => (
                                      <li key={f} className="font-mono text-[11px] truncate">{f}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {/* Commands run */}
                              {summary.commandsRun.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Commands ({summary.commandsRun.length})</h4>
                                  <ul className="text-xs text-gray-500 space-y-0.5">
                                    {summary.commandsRun.slice(0, 15).map((cmd, i) => (
                                      <li key={i} className="font-mono text-[11px] truncate">{cmd}</li>
                                    ))}
                                    {summary.commandsRun.length > 15 && (
                                      <li className="text-gray-400">...and {summary.commandsRun.length - 15} more</li>
                                    )}
                                  </ul>
                                </div>
                              )}

                              {/* Key excerpts */}
                              {summary.keyExcerpts.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Agent Excerpts</h4>
                                  <div className="space-y-1.5">
                                    {summary.keyExcerpts.slice(0, 5).map((excerpt, i) => (
                                      <div key={i} className="text-xs text-gray-600 bg-gray-50 rounded p-2 whitespace-pre-wrap">
                                        {excerpt}
                                      </div>
                                    ))}
                                    {summary.keyExcerpts.length > 5 && (
                                      <p className="text-gray-400 text-[10px]">...and {summary.keyExcerpts.length - 5} more excerpts</p>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Errors */}
                              {summary.errors.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Errors ({summary.errors.length})</h4>
                                  <ul className="text-xs text-red-600 space-y-0.5">
                                    {summary.errors.slice(0, 5).map((err, i) => (
                                      <li key={i} className="font-mono text-[11px] break-all">{err}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })()}

                    {/* TerminalView — show history output or live/completed output (only when viewMode is "output" or agent is running) */}
                    {(viewMode === "output" || isRunning) && (selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) ? (
                      <TerminalView
                        messages={selectedHistoryId ? historyMessages : (activeSession ? messages : completedMessages)}
                        connectionState={selectedHistoryId ? "closed" : (activeSession ? wsState : "closed")}
                        parseOutput={prefs.output_parser === "false" ? "false" : (prefs.output_parser === "minimal" ? "minimal" : "true")}
                        outputFormat={getOutputFormatForAgent(ws.agentCommand ?? prefs.agent_command)}
                        prompt={selectedHistoryId ? undefined : lastPrompt}
                        title={issue.title}
                        multiTurn={isSessionAlive}
                        footer={isRunning && ws.status !== "closed" ? (
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
                    ) : null}

                    {/* Session stats summary — shown below terminal for completed sessions */}
                    {!isRunning && viewMode === "output" && (
                      <SessionStatsSummary
                        stats={selectedHistoryId
                          ? completedSessions.find(s => s.id === selectedHistoryId)?.stats ?? null
                          : completedSessions.find(s => s.id === lastSessionPerWorkspace[ws.id])?.stats ?? null
                        }
                      />
                    )}

                    {/* Chat input — only when TerminalView is not shown (no sessions yet) */}
                    {!selectedHistoryId && !activeSession && ws.workingDir && ws.status !== "closed" && (
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
                    {ws.status !== "closed" && (
                      <>
                      {!ws.workingDir && (
                        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                          Worktree directory unavailable — some actions are disabled.
                        </p>
                      )}
                      <div className="flex gap-2 flex-wrap">
                        {/* Resume/Restart button — shown when workspace idle/active but no session running */}
                        {ws.workingDir && canResume(ws, sessions) && (
                          <button
                            onClick={() => handleResume(ws.id)}
                            disabled={actionLoading}
                            className="text-sm bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 disabled:opacity-50"
                          >
                            Resume
                          </button>
                        )}
                        {ws.workingDir && canRestart(ws, sessions) && (
                          <button
                            onClick={() => handleRestart(ws.id)}
                            disabled={actionLoading}
                            className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
                            title="Start a new session (previous session has no resume ID)"
                          >
                            Restart
                          </button>
                        )}
                        {/* Update Base — rebase or merge latest base into workspace */}
                        {!ws.isDirect && ws.workingDir && ws.status !== "closed" && !isRunning && (
                          <button
                            onClick={() => handleUpdateBase(ws.id, "rebase")}
                            disabled={actionLoading}
                            className="text-sm bg-teal-600 text-white px-3 py-1.5 rounded hover:bg-teal-700 disabled:opacity-50"
                            title="Rebase onto latest base branch"
                          >
                            Update Base
                          </button>
                        )}
                        {ws.workingDir && (
                        <button
                          onClick={() => handleOpenTerminal(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-gray-700 text-white px-3 py-1.5 rounded hover:bg-gray-800 disabled:opacity-50"
                          title="Open terminal in workspace directory"
                        >
                          Terminal
                        </button>
                        )}
                        {ws.workingDir && (
                        <button
                          onClick={() => handleReview(ws.id, false)}
                          disabled={actionLoading || isRunning}
                          className="text-sm bg-violet-600 text-white px-3 py-1.5 rounded hover:bg-violet-700 disabled:opacity-50"
                          title="Trigger AI code review"
                        >
                          Review
                        </button>
                        )}
                        {ws.workingDir && (
                        <button
                          onClick={() => handleReview(ws.id, true)}
                          disabled={actionLoading || isRunning}
                          className="text-sm bg-violet-800 text-white px-3 py-1.5 rounded hover:bg-violet-900 disabled:opacity-50"
                          title="Trigger thorough AI code review using a more capable model"
                        >
                          Thorough Review
                        </button>
                        )}
                        {ws.workingDir && (
                        <button
                          onClick={() => handleViewDiff(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-purple-600 text-white px-3 py-1.5 rounded hover:bg-purple-700 disabled:opacity-50 flex-1"
                        >
                          {ws.isDirect ? "View Changes" : "View Diff"}
                        </button>
                        )}
                        {ws.workingDir && (
                        <button
                          onClick={() => handleMerge(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-orange-600 text-white px-3 py-1.5 rounded hover:bg-orange-700 disabled:opacity-50 flex-1"
                        >
                          {ws.isDirect ? "Close" : "Merge"}
                        </button>
                        )}
                        <button
                          onClick={() => handleDeleteWorkspace(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                      {/* Fix & merge with AI after merge error */}
                      {mergeError && mergeError.wsId === ws.id && (
                        <div className="mt-2 p-2 bg-orange-50 border border-orange-200 rounded">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-orange-700">Merge failed — AI can fix and retry</span>
                            <button
                              onClick={() => handleFixAndMerge(ws.id, mergeError.message)}
                              disabled={actionLoading}
                              className="text-xs bg-orange-600 text-white px-2 py-1 rounded hover:bg-orange-700 disabled:opacity-50"
                            >
                              Fix &amp; Merge with AI
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-orange-600 font-mono break-all">{mergeError.message}</p>
                        </div>
                      )}
                      {/* Conflict display */}
                      {conflictState && conflictState.hasConflicts && (
                        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-red-700">
                              {conflictState.conflictingFiles.length} conflicting file{conflictState.conflictingFiles.length !== 1 ? "s" : ""}
                            </span>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleResolveConflicts(ws.id)}
                                disabled={actionLoading}
                                className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 disabled:opacity-50"
                              >
                                Resolve with AI
                              </button>
                              <button
                                onClick={() => handleAbortRebase(ws.id)}
                                disabled={actionLoading}
                                className="text-xs bg-gray-500 text-white px-2 py-1 rounded hover:bg-gray-600 disabled:opacity-50"
                              >
                                Abort
                              </button>
                            </div>
                          </div>
                          <ul className="mt-1 text-xs text-red-600 space-y-0.5">
                            {conflictState.conflictingFiles.map(f => (
                              <li key={f} className="font-mono">{f}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      </>
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
            <div className="inline-flex relative">
              <button
                onClick={() => handleQuickLaunch(false)}
                disabled={actionLoading}
                className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
              >
                + New Workspace
              </button>
              <button
                onClick={() => setQuickDropdownOpen((o) => !o)}
                disabled={actionLoading}
                className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50 px-1"
                title="More options"
              >
                ▾
              </button>
              {quickDropdownOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-52 bg-white border border-gray-200 rounded shadow-lg z-10">
                  <button
                    onClick={() => handleQuickLaunch(false)}
                    className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50"
                  >
                    New Workspace
                  </button>
                  <button
                    onClick={() => handleQuickLaunch(true)}
                    className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50"
                  >
                    New Workspace with Plan Mode
                  </button>
                  <div className="border-t border-gray-100" />
                  <button
                    onClick={() => { setQuickDropdownOpen(false); setShowCreate(true); }}
                    className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 text-gray-500"
                  >
                    Custom options...
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
