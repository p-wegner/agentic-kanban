import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
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
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import {
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  humanizeSkillName,
  profileOptionValue,
  providerLabel,
} from "../lib/workspace-helpers.js";
import { WorkspaceQuickLaunch } from "./WorkspaceQuickLaunch.js";
import { useWorkspaceGithubHandoff } from "../hooks/useWorkspaceGithubHandoff.js";
import { useWorkspaceActions } from "../hooks/useWorkspaceActions.js";
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
  const { githubDrafts, setGithubDrafts, handleGenerateGithubDraft, handleCopyGithubDraft, handleExportHandoffBundle } = useWorkspaceGithubHandoff({ setActionLoading, setError, onWorkspaceChange });
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

  const {
    handleQuickLaunch, handleSkillQuickLaunch, handleLaunch, handleChangeProfile,
    handleSendTurn, handleStop, handleViewDiff, handleMerge, handleFixAndMerge,
    handleOpenTerminal, handleOpenEditor, copyPreviewUrl, handleUpdateBase,
    handleMonitorRunNow, handleAbortRebase, handleResolveConflicts, handleResume,
    handleRestart, handleContinueFromSession, handleAutoBisect, handleReview,
    handleImplementPlan, handleRejectPlan, handleDeleteWorkspace, handleCloseWorkspace,
  } = useWorkspaceActions({
    issue, selectedProfile, selectedModel, prefs, requiresReview, suggestion,
    isClaudeQuickLaunch, isCodexQuickLaunch, isRunning, prompt, activeSession, messages,
    lastSessionPerWorkspace, disconnect, fetchWorkspaces,
    onWorkspaceChange, onWorkspaceCreating, onWorkspaceCreateSettled,
    setActionLoading, setActiveSession, setCompletedMessages, setConflictState,
    setDiff, setDiffComments, setEditingProfileWsId, setError, setHistoryMessages,
    setLastPrompt, setLastSessionPerWorkspace, setLaunchingFix, setMergeError,
    setMonitorRunning, setPlanEditMode, setPlanEditText, setPrompt,
    setQuickDropdownOpen, setRejectFeedback, setRejectMode, setSelectedHistoryId,
    setSelectedWorkspace, setShowCreate, setViewMode, setWorkspaceSessions,
  });

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

          <WorkspaceQuickLaunch
            hasWorkspaces={workspaces.length > 0}
            actionLoading={actionLoading}
            open={quickDropdownOpen}
            setOpen={setQuickDropdownOpen}
            availableProfileOptions={availableProfileOptions}
            selectedProfile={selectedProfile}
            onSelectedProfileChange={setSelectedProfile}
            availableSkills={availableSkills}
            onQuickLaunch={handleQuickLaunch}
            onSkillQuickLaunch={handleSkillQuickLaunch}
            onCustomOptions={() => { setQuickDropdownOpen(false); setShowCreate(true); }}
          />
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
