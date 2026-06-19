import React, { useEffect, useRef, useState } from "react";
import { apiFetch, apiPost, apiPatch, apiDelete } from "../lib/api.js";
import { type AgentOutputFormat } from "../lib/agent-output-parser.js";
import { useWebSocket } from "../lib/useWebSocket.js";
import { CreateWorkspaceForm } from "./CreateWorkspaceForm.js";
import { WorkspaceDiffPanel } from "./WorkspaceDiffPanel.js";
import {
  WorkspaceCard,
  type Project,
  type SessionInfo,
  type ScorecardResult,
  type AvailableSkill,
} from "./WorkspaceCard.js";
import { useWorkspaceSession } from "../hooks/useWorkspaceSession.js";
import { usePanelLayout } from "../hooks/usePanelLayout.js";
import { useProfileSelection } from "../hooks/useProfileSelection.js";
import { SessionReplay } from "./SessionReplay.js";
import { showToast } from "./Toast.js";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import {
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  humanizeSkillName,
  profileOptionValue,
  providerLabel,
} from "../lib/workspace-helpers.js";
import { buildQuickLaunchBody } from "../lib/workspace-launch.js";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import type {
  AgentOutputMessage,
  IssueArtifact,
  IssueWithStatus,
  WorkspaceResponse,
  DiffResponse,
  DiffComment,
  SessionSummaryResponse,
} from "@agentic-kanban/shared";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@agentic-kanban/shared";

interface WorkspacePanelProps {
  issue: IssueWithStatus;
  project: Project | null;
  onClose: () => void;
  onWorkspaceChange?: () => void;
  onWorkspaceCreating?: (issueId: string) => void;
  onWorkspaceCreateSettled?: (issueId: string) => void;
  initialWorkspaceId?: string;
  initialSessionId?: string;
  autoSelectId?: string;
  initialShowCreate?: boolean;
  initialShowDiff?: boolean;
  /** Live token/context stats for this issue's active session, if any. */
  liveStats?: LiveSessionStats | null;
}

export function WorkspacePanel({ issue, project, onClose, onWorkspaceChange, onWorkspaceCreating, onWorkspaceCreateSettled, initialWorkspaceId, initialSessionId, autoSelectId, initialShowCreate, initialShowDiff, liveStats }: WorkspacePanelProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(initialShowCreate ?? false);
  const [quickDropdownOpen, setQuickDropdownOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(initialWorkspaceId ?? null);
  const [activeSession, setActiveSession] = useState<string | null>(initialSessionId || null);
  // Immediate optimistic feedback for fix-and-merge / resolve-conflicts launches.
  // The POST does a multi-second preflight (kill worktree procs + rebase onto base)
  // before the agent session even exists, so without this the button click looks dead.
  const [launchingFix, setLaunchingFix] = useState<
    { wsId: string; kind: "fix-and-merge" | "resolve" } | null
  >(null);
  const {
    mode: panelMode,
    setMode: setPanelMode,
    sidebarWidth,
    startResize,
    resizing,
  } = usePanelLayout({
    storageKey: "workspace",
    modes: ["sidebar", "modal"],
    defaultWidth: 720,
    minWidth: 460,
    maxWidth: 1200,
  });
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("right");
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [snapZone, setSnapZone] = useState<"left" | "right" | null>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; panelX: number; panelY: number } | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [diffComments, setDiffComments] = useState<DiffComment[]>([]);
  const [scorecard, setScorecard] = useState<ScorecardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [conflictState, setConflictState] = useState<{ hasConflicts: boolean; conflictingFiles: string[] } | null>(null);
  const [expandedQuickActions, setExpandedQuickActions] = useState<Record<string, boolean>>({});
  const [expandedScorecards, setExpandedScorecards] = useState<Record<string, boolean>>({});
  const [mergeError, setMergeError] = useState<{ wsId: string; message: string } | null>(null);
  const [replaySession, setReplaySession] = useState<{ id: string; label: string; outputFormat: string } | null>(null);

  const [latestCommits, setLatestCommits] = useState<Record<string, { sha: string; message: string } | null>>({});
  const [githubDrafts, setGithubDrafts] = useState<Record<string, string | null>>({});
  const [planContent, setPlanContent] = useState<Record<string, string | null>>({});
  const [planEditMode, setPlanEditMode] = useState<Record<string, boolean>>({});
  const [planEditText, setPlanEditText] = useState<Record<string, string>>({});
  const [rejectMode, setRejectMode] = useState<Record<string, boolean>>({});
  const [rejectFeedback, setRejectFeedback] = useState<Record<string, string>>({});
  const initialSessionAppliedRef = useRef(false);

  const [monitorRunning, setMonitorRunning] = useState(false);
  const [visualProofArtifacts, setVisualProofArtifacts] = useState<IssueArtifact[]>([]);
  const [visualProofLoading, setVisualProofLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [editingProfileWsId, setEditingProfileWsId] = useState<string | null>(null);
  const {
    prefs,
    requiresReview,
    selectedProfile,
    setSelectedProfile,
    selectedModel,
    setSelectedModel,
    availableProfileOptions,
  } = useProfileSelection(issue.id);
  const [availableSkills, setAvailableSkills] = useState<AvailableSkill[]>([]);
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

  // Primitive descriptors of the selected workspace. Effects that only care about
  // the selected workspace's identity/status must depend on these, NOT the whole
  // `workspaces` array — otherwise every setWorkspaces() (which produces a fresh
  // array reference) re-runs them and re-fires expensive fetches (scorecard, diff).
  const selectedWs = selectedWorkspace ? workspaces.find(w => w.id === selectedWorkspace) : undefined;
  const selectedWsStatus = selectedWs?.status;
  const selectedWsIsDirect = selectedWs?.isDirect ?? false;

  useEffect(() => {
    if (!initialSessionId || initialSessionAppliedRef.current || !selectedWorkspace) return;
    const sessions = workspaceSessions[selectedWorkspace];
    if (!sessions) return;
    const session = sessions.find((s) => s.id === initialSessionId);
    if (!session || session.status === "running") return;
    initialSessionAppliedRef.current = true;
    setActiveSession(null);
    setLastSessionPerWorkspace((prev) => ({ ...prev, [selectedWorkspace]: initialSessionId }));
    void handleViewHistory(initialSessionId);
  }, [initialSessionId, selectedWorkspace, workspaceSessions, setActiveSession, setLastSessionPerWorkspace, handleViewHistory]);

  useEffect(() => {
    if (!selectedWorkspace) { setVisualProofArtifacts([]); return; }
    let cancelled = false;
    setVisualProofLoading(true);
    apiFetch<IssueArtifact[]>(`/api/workspaces/${selectedWorkspace}/visual-proof`)
      .then((rows) => { if (!cancelled) { setVisualProofArtifacts(rows); setVisualProofLoading(false); } })
      .catch(() => { if (!cancelled) { setVisualProofArtifacts([]); setVisualProofLoading(false); } });
    return () => { cancelled = true; };
  }, [selectedWorkspace]);

  const isRunning = activeSession !== null && !messages.some(m => m.type === "exit");
  const isSessionAlive = activeSession !== null && isRunning;
  const isClaudeQuickLaunch = selectedProfile === ""
    ? (prefs.provider !== "codex" && prefs.provider !== "copilot")
    : selectedProfile.startsWith("claude:");
  const isCodexQuickLaunch = selectedProfile === ""
    ? prefs.provider === "codex"
    : selectedProfile.startsWith("codex:");
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
      // NOTE: the per-workspace `/handoff` GET endpoint does not exist on the server
      // (only `/handoff-bundle` and `/github-handoff-draft` do), so this loop always
      // 404'd and `handoffContent` was never populated. Removed to kill the redundant
      // per-workspace requests + console 404 noise on every panel open. Wiring the
      // handoff display to a real endpoint is tracked separately.
      const drafts: Record<string, string | null> = {};
      await Promise.all(
        data.filter(ws => ws.status === "closed").map(async (ws) => {
          try {
            const result = await apiFetch<{ content: string | null }>(
              `/api/workspaces/${ws.id}/github-handoff-draft`,
            );
            drafts[ws.id] = result.content;
          } catch {
            drafts[ws.id] = null;
          }
        }),
      );
      setGithubDrafts(drafts);
      // Fetch plan content for workspaces awaiting plan approval
      const plans: Record<string, string | null> = {};
      await Promise.all(
        data.filter(ws => ws.pendingPlanPath && ws.workingDir).map(async (ws) => {
          try {
            const result = await apiFetch<{ content: string | null }>(
              `/api/workspaces/${ws.id}/plan`,
            );
            plans[ws.id] = result.content;
          } catch {
            plans[ws.id] = null;
          }
        }),
      );
      setPlanContent(plans);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchWorkspaces();
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
    if (!selectedWorkspace || !selectedWsStatus || selectedWsIsDirect) return;
    if (selectedWsStatus !== "idle" && !initialShowDiff) return;
    if (diff || conflictState) return;
    apiFetch<DiffResponse>(`/api/workspaces/${selectedWorkspace}/diff`)
      .then((result) => {
        setDiff(result);
        setDiffComments(result.comments ?? []);
        if (result.conflicts) setConflictState(result.conflicts);
      })
      .catch(() => {});
  }, [selectedWorkspace, selectedWsStatus, selectedWsIsDirect, initialShowDiff]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setScorecard(null);
      return;
    }

    let cancelled = false;
    setScorecard(null);
    apiFetch<ScorecardResult>(`/api/workspaces/${selectedWorkspace}/scorecard`)
      .then((result) => {
        if (!cancelled) setScorecard(result);
      })
      .catch(() => {
        if (!cancelled) setScorecard(null);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace]);

  async function handleQuickLaunch(withPlanMode: boolean) {
    setActionLoading(true);
    setError(null);
    setCompletedMessages([]);
    setQuickDropdownOpen(false);
    onWorkspaceCreating?.(issue.id);
    try {
      const body = buildQuickLaunchBody({
        issueId: issue.id,
        requiresReview,
        planMode: withPlanMode,
        branch: suggestion,
        selectedProfile,
        prefs,
        includeModel: isClaudeQuickLaunch || isCodexQuickLaunch,
        model: selectedModel,
      });
      const result = await apiPost<WorkspaceResponse & { sessionId?: string }>("/api/workspaces", body);
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
      onWorkspaceCreateSettled?.(issue.id);
      setActionLoading(false);
    }
  }

  async function handleSkillQuickLaunch(skillId: string) {
    setActionLoading(true);
    setError(null);
    setCompletedMessages([]);
    setQuickDropdownOpen(false);
    onWorkspaceCreating?.(issue.id);
    try {
      const body = buildQuickLaunchBody({
        issueId: issue.id,
        requiresReview,
        planMode: false,
        branch: suggestion,
        skillId,
        selectedProfile,
        prefs,
        includeModel: isClaudeQuickLaunch || isCodexQuickLaunch,
        model: selectedModel,
      });
      const result = await apiPost<WorkspaceResponse & { sessionId?: string }>("/api/workspaces", body);
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
      onWorkspaceCreateSettled?.(issue.id);
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
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/launch`, body);
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

  async function handleChangeProfile(wsId: string, profileValue: string) {
    const colonIdx = profileValue.indexOf(":");
    const provider = colonIdx >= 0 ? profileValue.slice(0, colonIdx) : null;
    const name = colonIdx >= 0 ? profileValue.slice(colonIdx + 1) : null;
    try {
      await apiPatch(`/api/workspaces/${wsId}`, { provider: provider || null, claudeProfile: name || null });
      setEditingProfileWsId(null);
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Profile update failed");
    }
  }

  async function handleSendTurn(wsId: string) {
    if (!prompt.trim()) return;
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiPost<{ ok?: boolean; sessionId?: string; resumed?: boolean }>(`/api/workspaces/${wsId}/turn`, { content: prompt.trim() });
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
      await apiPost(`/api/workspaces/${wsId}/stop`);
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
        await apiPost(`/api/workspaces/${wsId}/stop`);
        setActiveSession(null);
        setCompletedMessages([]);
      }
      await apiPost(`/api/workspaces/${wsId}/merge`, {});
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
    // Show feedback the instant the button is pressed — the POST below blocks for
    // several seconds on a preflight rebase before the session exists, and we want
    // the live agent output front-and-centre the moment it does.
    setLaunchingFix({ wsId, kind: "fix-and-merge" });
    setSelectedHistoryId(null);
    setViewMode("output");
    try {
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/fix-and-merge`, { mergeError: errorMessage });
      setActiveSession(result.sessionId);
      setViewMode("output");
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fix-and-merge launch failed");
    } finally {
      setLaunchingFix(null);
      setActionLoading(false);
    }
  }

  async function handleOpenTerminal(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      await apiPost(`/api/workspaces/${wsId}/terminal`, {});
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
      await apiPost(`/api/workspaces/${wsId}/open-editor`, {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "VS Code launch failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function copyPreviewUrl(url: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(url);
      showToast("Preview URL copied", "success");
    } catch {
      window.prompt("Copy preview URL", url);
    }
  }

  async function handleGenerateGithubDraft(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiPost<{ content: string }>(`/api/workspaces/${wsId}/github-handoff-draft`);
      setGithubDrafts((prev) => ({ ...prev, [wsId]: result.content }));
      try {
        if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(result.content);
        showToast("GitHub draft generated and copied", "success");
      } catch {
        showToast("GitHub draft generated", "success");
      }
      onWorkspaceChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate GitHub draft");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCopyGithubDraft(content: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(content);
      showToast("GitHub draft copied", "success");
    } catch {
      window.prompt("Copy GitHub draft", content);
    }
  }

  async function handleExportHandoffBundle(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      const url = `/api/workspaces/${wsId}/handoff-bundle?format=markdown`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const text = await res.text();
      const blob = new Blob([text], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `handoff-${wsId.slice(0, 8)}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast("Handoff bundle downloaded", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export handoff bundle");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUpdateBase(wsId: string, mode: "rebase" | "merge") {
    setActionLoading(true);
    setError(null);
    setConflictState(null);
    try {
      const result = await apiPost<{ success: boolean; conflictingFiles?: string[]; error?: string }>(`/api/workspaces/${wsId}/update-base`, { mode });
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
      await apiPost("/api/internal/monitor-run");
    } finally {
      setMonitorRunning(false);
    }
  }

  async function handleAbortRebase(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      await apiPost(`/api/workspaces/${wsId}/abort-rebase`);
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
    setLaunchingFix({ wsId, kind: "resolve" });
    setSelectedHistoryId(null);
    setViewMode("output");
    try {
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/resolve-conflicts`);
      setActiveSession(result.sessionId);
      setCompletedMessages([]);
      setConflictState(null);
      setViewMode("output");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolve conflicts failed");
    } finally {
      setLaunchingFix(null);
      setActionLoading(false);
    }
  }

  async function handleResume(wsId: string, skipPermissions?: boolean) {
    setActionLoading(true);
    setError(null);
    const resumePrompt = "Continue where you left off. If you were in the middle of implementing something, pick up from where you stopped. If the implementation is complete, commit your changes and move this issue to In Review.";
    try {
      const body: Record<string, unknown> = {
        prompt: resumePrompt,
        resumeFromId: lastSessionPerWorkspace[wsId] || "",
      };
      if (skipPermissions) body.skipPermissions = true;
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/launch`, body);
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

  async function handleRestart(wsId: string, skipPermissions?: boolean) {
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
      const launchBody: Record<string, unknown> = { prompt: restartPrompt };
      if (skipPermissions) launchBody.skipPermissions = true;
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/launch`, launchBody);
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

  async function handleContinueFromSession(wsId: string, sessionId: string, skipPermissions?: boolean) {
    setActionLoading(true);
    setError(null);
    const continuePrompt = "Continue where you left off. If you were in the middle of implementing something, pick up from where you stopped. If the implementation is complete, commit your changes and move this issue to In Review.";
    try {
      const body: Record<string, unknown> = {
        prompt: continuePrompt,
        resumeFromId: sessionId,
      };
      if (skipPermissions) body.skipPermissions = true;
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/launch`, body);
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

  async function handleAutoBisect(wsId: string, scope: "related" | "full" = "related") {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/bisect`, { scope });
      setActiveSession(result.sessionId);
      setLastPrompt(`Auto-bisect (${scope})`);
      setCompletedMessages([]);
      setSelectedHistoryId(null);
      setViewMode("output");
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start auto-bisect");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReview(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/review`);
      setActiveSession(result.sessionId);
      setCompletedMessages([]);
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start review");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleImplementPlan(wsId: string, updatedPlanContent?: string) {
    setActionLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (updatedPlanContent !== undefined) body.planContent = updatedPlanContent;
      const result = await apiFetch<{ sessionId: string }>(`/api/workspaces/${wsId}/implement-plan`, {
        method: "POST",
        ...(Object.keys(body).length > 0 ? { body: JSON.stringify(body) } : {}),
      });
      setActiveSession(result.sessionId);
      setCompletedMessages([]);
      setPlanEditMode((prev) => ({ ...prev, [wsId]: false }));
      setPlanEditText((prev) => ({ ...prev, [wsId]: "" }));
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start implementation");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRejectPlan(wsId: string, feedback: string) {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiPost<{ sessionId: string }>(`/api/workspaces/${wsId}/reject-plan`, { feedback });
      setActiveSession(result.sessionId);
      setCompletedMessages([]);
      setRejectMode((prev) => ({ ...prev, [wsId]: false }));
      setRejectFeedback((prev) => ({ ...prev, [wsId]: "" }));
      await fetchWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject plan");
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
        await apiPost(`/api/workspaces/${wsId}/stop`);
        setActiveSession(null);
        setCompletedMessages([]);
      }
      await apiDelete(`/api/workspaces/${wsId}`);
      await fetchWorkspaces();
      onWorkspaceChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCloseWorkspace(wsId: string) {
    if (!window.confirm("Close this workspace without merging? It will be removed from active views. Session history is kept.")) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiPost(`/api/workspaces/${wsId}/close`);
      await fetchWorkspaces();
      onWorkspaceChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Close failed");
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
    let currentDragMode: "sidebar" | "modal" = panelMode === "modal" ? "modal" : "sidebar";
    let cleanup: (() => void) | null = null;

    if (currentDragMode === "sidebar") {
      const isLeftSidebar = sidebarSide === "left";
      const modalWidth = Math.min(1200, window.innerWidth * 0.96);
      const modalX = isLeftSidebar
        ? Math.max(0, Math.min(window.innerWidth - modalWidth, 200))
        : Math.max(0, Math.min(window.innerWidth - modalWidth, dragStartRef.current.panelX - 10));
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
        <div style={{ width: `min(${sidebarWidth}px, 100vw)` }} className="fixed left-0 top-0 h-full z-40 bg-blue-500/20 border-r-2 border-blue-400 pointer-events-none" />
      )}
      {snapZone === "right" && (
        <div style={{ width: `min(${sidebarWidth}px, 100vw)` }} className="fixed right-0 top-0 h-full z-40 bg-blue-500/20 border-l-2 border-blue-400 pointer-events-none" />
      )}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div
        data-panel
        className={`fixed bg-surface-raised dark:bg-surface-raised-dark shadow-xl z-50 flex flex-col animate-slide-in-right ${resizing ? "select-none" : ""} ${
          panelMode === "modal"
            ? "top-[5vh] left-1/2 -translate-x-1/2 w-[min(1200px,96vw)] h-[90vh] rounded-lg border border-gray-200 dark:border-gray-700"
            : sidebarSide === "left"
            ? "left-0 top-0 h-full border-r border-gray-200 dark:border-gray-700"
            : "right-0 top-0 h-full border-l border-gray-200 dark:border-gray-700"
        }`}
        style={
          dragPos && panelMode === "modal"
            ? { position: "fixed", left: dragPos.x, top: dragPos.y, transform: "none" }
            : panelMode === "sidebar"
            ? { width: `min(${sidebarWidth}px, 100vw)` }
            : undefined
        }
      >
        {/* Resize handle — only in sidebar mode, on the panel's inner edge */}
        {panelMode === "sidebar" && (
          <div
            onMouseDown={(e) => startResize(e, sidebarSide)}
            title="Drag to resize"
            className={`absolute top-0 bottom-0 ${sidebarSide === "right" ? "left-0 -ml-1" : "right-0 -mr-1"} w-2 cursor-col-resize z-10 group`}
          >
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent group-hover:bg-blue-400 transition-colors" />
          </div>
        )}
        <div
          className={`flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 min-w-0 cursor-grab active:cursor-grabbing ${panelMode === "modal" ? "rounded-t-lg" : ""}`}
          onMouseDown={handleHeaderMouseDown}
        >
          <h2 className="flex-1 min-w-0 text-sm font-semibold text-ink dark:text-stone-100 truncate" title={issue.title}>
            {issue.title}
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { setPanelMode(panelMode === "sidebar" ? "modal" : "sidebar"); setDragPos(null); }}
              title={panelMode === "sidebar" ? "Detach to floating panel" : "Snap back to sidebar"}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded"
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
              className="flex items-center justify-center w-6 h-6 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Run monitor now and reset timer"
            >
              {monitorRunning
                ? <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                : <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
              }
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {error}
              <button onClick={() => { setError(null); setMergeError(null); }} className="ml-2 text-red-400 dark:text-red-500 hover:text-red-600">
                Dismiss
              </button>
            </div>
          )}

          {project && (
            <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
              <div><span className="font-medium text-gray-600 dark:text-gray-400">Repo:</span> {project.repoPath}</div>
              <div><span className="font-medium text-gray-600 dark:text-gray-400">Branch:</span> {project.defaultBranch ?? "unset"}</div>
              {project.remoteUrl && (
                <div><span className="font-medium text-gray-600 dark:text-gray-400">Remote:</span> {project.remoteUrl}</div>
              )}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">Loading workspaces...</div>
          ) : workspaces.length === 0 && !showCreate ? (
            <div className="text-center py-6">
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">No workspaces yet</p>
              <div className="inline-flex relative">
                <button
                  onClick={() => handleQuickLaunch(false)}
                  disabled={actionLoading}
                  className="text-sm bg-brand-600 text-white px-4 py-1.5 rounded-l hover:bg-brand-700 disabled:opacity-50"
                >
                  {actionLoading ? "Creating..." : "New Workspace"}
                </button>
                <button
                  onClick={() => setQuickDropdownOpen((o) => !o)}
                  disabled={actionLoading}
                  className="text-sm bg-brand-600 text-white px-2 py-1.5 rounded-r border-l border-brand-500 hover:bg-brand-700 disabled:opacity-50"
                  title="More options"
                >
                  &#9662;
                </button>
                {quickDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 w-52 bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded shadow-lg z-10">
                    {availableProfileOptions.length > 0 && (
                      <>
                        <div className="px-3 py-1.5">
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Profile</label>
                          <select
                            value={selectedProfile}
                            onChange={(e) => setSelectedProfile(e.target.value)}
                            className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="">Default</option>
                            {availableProfileOptions.map((option) => (
                              <option key={profileOptionValue(option)} value={profileOptionValue(option)}>
                                {providerLabel(option.provider)}: {(option.provider === "copilot" && option.name === COPILOT_DEFAULT_PROFILE) || (option.provider === "codex" && option.name === CODEX_DEFAULT_PROFILE) ? "Default" : option.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="border-t border-gray-100 dark:border-gray-800" />
                      </>
                    )}
                    {(isClaudeQuickLaunch || isCodexQuickLaunch) && (
                      <>
                        <div className="px-3 py-1.5">
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Model</label>
                          <select
                            value={selectedModel}
                            onChange={(e) => setSelectedModel(e.target.value)}
                            className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {(isCodexQuickLaunch ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((m) => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="border-t border-gray-100 dark:border-gray-800" />
                      </>
                    )}
                    <button
                      onClick={() => handleQuickLaunch(false)}
                      className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      New Workspace
                    </button>
                    <button
                      onClick={() => handleQuickLaunch(true)}
                      className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      New Workspace with Plan Mode
                    </button>
                    {availableSkills.length > 0 && (
                      <>
                        <div className="border-t border-gray-100 dark:border-gray-800" />
                        <div className="px-3 py-1 text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Skills</div>
                        {availableSkills.map((skill) => (
                          <button
                            key={skill.id}
                            onClick={() => handleSkillQuickLaunch(skill.id)}
                            className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                            title={skill.description}
                          >
                            <span className="text-brand-600 dark:text-brand-400">✨</span>
                            {humanizeSkillName(skill.name)}
                          </button>
                        ))}
                      </>
                    )}
                    <div className="border-t border-gray-100 dark:border-gray-800" />
                    <button
                      onClick={() => {
                        setQuickDropdownOpen(false);
                        setShowCreate(true);
                      }}
                      className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
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
              onSubmitting={() => onWorkspaceCreating?.(issue.id)}
              onSettled={() => onWorkspaceCreateSettled?.(issue.id)}
              onCreated={(result) => {
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

          {workspaces.map((ws) => (
            <WorkspaceCard
              key={ws.id}
              ws={ws}
              issue={issue}
              project={project}
              liveStats={liveStats}
              selectedWorkspace={selectedWorkspace}
              isRunning={isRunning}
              activeSession={activeSession}
              messages={messages}
              wsState={wsState}
              isSessionAlive={isSessionAlive}
              isWaitingForInput={isWaitingForInput}
              workspaceSessions={workspaceSessions}
              selectedHistoryId={selectedHistoryId}
              historyMessages={historyMessages}
              completedMessages={completedMessages}
              viewMode={viewMode}
              summarySessionId={summarySessionId}
              summaryData={summaryData}
              summaryLoading={summaryLoading}
              lastSessionPerWorkspace={lastSessionPerWorkspace}
              lastPrompt={lastPrompt}
              prompt={prompt}
              latestCommits={latestCommits}
              githubDrafts={githubDrafts}
              planContent={planContent}
              planEditMode={planEditMode}
              planEditText={planEditText}
              rejectMode={rejectMode}
              rejectFeedback={rejectFeedback}
              editingProfileWsId={editingProfileWsId}
              availableProfileOptions={availableProfileOptions}
              scorecard={scorecard}
              expandedScorecards={expandedScorecards}
              launchingFix={launchingFix}
              diff={diff}
              diffComments={diffComments}
              mergeError={mergeError}
              conflictState={conflictState}
              availableSkills={availableSkills}
              expandedQuickActions={expandedQuickActions}
              actionLoading={actionLoading}
              visualProofArtifacts={visualProofArtifacts}
              visualProofLoading={visualProofLoading}
              prefs={prefs}
              textareaRef={textareaRef}
              setSelectedWorkspace={setSelectedWorkspace}
              setSelectedHistoryId={setSelectedHistoryId}
              setHistoryMessages={setHistoryMessages}
              setViewMode={setViewMode}
              setEditingProfileWsId={setEditingProfileWsId}
              setExpandedScorecards={setExpandedScorecards}
              setActiveSession={setActiveSession}
              setReplaySession={setReplaySession}
              setExpandedQuickActions={setExpandedQuickActions}
              setPrompt={setPrompt}
              setPlanEditText={setPlanEditText}
              setRejectFeedback={setRejectFeedback}
              setRejectMode={setRejectMode}
              setPlanEditMode={setPlanEditMode}
              canResume={canResume}
              canRestart={canRestart}
              handleChangeProfile={handleChangeProfile}
              handleViewHistory={handleViewHistory}
              handleStop={handleStop}
              handleContinueFromSession={handleContinueFromSession}
              handleRestart={handleRestart}
              handleFetchSummary={handleFetchSummary}
              handleReview={handleReview}
              handleMerge={handleMerge}
              handleAutoBisect={handleAutoBisect}
              handleExportHandoffBundle={handleExportHandoffBundle}
              handleSkillQuickLaunch={handleSkillQuickLaunch}
              handleSendTurn={handleSendTurn}
              handleLaunch={handleLaunch}
              handleViewDiff={handleViewDiff}
              handleResume={handleResume}
              handleUpdateBase={handleUpdateBase}
              handleOpenTerminal={handleOpenTerminal}
              handleOpenEditor={handleOpenEditor}
              copyPreviewUrl={copyPreviewUrl}
              handleCloseWorkspace={handleCloseWorkspace}
              handleDeleteWorkspace={handleDeleteWorkspace}
              handleRejectPlan={handleRejectPlan}
              handleImplementPlan={handleImplementPlan}
              handleFixAndMerge={handleFixAndMerge}
              handleResolveConflicts={handleResolveConflicts}
              handleAbortRebase={handleAbortRebase}
              handleGenerateGithubDraft={handleGenerateGithubDraft}
              handleCopyGithubDraft={handleCopyGithubDraft}
            />
          ))}

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
                <div className="absolute bottom-full left-0 mb-1 w-52 bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded shadow-lg z-10">
                  {availableProfileOptions.length > 0 && (
                    <>
                      <div className="px-3 py-1.5">
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Profile</label>
                        <select
                          value={selectedProfile}
                          onChange={(e) => setSelectedProfile(e.target.value)}
                          className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="">Default</option>
                          {availableProfileOptions.map((option) => (
                            <option key={profileOptionValue(option)} value={profileOptionValue(option)}>
                              {providerLabel(option.provider)}: {(option.provider === "copilot" && option.name === COPILOT_DEFAULT_PROFILE) || (option.provider === "codex" && option.name === CODEX_DEFAULT_PROFILE) ? "Default" : option.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="border-t border-gray-100 dark:border-gray-800" />
                    </>
                  )}
                  <button
                    onClick={() => handleQuickLaunch(false)}
                    className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    New Workspace
                  </button>
                  <button
                    onClick={() => handleQuickLaunch(true)}
                    className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    New Workspace with Plan Mode
                  </button>
                  {availableSkills.length > 0 && (
                    <>
                      <div className="border-t border-gray-100 dark:border-gray-800" />
                      <div className="px-3 py-1 text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Skills</div>
                      {availableSkills.map((skill) => (
                        <button
                          key={skill.id}
                          onClick={() => handleSkillQuickLaunch(skill.id)}
                          className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                          title={skill.description}
                        >
                          <span className="text-brand-600 dark:text-brand-400">✨</span>
                          {humanizeSkillName(skill.name)}
                        </button>
                      ))}
                    </>
                  )}
                  <div className="border-t border-gray-100 dark:border-gray-800" />
                  <button
                    onClick={() => { setQuickDropdownOpen(false); setShowCreate(true); }}
                    className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
                  >
                    Custom options...
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {replaySession && (
        <SessionReplay
          sessionId={replaySession.id}
          sessionLabel={replaySession.label}
          outputFormat={replaySession.outputFormat as AgentOutputFormat}
          onClose={() => setReplaySession(null)}
        />
      )}
    </>
  );
}
