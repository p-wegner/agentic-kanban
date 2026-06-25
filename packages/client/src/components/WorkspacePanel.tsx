import React, { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";
import { type AgentOutputFormat } from "../lib/agent-output-parser.js";
import { detectQuickLaunchProvider, canResumeWorkspace, canRestartWorkspace, type RelaunchContext } from "../lib/workspaceLaunchState.js";
import { buildDefaultLaunchPrompt } from "../lib/workspace-launch.js";
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
import { useWorkspacePanelDrag } from "../hooks/useWorkspacePanelDrag.js";
import { useProfileSelection } from "../hooks/useProfileSelection.js";
import { SessionReplay } from "./SessionReplay.js";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { WorkspaceQuickLaunch } from "./WorkspaceQuickLaunch.js";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState.js";
import { WorkspacePanelHeader } from "./WorkspacePanelHeader.js";
import { useWorkspaceGithubHandoff } from "../hooks/useWorkspaceGithubHandoff.js";
import { useWorkspaceActions } from "../hooks/useWorkspaceActions.js";
import { invalidateClientSurface } from "../lib/clientInvalidation.js";
import {
  fetchLatestCommits,
  fetchGithubDrafts,
  fetchPlanContents,
  pickInitialWorkspaceId,
} from "../lib/workspace-secondary-data.js";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import type {
  AgentOutputMessage,
  IssueArtifact,
  IssueWithStatus,
  WorkspaceResponse,
  DiffResponse,
  DiffComment,
} from "@agentic-kanban/shared";

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
  const queryClient = useQueryClient();
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
  const { sidebarSide, dragPos, setDragPos, snapZone, handleHeaderMouseDown } = useWorkspacePanelDrag({
    panelMode,
    setPanelMode,
  });
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

  const invalidateWorkspaceSurface = useCallback(async () => {
    await invalidateClientSurface(queryClient, {
      surface: "workspace",
      projectId: issue.projectId,
      issueId: issue.id,
    });
    onWorkspaceChange?.();
  }, [issue.id, issue.projectId, onWorkspaceChange, queryClient]);

  const [latestCommits, setLatestCommits] = useState<Record<string, { sha: string; message: string } | null>>({});
  const { githubDrafts, setGithubDrafts, handleGenerateGithubDraft, handleCopyGithubDraft, handleExportHandoffBundle } = useWorkspaceGithubHandoff({ setActionLoading, setError, onWorkspaceChange: invalidateWorkspaceSurface });
  const [planContent, setPlanContent] = useState<Record<string, string | null>>({});
  const [planEditMode, setPlanEditMode] = useState<Record<string, boolean>>({});
  const [planEditText, setPlanEditText] = useState<Record<string, string>>({});
  const [rejectMode, setRejectMode] = useState<Record<string, boolean>>({});
  const [rejectFeedback, setRejectFeedback] = useState<Record<string, string>>({});
  const initialSessionAppliedRef = useRef(false);
  // Guards against finalizing the same session more than once: the WS may push
  // trailing `messages` updates after the terminal `exit`, each re-running the
  // completion effect before `setActiveSession(null)` has flushed.
  const completedSessionRef = useRef<string | null>(null);

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
    initialSessionId ? buildDefaultLaunchPrompt(issue) : ""
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
  const { isClaude: isClaudeQuickLaunch, isCodex: isCodexQuickLaunch } = detectQuickLaunchProvider(selectedProfile, prefs.provider);
  const relaunchCtx = (ws: WorkspaceResponse): RelaunchContext =>
    ({ isRunning, hasActiveSession: activeSession !== null, lastSessionId: lastSessionPerWorkspace[ws.id] });
  const canResume = (ws: WorkspaceResponse, sessions: SessionInfo[]) => canResumeWorkspace(ws, sessions, relaunchCtx(ws));
  const canRestart = (ws: WorkspaceResponse, sessions: SessionInfo[]) => canRestartWorkspace(ws, sessions, relaunchCtx(ws));

  // Session completion is driven purely by the per-workspace WebSocket
  // (`useWebSocket`), which streams agent output including the terminal `exit`
  // message into `messages`. When that arrives we fetch the final output once
  // and finalize. The former 1.5s `setInterval` poll of `/api/sessions/:id/output`
  // was a redundant second realtime channel (#907) — the WS already delivers
  // `exit`, so the poll only duplicated the same fetch on a timer.
  useEffect(() => {
    if (!activeSession) return;
    if (!messages.some(m => m.type === "exit")) return;

    const wsId = selectedWorkspace;
    const sid = activeSession;
    if (completedSessionRef.current === sid) return;
    completedSessionRef.current = sid;

    function completeSession(output: AgentOutputMessage[]) {
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
      void fetchWorkspaces();
    }

    apiFetch<AgentOutputMessage[]>(`/api/sessions/${sid}/output`)
      .then((data) => completeSession(data))
      .catch(() => completeSession([...messages]));
  }, [messages, activeSession]);

  async function fetchWorkspaces() {
    try {
      const data = await apiFetch<WorkspaceResponse[]>(
        `/api/issues/${issue.id}/workspaces`,
      );
      setWorkspaces(data);
      const initialId = pickInitialWorkspaceId(data, selectedWorkspace, autoSelectId);
      if (initialId) setSelectedWorkspace(initialId);
      // Hydrate the three independent secondary maps in parallel. (The former
      // per-workspace `/handoff` GET never existed on the server — only
      // `/handoff-bundle` and `/github-handoff-draft` do — so it was dropped to kill
      // the 404 noise; wiring handoff display to a real endpoint is tracked separately.)
      const [commits, drafts, plans] = await Promise.all([
        fetchLatestCommits(data, apiFetch),
        fetchGithubDrafts(data, apiFetch),
        fetchPlanContents(data, apiFetch),
      ]);
      setLatestCommits(commits);
      setGithubDrafts(drafts);
      setPlanContent(plans);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchWorkspaces();
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
    handleResetWorkspaceToIdle,
    handleImplementPlan, handleRejectPlan, handleDeleteWorkspace, handleCloseWorkspace,
  } = useWorkspaceActions({
    issue, selectedProfile, selectedModel, prefs, requiresReview, suggestion,
    isClaudeQuickLaunch, isCodexQuickLaunch, isRunning, prompt, activeSession, messages,
    lastSessionPerWorkspace, disconnect, fetchWorkspaces,
    onWorkspaceChange: invalidateWorkspaceSurface, onWorkspaceCreating, onWorkspaceCreateSettled,
    setActionLoading, setActiveSession, setCompletedMessages, setConflictState,
    setDiff, setDiffComments, setEditingProfileWsId, setError, setHistoryMessages,
    setLastPrompt, setLastSessionPerWorkspace, setLaunchingFix, setMergeError,
    setMonitorRunning, setPlanEditMode, setPlanEditText, setPrompt,
    setQuickDropdownOpen, setRejectFeedback, setRejectMode, setSelectedHistoryId,
    setSelectedWorkspace, setShowCreate, setViewMode, setWorkspaceSessions,
  });

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
        <WorkspacePanelHeader
          issueTitle={issue.title}
          panelMode={panelMode}
          monitorRunning={monitorRunning}
          onTogglePanelMode={() => { setPanelMode(panelMode === "sidebar" ? "modal" : "sidebar"); setDragPos(null); }}
          onHeaderMouseDown={handleHeaderMouseDown}
          onMonitorRunNow={handleMonitorRunNow}
          onClose={onClose}
        />

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
            <WorkspaceEmptyState
              actionLoading={actionLoading}
              open={quickDropdownOpen}
              setOpen={setQuickDropdownOpen}
              availableProfileOptions={availableProfileOptions}
              selectedProfile={selectedProfile}
              onSelectedProfileChange={setSelectedProfile}
              selectedModel={selectedModel}
              onSelectedModelChange={setSelectedModel}
              isClaudeQuickLaunch={isClaudeQuickLaunch}
              isCodexQuickLaunch={isCodexQuickLaunch}
              availableSkills={availableSkills}
              onQuickLaunch={handleQuickLaunch}
              onSkillQuickLaunch={handleSkillQuickLaunch}
              onCustomOptions={() => { setQuickDropdownOpen(false); setShowCreate(true); }}
            />
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
                  setLastPrompt(buildDefaultLaunchPrompt(issue));
                }
                void fetchWorkspaces();
                void invalidateWorkspaceSurface();
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
              handleResetWorkspaceToIdle={handleResetWorkspaceToIdle}
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
