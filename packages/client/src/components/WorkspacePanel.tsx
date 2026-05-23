import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { getOutputFormatForAgent } from "../lib/agent-output-parser.js";
import { useWebSocket } from "../lib/useWebSocket.js";
import { TerminalView } from "./TerminalView.js";
import { CreateWorkspaceForm } from "./CreateWorkspaceForm.js";
import { WorkspaceDiffPanel } from "./WorkspaceDiffPanel.js";
import { useWorkspaceSession } from "../hooks/useWorkspaceSession.js";
import type {
  AgentOutputMessage,
  IssueWithStatus,
  WorkspaceResponse,
  DiffResponse,
  DiffComment,
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
  resumeFromId: string | null;
  triggerType: string | null;
  skillName: string | null;
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
  onWorkspaceCreating?: (issueId: string) => void;
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

const TRIGGER_TYPE_LABELS: Record<string, { label: string; className: string }> = {
  agent: { label: "Agent", className: "bg-blue-50 text-blue-600" },
  chat: { label: "Chat", className: "bg-indigo-50 text-indigo-600" },
  review: { label: "AI Review", className: "bg-violet-100 text-violet-700" },
  merge: { label: "AI Merge", className: "bg-emerald-100 text-emerald-700" },
  "fix-conflicts": { label: "Fix Conflicts", className: "bg-orange-100 text-orange-700" },
  learning: { label: "Learning", className: "bg-teal-100 text-teal-700" },
  "auto-start": { label: "Auto-start", className: "bg-gray-100 text-gray-600" },
};

const SKILL_NAME_ACRONYMS = new Set(["ui", "ai", "api", "llm", "url", "http", "id"]);
function humanizeSkillName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\b\w+/g, w =>
    SKILL_NAME_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
  );
}

function getTriggerTypeLabel(triggerType: string | null, skillName?: string | null): { label: string; className: string } | null {
  if (!triggerType) {
    if (skillName) return { label: `✨ ${humanizeSkillName(skillName)}`, className: "bg-purple-100 text-purple-700" };
    return null;
  }
  if (TRIGGER_TYPE_LABELS[triggerType]) return TRIGGER_TYPE_LABELS[triggerType];
  if (triggerType.startsWith("skill:")) {
    const name = triggerType.slice(6);
    return { label: `✨ ${humanizeSkillName(name)}`, className: "bg-purple-100 text-purple-700" };
  }
  return null;
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

import { suggestBranchName } from "../lib/branch.js";

export function WorkspacePanel({ issue, project, onClose, onWorkspaceChange, onWorkspaceCreating, initialWorkspaceId, initialSessionId, autoSelectId, initialShowCreate }: WorkspacePanelProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(initialShowCreate ?? false);
  const [quickDropdownOpen, setQuickDropdownOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(initialWorkspaceId ?? null);
  const [activeSession, setActiveSession] = useState<string | null>(initialSessionId || null);
  const [panelMode, setPanelMode] = useState<"sidebar" | "modal">("sidebar");
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("right");
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [snapZone, setSnapZone] = useState<"left" | "right" | null>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; panelX: number; panelY: number } | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [diffComments, setDiffComments] = useState<DiffComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [conflictState, setConflictState] = useState<{ hasConflicts: boolean; conflictingFiles: string[] } | null>(null);
  const [mergeError, setMergeError] = useState<{ wsId: string; message: string } | null>(null);

  const [latestCommits, setLatestCommits] = useState<Record<string, { sha: string; message: string } | null>>({});

  const [monitorRunning, setMonitorRunning] = useState(false);
  const [requiresReview, setRequiresReview] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [availableSkills, setAvailableSkills] = useState<{ id: string; name: string; description: string }[]>([]);
  const [lastPrompt, setLastPrompt] = useState<string>(
    initialSessionId ? `${issue.title}${issue.description ? `\n\n${issue.description}` : ""}` : ""
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestion = suggestBranchName(issue);

  const {
    workspaceSessions,
    setWorkspaceSessions,
    selectedHistoryId,
    setSelectedHistoryId,
    historyMessages,
    setHistoryMessages,
    viewMode,
    setViewMode,
    summaryData,
    summaryLoading,
    summarySessionId,
    lastSessionPerWorkspace,
    setLastSessionPerWorkspace,
    completedMessages,
    setCompletedMessages,
    handleViewHistory,
    handleFetchSummary,
  } = useWorkspaceSession({
    selectedWorkspace,
    activeSession,
    issue,
    setActiveSession,
    setLastPrompt,
    setError,
  });

  const { state: wsState, messages, disconnect, isWaitingForInput } = useWebSocket(activeSession);

  const isRunning = activeSession !== null && !messages.some(m => m.type === "exit");
  const isSessionAlive = activeSession !== null && isRunning;
  const canResume = (ws: WorkspaceResponse, sessions: SessionInfo[]) =>
    (ws.status === "active" || ws.status === "idle") && !isRunning && !activeSession &&
    !!lastSessionPerWorkspace[ws.id] &&
    sessions.some(s => s.id === lastSessionPerWorkspace[ws.id] && s.providerSessionId);
  const canRestart = (ws: WorkspaceResponse, sessions: SessionInfo[]) =>
    (ws.status === "active" || ws.status === "idle") && !isRunning && !activeSession &&
    !!lastSessionPerWorkspace[ws.id] &&
    sessions.some(s => s.id === lastSessionPerWorkspace[ws.id] && !s.providerSessionId);

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

    const exitMsg = messages.find(m => m.type === "exit");
    if (exitMsg) {
      apiFetch<AgentOutputMessage[]>(`/api/sessions/${sid}/output`)
        .then((data) => completeSession(data))
        .catch(() => completeSession([...messages]));
      return;
    }

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
      if (data.length > 0 && !selectedWorkspace) {
        const targetId = autoSelectId ?? (data.length === 1 ? data[0].id : undefined);
        if (targetId) {
          setSelectedWorkspace(targetId);
        }
      }
      const commits: Record<string, { sha: string; message: string } | null> = {};
      await Promise.all(
        data.filter(ws => ws.workingDir).map(async (ws) => {
          try {
            const result = await apiFetch<{ sha: string | null; message: string | null }>(
              `/api/workspaces/${ws.id}/latest-commit`,
            );
            commits[ws.id] = result.sha && result.message ? { sha: result.sha, message: result.message } : null;
          } catch {
            commits[ws.id] = null;
          }
        }),
      );
      setLatestCommits(commits);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchWorkspaces();
    apiFetch<Record<string, string>>("/api/preferences/settings")
      .then((s) => {
        setPrefs(s);
        setRequiresReview(s.auto_review !== "false");
        setSelectedProfile(s.claude_profile || "");
      })
      .catch(() => {});
    apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles")
      .then((data) => setAvailableProfiles(data.profiles))
      .catch(() => {});
    const skillsUrl = project ? `/api/agent-skills?projectId=${project.id}` : "/api/agent-skills";
    apiFetch<{ id: string; name: string; description: string }[]>(skillsUrl)
      .then(setAvailableSkills)
      .catch(() => {});
  }, [issue.id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, selectedHistoryId]);

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
      if (selectedProfile) body.claudeProfile = selectedProfile;
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

  async function handleSkillQuickLaunch(skillId: string) {
    setActionLoading(true);
    setError(null);
    setCompletedMessages([]);
    setQuickDropdownOpen(false);
    try {
      const body: Record<string, unknown> = {
        issueId: issue.id,
        isDirect: false,
        requiresReview,
        planMode: false,
        branch: suggestion,
        skillId,
      };
      if (selectedProfile) body.claudeProfile = selectedProfile;
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
      setSelectedHistoryId(null);
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
      if (result.resumed && result.sessionId) {
        setCompletedMessages([]);
        setSelectedHistoryId(null);
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
      if (activeSession) {
        setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: activeSession }));
        setCompletedMessages(messages);
      }
      setActiveSession(null);
      await fetchWorkspaces();
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

  async function handleOpenEditor(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${wsId}/open-editor`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "VS Code launch failed");
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

  async function handleMonitorRunNow() {
    setMonitorRunning(true);
    try {
      await apiFetch("/api/internal/monitor-run", { method: "POST" });
    } finally {
      setMonitorRunning(false);
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
          // Summary fetch failed -- proceed without context
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

  async function handleReview(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiFetch<{ sessionId: string }>(`/api/workspaces/${wsId}/review`, { method: "POST" });
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

  function handleHeaderMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    const panel = (e.currentTarget as HTMLElement).closest("[data-panel]") as HTMLElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panelX: rect.left, panelY: rect.top };

    const EDGE_SNAP_THRESHOLD = 80;
    let currentDragMode: "sidebar" | "modal" = panelMode;
    let cleanup: (() => void) | null = null;

    if (currentDragMode === "sidebar") {
      const isLeftSidebar = sidebarSide === "left";
      const modalX = isLeftSidebar
        ? Math.min(window.innerWidth - 580, 200)
        : Math.max(0, dragStartRef.current.panelX - 10);
      const modalY = Math.max(0, dragStartRef.current.panelY + 40);
      currentDragMode = "modal";
      setPanelMode("modal");
      setDragPos({ x: modalX, y: modalY });
      dragStartRef.current = { ...dragStartRef.current, panelX: modalX, panelY: modalY };
    }

    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = ev.clientX - dragStartRef.current.mouseX;
      const dy = ev.clientY - dragStartRef.current.mouseY;
      const newX = dragStartRef.current.panelX + dx;
      const newY = dragStartRef.current.panelY + dy;
      if (currentDragMode === "modal") {
        const panelRect = panel.getBoundingClientRect();
        const nearRightEdge = newX + panelRect.width >= window.innerWidth - EDGE_SNAP_THRESHOLD;
        const nearLeftEdge = newX <= EDGE_SNAP_THRESHOLD;
        if (nearRightEdge) {
          currentDragMode = "sidebar";
          setPanelMode("sidebar");
          setSidebarSide("right");
          setSnapZone(null);
          setDragPos(null);
          dragStartRef.current = null;
          cleanup?.();
          return;
        }
        if (nearLeftEdge) {
          currentDragMode = "sidebar";
          setPanelMode("sidebar");
          setSidebarSide("left");
          setSnapZone(null);
          setDragPos(null);
          dragStartRef.current = null;
          cleanup?.();
          return;
        }
        const SNAP_PREVIEW_THRESHOLD = EDGE_SNAP_THRESHOLD + 60;
        const approachingRight = newX + panelRect.width >= window.innerWidth - SNAP_PREVIEW_THRESHOLD;
        const approachingLeft = newX <= SNAP_PREVIEW_THRESHOLD;
        setSnapZone(approachingRight ? "right" : approachingLeft ? "left" : null);
        setDragPos({ x: newX, y: newY });
      }
    };
    const onUp = () => {
      dragStartRef.current = null;
      setSnapZone(null);
      cleanup?.();
    };
    cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <>
      {snapZone === "left" && (
        <div className="fixed left-0 top-0 h-full w-[min(560px,100vw)] z-40 bg-blue-500/20 border-r-2 border-blue-400 pointer-events-none" />
      )}
      {snapZone === "right" && (
        <div className="fixed right-0 top-0 h-full w-[min(560px,100vw)] z-40 bg-blue-500/20 border-l-2 border-blue-400 pointer-events-none" />
      )}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div
        data-panel
        className={`fixed bg-white shadow-xl z-50 flex flex-col animate-slide-in-right ${
          panelMode === "modal"
            ? "top-[5vh] left-1/2 -translate-x-1/2 w-[min(560px,96vw)] h-[90vh] rounded-lg border border-gray-200"
            : sidebarSide === "left"
            ? "left-0 top-0 h-full border-r border-gray-200 w-[min(560px,100vw)]"
            : "right-0 top-0 h-full border-l border-gray-200 w-[min(560px,100vw)]"
        }`}
        style={
          dragPos && panelMode === "modal"
            ? { position: "fixed", left: dragPos.x, top: dragPos.y, transform: "none" }
            : undefined
        }
      >
        <div
          className={`flex items-center gap-2 px-4 py-3 border-b border-gray-200 min-w-0 cursor-grab active:cursor-grabbing ${panelMode === "modal" ? "rounded-t-lg" : ""}`}
          onMouseDown={handleHeaderMouseDown}
        >
          <h2 className="flex-1 min-w-0 text-sm font-semibold text-gray-900 truncate" title={issue.title}>
            {issue.title}
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { setPanelMode(m => m === "sidebar" ? "modal" : "sidebar"); setDragPos(null); }}
              title={panelMode === "sidebar" ? "Detach to floating panel" : "Snap back to sidebar"}
              className="text-gray-400 hover:text-gray-600 p-0.5 rounded"
            >
              {panelMode === "modal" ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9L4 4m0 0h5m-5 0v5M15 9l5-5m0 0h-5m5 0v5M9 15l-5 5m0 0h5m-5 0v-5M15 15l5 5m0 0h-5m5 0v-5" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5M20 8V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5M20 16v4m0 0h-4m4 0l-5-5" />
                </svg>
              )}
            </button>
            <button
              onClick={handleMonitorRunNow}
              disabled={monitorRunning}
              className="flex items-center justify-center w-6 h-6 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Run monitor now and reset timer"
            >
              {monitorRunning
                ? <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                : <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
              }
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {error}
              <button onClick={() => { setError(null); setMergeError(null); }} className="ml-2 text-red-400 hover:text-red-600">
                Dismiss
              </button>
            </div>
          )}

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
                  &#9662;
                </button>
                {quickDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-gray-200 rounded shadow-lg z-10">
                    {availableProfiles.length > 0 && (
                      <>
                        <div className="px-3 py-1.5">
                          <label className="block text-xs text-gray-500 mb-1">Profile</label>
                          <select
                            value={selectedProfile}
                            onChange={(e) => setSelectedProfile(e.target.value)}
                            className="w-full text-sm border border-gray-200 rounded px-2 py-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="">Default</option>
                            {availableProfiles.map((p) => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                          </select>
                        </div>
                        <div className="border-t border-gray-100" />
                      </>
                    )}
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
                    {availableSkills.length > 0 && (
                      <>
                        <div className="border-t border-gray-100" />
                        <div className="px-3 py-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide">Skills</div>
                        {availableSkills.map((skill) => (
                          <button
                            key={skill.id}
                            onClick={() => handleSkillQuickLaunch(skill.id)}
                            className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
                            title={skill.description}
                          >
                            <span className="text-purple-500">✨</span>
                            {humanizeSkillName(skill.name)}
                          </button>
                        ))}
                      </>
                    )}
                    <div className="border-t border-gray-100" />
                    <button
                      onClick={() => {
                        setQuickDropdownOpen(false);
                        setShowCreate(true);
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
            <CreateWorkspaceForm
              issue={issue}
              project={project}
              prefs={prefs}
              actionLoading={actionLoading}
              onCreated={(result) => {
                onWorkspaceCreating?.(issue.id);
                setShowCreate(false);
                setCompletedMessages([]);
                setSelectedHistoryId(null);
                if (result.sessionId) {
                  setSelectedWorkspace(result.id);
                  setActiveSession(result.sessionId);
                  setLastPrompt(`${issue.title}${issue.description ? `\n\n${issue.description}` : ""}`);
                }
                fetchWorkspaces();
                onWorkspaceChange?.();
              }}
              onCancel={() => setShowCreate(false)}
            />
          )}

          {workspaces.map((ws) => {
            const isSelected = selectedWorkspace === ws.id;
            const isThisRunning = isSelected && isRunning;
            const isLaunching = isSelected && ws.status === "active" && activeSession && messages.length === 0;
            const badgeColor = STATUS_COLORS[ws.status] ?? "bg-gray-100 text-gray-500";
            const sessions = workspaceSessions[ws.id] ?? [];
            const completedSessions = sessions.filter((s) => s.status !== "running");
            const runningSession = sessions.find((s) => s.status === "running");
            const runningTriggerLabel = runningSession
              ? (getTriggerTypeLabel(runningSession.triggerType, runningSession.skillName) ?? { label: "Agent", className: "bg-blue-50 text-blue-600" })
              : null;

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
                  <div className="flex items-center gap-1.5">
                    {isThisRunning && runningTriggerLabel && (
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded animate-pulse ${runningTriggerLabel.className}`}>
                        {runningTriggerLabel.label}
                      </span>
                    )}
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                      isThisRunning ? "bg-green-100 text-green-700 animate-pulse" :
                      isLaunching ? "bg-blue-100 text-blue-700 animate-pulse" :
                      badgeColor
                    }`}>
                      {isThisRunning ? "running" : isLaunching ? "launching..." : ws.status}
                    </span>
                  </div>
                </div>

                {ws.workingDir && (
                  <p className="text-xs text-gray-500 truncate">{ws.workingDir}</p>
                )}

                <div className="flex gap-3 text-xs text-gray-400">
                  <span>Created {formatRelativeTime(ws.createdAt)}</span>
                  {ws.closedAt && <span>Closed {formatRelativeTime(ws.closedAt)}</span>}
                </div>

                {ws.workingDir && (
                  <div className="text-xs text-gray-500 font-mono truncate">
                    {latestCommits[ws.id] === undefined
                      ? null
                      : latestCommits[ws.id] === null
                      ? <span className="text-gray-400 font-sans">No commits</span>
                      : <span title={latestCommits[ws.id]!.message}>
                          <span className="text-gray-400">{latestCommits[ws.id]!.sha}</span>
                          {" "}
                          <span className="text-gray-600">{latestCommits[ws.id]!.message}</span>
                        </span>
                    }
                  </div>
                )}

                {isThisRunning && (ws.contextTokens || ws.lastTool) && (
                  <div className="flex items-center gap-2 text-[10px] text-gray-400">
                    {ws.contextTokens ? (
                      <span>
                        {ws.contextTokens >= 1000
                          ? `${Math.round(ws.contextTokens / 1000)}k ctx`
                          : `${ws.contextTokens} ctx`}
                      </span>
                    ) : null}
                    {ws.lastTool ? (
                      <span className="truncate" title={ws.lastTool}>{ws.lastTool}</span>
                    ) : null}
                  </div>
                )}

                {isSelected && (
                  <div className="space-y-2 pt-2 border-t border-gray-200" onClick={(e) => e.stopPropagation()}>
                    {completedSessions.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Sessions</div>
                        {(() => {
                          const specialSessions = completedSessions.filter(s =>
                            s.triggerType && s.triggerType !== "agent" && s.triggerType !== "chat"
                            || (!s.triggerType && s.skillName)
                          );
                          if (specialSessions.length === 0) return null;
                          const counts = new Map<string, { label: string; className: string; count: number; lastStatus: string }>();
                          for (const s of specialSessions) {
                            const tl = getTriggerTypeLabel(s.triggerType, s.skillName) ?? { label: s.triggerType ?? "Skill", className: "bg-purple-100 text-purple-700" };
                            const key = s.triggerType ?? `skill:${s.skillName}`;
                            const existing = counts.get(key);
                            if (existing) { existing.count++; existing.lastStatus = s.status; }
                            else counts.set(key, { ...tl, count: 1, lastStatus: s.status });
                          }
                          return (
                            <div className="flex flex-wrap gap-1 pb-0.5">
                              {[...counts.entries()].map(([key, { label, className, count, lastStatus }]) => (
                                <span key={key} className={`text-[10px] font-medium px-1.5 py-0.5 rounded flex items-center gap-1 ${className}`}>
                                  {label}
                                  <span className="opacity-60">×{count}</span>
                                  {lastStatus === "completed" ? <span className="text-green-600">✓</span> : lastStatus === "stopped" ? <span className="text-yellow-500">⏹</span> : null}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                        <div className="space-y-0.5 max-h-48 overflow-y-auto">
                        {completedSessions.map((session) => {
                          const sessionBadge = SESSION_STATUS_COLORS[session.status] ?? "bg-gray-100 text-gray-500";
                          const isActive = selectedHistoryId === session.id;
                          const isContinuation = !!session.resumeFromId && completedSessions.some(s => s.id === session.resumeFromId);
                          return (
                            <div key={session.id} className={`flex items-center gap-1 ${isContinuation ? "ml-3" : ""}`}>
                              {isContinuation && (
                                <span className="text-gray-300 shrink-0 select-none">↳</span>
                              )}
                              <button
                                data-session-id={session.id}
                                onClick={() => handleViewHistory(session.id)}
                                className={`flex-1 flex items-center gap-2 py-1 px-2 rounded text-left text-xs ${
                                  isActive
                                    ? "bg-blue-50 text-blue-700 font-medium"
                                    : "hover:bg-gray-50 text-gray-600"
                                }`}
                              >
                                {(() => {
                                  const tl = getTriggerTypeLabel(session.triggerType, session.skillName);
                                  const parsedStats = parseStats(session.stats);
                                  const isAgentOrChat = (session.triggerType === "agent" || session.triggerType === "chat" || !session.triggerType) && !session.skillName;
                                  const statusDot = <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.status === "completed" ? "bg-green-500" : session.status === "stopped" ? "bg-yellow-500" : "bg-blue-400"}`} />;
                                  const fallbackLabel = { label: "Agent", className: "bg-blue-50 text-blue-600" };
                                  if (isAgentOrChat) {
                                    return (
                                      <>
                                        {statusDot}
                                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${(tl ?? fallbackLabel).className}`}>{(tl ?? fallbackLabel).label}</span>
                                      </>
                                    );
                                  }
                                  const succeeded = parsedStats?.success;
                                  const outcomeIcon = session.status === "completed"
                                    ? (succeeded === false ? <span className="text-red-500 font-bold text-[10px]">✗</span> : <span className="text-green-500 font-bold text-[10px]">✓</span>)
                                    : session.status === "stopped" ? <span className="text-yellow-500 font-bold text-[10px]">⏹</span>
                                    : statusDot;
                                  return (
                                    <>
                                      {outcomeIcon}
                                      {tl && <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${tl.className}`}>{tl.label}</span>}
                                    </>
                                  );
                                })()}
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
                      </div>
                    )}

                    {ws.status !== "closed" && !isRunning && ws.workingDir && (() => {
                      const lastReview = completedSessions.filter(s => s.triggerType === "review").at(-1);
                      const lastMerge = completedSessions.filter(s => s.triggerType === "merge").at(-1);
                      return (
                      <div className="space-y-1 pt-1">
                        <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Quick Actions</div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                          <div className="flex flex-col gap-0.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleReview(ws.id); }}
                              disabled={actionLoading}
                              className="text-[10px] font-medium px-2 py-0.5 rounded bg-violet-100 text-violet-700 hover:bg-violet-200 disabled:opacity-50"
                              title="Trigger AI code review"
                            >
                              AI Review
                            </button>
                            {lastReview && (
                              <span className={`text-[9px] px-1 ${lastReview.status === "completed" ? "text-green-600" : "text-yellow-600"}`}>
                                {lastReview.status === "completed" ? "✓" : "✗"} {formatRelativeTime(lastReview.endedAt ?? lastReview.startedAt)}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleMerge(ws.id); }}
                              disabled={actionLoading}
                              className="text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50"
                              title="Merge this workspace"
                            >
                              {ws.isDirect ? "Close" : "AI Merge"}
                            </button>
                            {lastMerge && (
                              <span className={`text-[9px] px-1 ${lastMerge.status === "completed" ? "text-green-600" : "text-yellow-600"}`}>
                                {lastMerge.status === "completed" ? "✓" : "✗"} {formatRelativeTime(lastMerge.endedAt ?? lastMerge.startedAt)}
                              </span>
                            )}
                          </div>
                          {availableSkills.map((skill) => {
                            const lastSkill = completedSessions.filter(s => s.triggerType === `skill:${skill.name}`).at(-1);
                            return (
                              <div key={skill.id} className="flex flex-col gap-0.5">
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleSkillQuickLaunch(skill.id); }}
                                  disabled={actionLoading}
                                  className="text-[10px] font-medium px-2 py-0.5 rounded bg-purple-100 text-purple-700 hover:bg-purple-200 disabled:opacity-50"
                                  title={skill.description}
                                >
                                  ✨ {humanizeSkillName(skill.name)}
                                </button>
                                {lastSkill && (
                                  <span className={`text-[9px] px-1 ${lastSkill.status === "completed" ? "text-green-600" : "text-yellow-600"}`}>
                                    {lastSkill.status === "completed" ? "✓" : "✗"} {formatRelativeTime(lastSkill.endedAt ?? lastSkill.startedAt)}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      );
                    })()}

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

                    {viewMode === "summary" && (() => {
                      const sid = selectedHistoryId || activeSession || lastSessionPerWorkspace[ws.id];
                      const summary = sid === summarySessionId ? summaryData : null;
                      const sessionStats = selectedHistoryId
                        ? completedSessions.find(s => s.id === selectedHistoryId)?.stats ?? null
                        : completedSessions.find(s => s.id === lastSessionPerWorkspace[ws.id])?.stats ?? null;
                      return (
                        <div className="border border-gray-200 rounded p-3 space-y-3 text-sm max-h-80 overflow-y-auto">
                          {summaryLoading && (
                            <div className="text-gray-500 text-xs animate-pulse">Loading summary...</div>
                          )}
                          {!summaryLoading && !summary && (
                            <div className="text-gray-400 text-xs">No summary available. Click Summary again to load.</div>
                          )}
                          {summary && (
                            <>
                              {summary.agentSummary && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Summary</h4>
                                  <div className="text-xs text-gray-700 bg-blue-50 border border-blue-100 rounded p-2.5 whitespace-pre-wrap leading-relaxed">
                                    {summary.agentSummary}
                                  </div>
                                </div>
                              )}

                              <div>
                                <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Overview</h4>
                                <p className="text-gray-600 text-xs">{summary.overview}</p>
                                {summary.model && (
                                  <p className="text-gray-400 text-[10px] mt-0.5">Model: {summary.model}</p>
                                )}
                              </div>

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

                              {summary.tasks && summary.tasks.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                                    Tasks ({summary.tasks.filter(t => t.status === "completed").length}/{summary.tasks.length})
                                  </h4>
                                  <ul className="space-y-1">
                                    {summary.tasks.filter(t => t.status !== "deleted").map((task) => (
                                      <li key={task.id} className="flex items-start gap-1.5 text-xs">
                                        <span className="mt-0.5 shrink-0">
                                          {task.status === "completed" ? "Ô£ô" : task.status === "in_progress" ? "Ôƒ│" : "Ôùï"}
                                        </span>
                                        <span className={task.status === "completed" ? "text-gray-400 line-through" : "text-gray-700"}>
                                          {task.subject}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

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

                    {!isRunning && viewMode === "output" && (
                      <SessionStatsSummary
                        stats={selectedHistoryId
                          ? completedSessions.find(s => s.id === selectedHistoryId)?.stats ?? null
                          : completedSessions.find(s => s.id === lastSessionPerWorkspace[ws.id])?.stats ?? null
                        }
                      />
                    )}

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

                    {ws.status !== "closed" && (
                      <>
                      {!ws.workingDir && (
                        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                          Worktree directory unavailable -- some actions are disabled.
                        </p>
                      )}
                      <div className="flex gap-2 flex-wrap">
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
                          onClick={() => handleOpenEditor(ws.id)}
                          disabled={actionLoading}
                          className="text-sm bg-gray-700 text-white px-3 py-1.5 rounded hover:bg-gray-800 disabled:opacity-50"
                          title="Open workspace directory in VS Code"
                        >
                          VS Code
                        </button>
                        )}
                        {ws.workingDir && (
                        <button
                          onClick={() => handleReview(ws.id)}
                          disabled={actionLoading || isRunning}
                          className="text-sm bg-violet-600 text-white px-3 py-1.5 rounded hover:bg-violet-700 disabled:opacity-50"
                          title="Trigger AI code review"
                        >
                          Review
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
                        <span className="w-px bg-gray-300 self-stretch mx-2" aria-hidden="true" />
                        <button
                          onClick={() => handleDeleteWorkspace(ws.id)}
                          disabled={actionLoading}
                          className="text-sm text-red-600 px-3 py-1.5 rounded hover:bg-red-50 disabled:opacity-50 border border-red-300 font-medium"
                          title="Delete this workspace permanently"
                        >
                          Delete
                        </button>
                      </div>
                      {mergeError && mergeError.wsId === ws.id && (
                        <div className="mt-2 p-2 bg-orange-50 border border-orange-200 rounded">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-orange-700">Merge failed -- AI can fix and retry</span>
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
            <WorkspaceDiffPanel
              diff={diff}
              diffComments={diffComments}
              workspaceId={selectedWorkspace!}
              onClose={() => setDiff(null)}
              onCommentsChange={setDiffComments}
              onError={(msg) => setError(msg)}
            />
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
                &#9662;
              </button>
              {quickDropdownOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-52 bg-white border border-gray-200 rounded shadow-lg z-10">
                  {availableProfiles.length > 0 && (
                    <>
                      <div className="px-3 py-1.5">
                        <label className="block text-xs text-gray-500 mb-1">Profile</label>
                        <select
                          value={selectedProfile}
                          onChange={(e) => setSelectedProfile(e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded px-2 py-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="">Default</option>
                          {availableProfiles.map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </div>
                      <div className="border-t border-gray-100" />
                    </>
                  )}
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
                  {availableSkills.length > 0 && (
                    <>
                      <div className="border-t border-gray-100" />
                      <div className="px-3 py-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide">Skills</div>
                      {availableSkills.map((skill) => (
                        <button
                          key={skill.id}
                          onClick={() => handleSkillQuickLaunch(skill.id)}
                          className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
                          title={skill.description}
                        >
                          <span className="text-purple-500">✨</span>
                          {humanizeSkillName(skill.name)}
                        </button>
                      ))}
                    </>
                  )}
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
