import React from "react";
import ReactMarkdown from "react-markdown";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { getWorkspacePreviewUrl } from "../lib/workspace-preview.js";
import { getOutputFormatForAgent, getOutputFormatForProvider, type AgentOutputFormat } from "../lib/agent-output-parser.js";
import { TerminalView } from "./TerminalView.js";
import { WorkspacePreviewPanel } from "./WorkspacePreviewPanel.js";
import { WorkspaceActionButton } from "./WorkspaceActionButton.js";
import { WorkspaceArtifactsBrowser } from "./WorkspaceArtifactsBrowser.js";
import { WorkspaceDiagnosticsPanel } from "./WorkspaceDiagnosticsPanel.js";
import { WorkspaceTimelinePanel } from "./WorkspaceTimelinePanel.js";
import { FailurePatternHint } from "./FailurePatternHint.js";
import TicketMentionInput from "./TicketMentionInput.js";
import { SetupStatusPanel } from "./SetupStatusPanel.js";
import { WorkspacePlanApprovalCard } from "./WorkspacePlanApprovalCard.js";
import { WorkspaceSummaryView } from "./WorkspaceSummaryView.js";
import {
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  SESSION_STATUS_COLORS,
  STATUS_COLORS,
  formatDuration,
  formatTokenCount,
  getTriggerTypeLabel,
  humanizeSkillName,
  parseStats,
  profileOptionValue,
  providerLabel,
  type ProfileOption,
} from "../lib/workspace-helpers.js";
import { SessionStatsBadge, SessionStatsSummary } from "../lib/session-stats.js";
import { ContextWindowView } from "./ContextWindowView.js";
import type { WorkspaceViewMode } from "../hooks/useWorkspaceSession.js";
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

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  setupScript?: string | null;
  setupEnabled?: boolean;
  setupBlocking?: boolean;
  symlinkEnabled?: boolean;
  symlinkDirs?: string | null;
}

export interface SessionInfo {
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

export interface ScorecardDimension {
  name: string;
  score: number;
  maxScore: number;
  signal: string;
}

export interface ScorecardResult {
  total: number;
  dimensions: ScorecardDimension[];
  computedAt: string;
}

export type AvailableSkill = {
  id: string;
  name: string;
  description: string;
};

export interface WorkspaceQuickActionsProps {
  workspace: WorkspaceResponse;
  completedSessions: SessionInfo[];
  availableSkills: AvailableSkill[];
  expandedQuickActions: Record<string, boolean>;
  setExpandedQuickActions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  actionLoading: boolean;
  onReview: (workspaceId: string) => void;
  onMerge: (workspaceId: string) => void;
  onAutoBisect: (workspaceId: string, mode?: "related" | "full") => void;
  onExportHandoffBundle: (workspaceId: string) => Promise<void>;
  onSkillQuickLaunch: (skillId: string) => void;
}

export function WorkspaceQuickActions({
  workspace,
  completedSessions,
  availableSkills,
  expandedQuickActions,
  setExpandedQuickActions,
  actionLoading,
  onReview,
  onMerge,
  onAutoBisect,
  onExportHandoffBundle,
  onSkillQuickLaunch,
}: WorkspaceQuickActionsProps) {
  if (workspace.status === "closed" || !workspace.workingDir) return null;

  const lastReview = completedSessions.filter(s => s.triggerType === "review").at(-1);
  const lastMerge = completedSessions.filter(s => s.triggerType === "merge").at(-1);
  const lastBisect = completedSessions.filter(s => s.triggerType === "bisect").at(-1);
  const quickActionsKey = `qa-${workspace.id}`;
  const qaExpanded = expandedQuickActions[quickActionsKey];

  return (
    <div className="pt-1">
      <button
        onClick={() => setExpandedQuickActions((prev) => ({ ...prev, [quickActionsKey]: !prev[quickActionsKey] }))}
        className="flex items-center gap-1 text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide hover:text-gray-600 dark:hover:text-gray-300 w-full text-left"
      >
        <svg className={`w-3 h-3 transition-transform ${qaExpanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Quick Actions
      </button>
      {qaExpanded && (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-1">
          <div className="flex flex-col gap-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); onReview(workspace.id); }}
              disabled={actionLoading}
              className="text-[10px] font-medium px-2 py-0.5 rounded bg-accent-50 text-accent-700 hover:bg-accent-100 dark:bg-accent-900/40 dark:text-accent-300 disabled:opacity-50"
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
              onClick={(e) => { e.stopPropagation(); onMerge(workspace.id); }}
              disabled={actionLoading}
              className="text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50"
              title="Merge this workspace"
            >
              {workspace.isDirect ? "Close" : "AI Merge"}
            </button>
            {lastMerge && (
              <span className={`text-[9px] px-1 ${lastMerge.status === "completed" ? "text-green-600" : "text-yellow-600"}`}>
                {lastMerge.status === "completed" ? "✓" : "✗"} {formatRelativeTime(lastMerge.endedAt ?? lastMerge.startedAt)}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex">
              <button
                onClick={(e) => { e.stopPropagation(); onAutoBisect(workspace.id, "related"); }}
                disabled={actionLoading}
                className="text-[10px] font-medium px-2 py-0.5 rounded-l bg-rose-100 text-rose-700 hover:bg-rose-200 disabled:opacity-50"
                title="Run git bisect using tests related to changed files"
              >
                Auto-bisect
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onAutoBisect(workspace.id, "full"); }}
                disabled={actionLoading}
                className="text-[10px] font-medium px-1.5 py-0.5 rounded-r bg-rose-200 text-rose-800 hover:bg-rose-300 disabled:opacity-50 border-l border-rose-300"
                title="Run git bisect using the full test suite"
              >
                Full
              </button>
            </div>
            {lastBisect && (
              <span className={`text-[9px] px-1 ${lastBisect.status === "completed" && lastBisect.exitCode === "0" ? "text-green-600" : "text-yellow-600"}`}>
                {lastBisect.status === "completed" && lastBisect.exitCode === "0" ? "ok" : "fail"} {formatRelativeTime(lastBisect.endedAt ?? lastBisect.startedAt)}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); void onExportHandoffBundle(workspace.id); }}
              disabled={actionLoading}
              className="text-[10px] font-medium px-2 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 disabled:opacity-50"
              title="Download a Markdown handoff bundle for this workspace"
            >
              Export Handoff
            </button>
          </div>
          {availableSkills.map((skill) => {
            const lastSkill = completedSessions.filter(s => s.triggerType === `skill:${skill.name}`).at(-1);
            return (
              <div key={skill.id} className="flex flex-col gap-0.5">
                <button
                  onClick={(e) => { e.stopPropagation(); onSkillQuickLaunch(skill.id); }}
                  disabled={actionLoading}
                  className="text-[10px] font-medium px-2 py-0.5 rounded bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-900/40 dark:text-brand-300 disabled:opacity-50"
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
      )}
    </div>
  );
}

export interface WorkspaceCardProps {
  ws: WorkspaceResponse;
  issue: IssueWithStatus;
  project: Project | null;
  liveStats?: LiveSessionStats | null;
  // Selection / live session state
  selectedWorkspace: string | null;
  isRunning: boolean;
  activeSession: string | null;
  messages: AgentOutputMessage[];
  wsState: "connecting" | "open" | "closed" | "error";
  isSessionAlive: boolean;
  isWaitingForInput: boolean;
  // Session/history state
  workspaceSessions: Record<string, SessionInfo[]>;
  selectedHistoryId: string | null;
  historyMessages: AgentOutputMessage[];
  completedMessages: AgentOutputMessage[];
  viewMode: WorkspaceViewMode;
  summarySessionId: string | null;
  summaryData: SessionSummaryResponse | null;
  summaryLoading: boolean;
  lastSessionPerWorkspace: Record<string, string>;
  lastPrompt: string;
  prompt: string;
  // Workspace-derived maps
  latestCommits: Record<string, { sha: string; message: string } | null>;
  githubDrafts: Record<string, string | null>;
  planContent: Record<string, string | null>;
  planEditMode: Record<string, boolean>;
  planEditText: Record<string, string>;
  rejectMode: Record<string, boolean>;
  rejectFeedback: Record<string, string>;
  // Profile editing
  editingProfileWsId: string | null;
  availableProfileOptions: ProfileOption[];
  // Scorecard / diff / fix state
  scorecard: ScorecardResult | null;
  expandedScorecards: Record<string, boolean>;
  launchingFix: { wsId: string; kind: "fix-and-merge" | "resolve" } | null;
  diff: DiffResponse | null;
  diffComments: DiffComment[];
  mergeError: { wsId: string; message: string } | null;
  conflictState: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  // Quick actions
  availableSkills: AvailableSkill[];
  expandedQuickActions: Record<string, boolean>;
  actionLoading: boolean;
  // Visual proof
  visualProofArtifacts: IssueArtifact[];
  visualProofLoading: boolean;
  // Misc config
  prefs: Record<string, string>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  // Setters
  setSelectedWorkspace: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedHistoryId: (id: string | null) => void;
  setHistoryMessages: (messages: AgentOutputMessage[]) => void;
  setViewMode: React.Dispatch<React.SetStateAction<WorkspaceViewMode>>;
  setEditingProfileWsId: React.Dispatch<React.SetStateAction<string | null>>;
  setExpandedScorecards: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setActiveSession: React.Dispatch<React.SetStateAction<string | null>>;
  setReplaySession: React.Dispatch<React.SetStateAction<{ id: string; label: string; outputFormat: string } | null>>;
  setExpandedQuickActions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setPrompt: (value: string) => void;
  setPlanEditText: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setRejectFeedback: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setRejectMode: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setPlanEditMode: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  // Predicates
  canResume: (ws: WorkspaceResponse, sessions: SessionInfo[]) => boolean;
  canRestart: (ws: WorkspaceResponse, sessions: SessionInfo[]) => boolean;
  // Handlers
  handleChangeProfile: (wsId: string, profileValue: string) => void;
  handleViewHistory: (sessionId: string) => void;
  handleStop: (wsId: string) => void;
  handleContinueFromSession: (wsId: string, sessionId: string, skipPermissions?: boolean) => void;
  handleRestart: (wsId: string, skipPermissions?: boolean) => void;
  handleFetchSummary: (sessionId: string, isRunning: boolean) => void;
  handleReview: (wsId: string) => void;
  handleMerge: (wsId: string) => void;
  handleAutoBisect: (wsId: string, scope?: "related" | "full") => void;
  handleExportHandoffBundle: (wsId: string) => Promise<void>;
  handleSkillQuickLaunch: (skillId: string) => void;
  handleSendTurn: (wsId: string) => void;
  handleLaunch: (wsId: string) => void;
  handleViewDiff: (wsId: string) => void;
  handleResume: (wsId: string, skipPermissions?: boolean) => void;
  handleUpdateBase: (wsId: string, mode: "rebase" | "merge") => void;
  handleOpenTerminal: (wsId: string) => void;
  handleOpenEditor: (wsId: string) => void;
  copyPreviewUrl: (url: string) => void;
  handleCloseWorkspace: (wsId: string) => void;
  handleDeleteWorkspace: (wsId: string) => void;
  handleRejectPlan: (wsId: string, feedback: string) => void;
  handleImplementPlan: (wsId: string, updatedPlanContent?: string) => void;
  handleFixAndMerge: (wsId: string, errorMessage: string) => void;
  handleResolveConflicts: (wsId: string) => void;
  handleAbortRebase: (wsId: string) => void;
  handleGenerateGithubDraft: (wsId: string) => void;
  handleCopyGithubDraft: (content: string) => void;
}

export function WorkspaceCard({
  ws,
  issue,
  project,
  liveStats,
  selectedWorkspace,
  isRunning,
  activeSession,
  messages,
  wsState,
  isSessionAlive,
  isWaitingForInput,
  workspaceSessions,
  selectedHistoryId,
  historyMessages,
  completedMessages,
  viewMode,
  summarySessionId,
  summaryData,
  summaryLoading,
  lastSessionPerWorkspace,
  lastPrompt,
  prompt,
  latestCommits,
  githubDrafts,
  planContent,
  planEditMode,
  planEditText,
  rejectMode,
  rejectFeedback,
  editingProfileWsId,
  availableProfileOptions,
  scorecard,
  expandedScorecards,
  launchingFix,
  diff,
  diffComments,
  mergeError,
  conflictState,
  availableSkills,
  expandedQuickActions,
  actionLoading,
  visualProofArtifacts,
  visualProofLoading,
  prefs,
  textareaRef,
  setSelectedWorkspace,
  setSelectedHistoryId,
  setHistoryMessages,
  setViewMode,
  setEditingProfileWsId,
  setExpandedScorecards,
  setActiveSession,
  setReplaySession,
  setExpandedQuickActions,
  setPrompt,
  setPlanEditText,
  setRejectFeedback,
  setRejectMode,
  setPlanEditMode,
  canResume,
  canRestart,
  handleChangeProfile,
  handleViewHistory,
  handleStop,
  handleContinueFromSession,
  handleRestart,
  handleFetchSummary,
  handleReview,
  handleMerge,
  handleAutoBisect,
  handleExportHandoffBundle,
  handleSkillQuickLaunch,
  handleSendTurn,
  handleLaunch,
  handleViewDiff,
  handleResume,
  handleUpdateBase,
  handleOpenTerminal,
  handleOpenEditor,
  copyPreviewUrl,
  handleCloseWorkspace,
  handleDeleteWorkspace,
  handleRejectPlan,
  handleImplementPlan,
  handleFixAndMerge,
  handleResolveConflicts,
  handleAbortRebase,
  handleGenerateGithubDraft,
  handleCopyGithubDraft,
}: WorkspaceCardProps) {
  const isSelected = selectedWorkspace === ws.id;
  const isThisRunning = isSelected && isRunning;
  const isLaunching = isSelected && ws.status === "active" && activeSession && messages.length === 0;
  const badgeColor = STATUS_COLORS[ws.status] ?? "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400";
  const sessions = workspaceSessions[ws.id] ?? [];
  const completedSessions = sessions.filter((s) => s.status !== "running");
  const runningSession = sessions.find((s) => s.status === "running");
  const workspaceProvider = ws.profile?.provider ?? ws.provider;
  const workspaceProfile = ws.profile?.name ?? ws.claudeProfile;
  const preview = getWorkspacePreviewUrl(ws);
  const runningTriggerLabel = runningSession
    ? (getTriggerTypeLabel(runningSession.triggerType, runningSession.skillName) ?? { label: "Agent", className: "bg-blue-50 text-blue-600" })
    : null;

  return (
    <div
      className={`border rounded p-3 space-y-2 cursor-pointer transition-colors ${
        isSelected ? "border-blue-400 bg-blue-50 dark:bg-blue-950" : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
      }`}
      onClick={() => {
        const nextId = isSelected ? null : ws.id;
        setSelectedWorkspace(nextId);
        setSelectedHistoryId(null);
        setHistoryMessages([]);
        const hasSessions = sessions.length > 0 || runningSession;
        setViewMode(hasSessions || ws.workingDir ? "output" : "timeline");
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {ws.branch}
          {ws.isDirect && (
            <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">direct</span>
          )}
          {ws.planMode && (
            <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">plan</span>
          )}
          {editingProfileWsId === ws.id ? (
            <select
              className="ml-1.5 text-[10px] border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-900 dark:text-gray-100"
              defaultValue={workspaceProvider ? `${workspaceProvider}:${workspaceProfile || (workspaceProvider === "codex" ? CODEX_DEFAULT_PROFILE : workspaceProvider === "copilot" ? COPILOT_DEFAULT_PROFILE : "")}` : ""}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => { e.stopPropagation(); handleChangeProfile(ws.id, e.target.value); }}
              onBlur={() => setEditingProfileWsId(null)}
            >
              <option value="">Default</option>
              {availableProfileOptions.map((option) => (
                <option key={profileOptionValue(option)} value={profileOptionValue(option)}>
                  {providerLabel(option.provider)}: {(option.provider === "copilot" && option.name === COPILOT_DEFAULT_PROFILE) || (option.provider === "codex" && option.name === CODEX_DEFAULT_PROFILE) ? "Default" : option.name}
                </option>
              ))}
            </select>
          ) : (
            <>
              {workspaceProvider && (
                <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                  {providerLabel(workspaceProvider)}{workspaceProfile ? `:${workspaceProfile}` : ""}
                </span>
              )}
              {(ws.status === "idle" || ws.status === "error") && availableProfileOptions.length > 0 && (
                <button
                  title="Change agent profile"
                  onClick={(e) => { e.stopPropagation(); setEditingProfileWsId(ws.id); }}
                  className="ml-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 leading-none"
                >
                  ✎
                </button>
              )}
            </>
          )}
          {ws.model && (
            <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 capitalize">
              {ws.model}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          {isThisRunning && runningTriggerLabel && (
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded animate-pulse ${runningTriggerLabel.className}`}>
              {runningTriggerLabel.label}
            </span>
          )}
          {ws.readyForMerge && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700">
              Ready to merge
            </span>
          )}
          {ws.mergedAt && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
              Merged
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
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{ws.workingDir}</p>
      )}

      {(ws.baseBranch && ws.baseBranch !== project?.defaultBranch || ws.skillName) && (
        <div className="flex flex-wrap gap-1.5 text-xs" data-testid="workspace-info">
          {ws.baseBranch && ws.baseBranch !== project?.defaultBranch && (
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium" data-testid="workspace-base-branch">
              ↑ {ws.baseBranch}
            </span>
          )}
          {ws.skillName && (
            <span className="px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 font-medium" data-testid="workspace-skill-name">
              ✨ {humanizeSkillName(ws.skillName)}
            </span>
          )}
        </div>
      )}

      <div className="flex gap-3 text-xs text-gray-400 dark:text-gray-500">
        <span>Created {formatRelativeTime(ws.createdAt)}</span>
        {ws.mergedAt ? (
          <span>Merged {formatRelativeTime(ws.mergedAt)}</span>
        ) : ws.closedAt ? (
          <span>Closed {formatRelativeTime(ws.closedAt)}</span>
        ) : null}
      </div>

      {ws.workingDir && (
        <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
          {latestCommits[ws.id] === undefined
            ? null
            : latestCommits[ws.id] === null
            ? <span className="text-gray-400 dark:text-gray-500 font-sans">No commits</span>
            : <span title={latestCommits[ws.id]!.message}>
                <span className="text-gray-400 dark:text-gray-500">{latestCommits[ws.id]!.sha}</span>
                {" "}
                <span className="text-gray-600 dark:text-gray-300">{latestCommits[ws.id]!.message}</span>
              </span>
          }
        </div>
      )}

      <SetupStatusPanel setup={ws.latestSetup ?? null} />

      {isThisRunning && (ws.contextTokens || ws.lastTool) && (
        <div className="flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
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

      {isSelected && scorecard && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 p-3 space-y-2">
          <button
            onClick={() => setExpandedScorecards((prev) => ({ ...prev, [ws.id]: !prev[ws.id] }))}
            className="flex items-center justify-between gap-3 w-full text-left"
          >
            <div className="flex items-center gap-1.5">
              <svg className={`w-3 h-3 text-gray-400 dark:text-gray-500 shrink-0 transition-transform ${expandedScorecards[ws.id] ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <div>
                <div className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Scorecard</div>
                <div className="text-xs text-gray-400 dark:text-gray-500">Updated {formatRelativeTime(scorecard.computedAt)}</div>
              </div>
            </div>
            <span className={`inline-flex items-center px-2 py-1 rounded text-sm font-bold ${
              scorecard.total >= 80 ? "bg-green-100 text-green-700" :
              scorecard.total >= 60 ? "bg-yellow-100 text-yellow-700" :
              "bg-red-100 text-red-700"
            }`}>
              {scorecard.total}/100
            </span>
          </button>
          {expandedScorecards[ws.id] && (
            <div className="space-y-2">
              {scorecard.dimensions.map((dimension) => {
                const percent = Math.max(0, Math.min(100, (dimension.score / dimension.maxScore) * 100));
                const barColor = percent >= 80 ? "bg-green-500" : percent >= 60 ? "bg-yellow-500" : "bg-red-500";
                return (
                  <div key={dimension.name} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-gray-700 dark:text-gray-200">{dimension.name}</span>
                      <span className="font-mono text-gray-500 dark:text-gray-400">{dimension.score}/{dimension.maxScore}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${percent}%` }} />
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">{dimension.signal}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {isSelected && launchingFix?.wsId === ws.id && (
        <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <svg className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
          </svg>
          <div className="text-xs text-blue-700 dark:text-blue-300">
            <span className="font-medium">
              {launchingFix.kind === "resolve" ? "Launching conflict resolution…" : "Launching fix &amp; merge…"}
            </span>
            <span className="text-blue-600/80 dark:text-blue-400/80"> preparing worktree (rebasing onto {ws.baseBranch || "base"}), then starting the AI agent.</span>
          </div>
        </div>
      )}

      {isSelected && ws.status === "fixing" && (() => {
        const fixSession = sessions.find(s => s.triggerType === "fix-and-merge" && s.status === "running")
          ?? sessions.filter(s => s.triggerType === "fix-and-merge").at(-1);
        const conflictFiles = ws.conflicts?.conflictingFiles ?? [];
        const watchingLive = !!fixSession && activeSession === fixSession.id;
        const noOutputYet = watchingLive && messages.length === 0;
        return (
          <div className="mt-2 p-2 bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 rounded space-y-1.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-orange-700 dark:text-orange-400 animate-pulse">AI Fixing Conflicts</span>
              {ws.baseBranch && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                  target: {ws.baseBranch}
                </span>
              )}
              {watchingLive && (
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${wsState === "open" ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"}`}>
                  {wsState === "open" ? "● live" : wsState}
                </span>
              )}
            </div>
            {conflictFiles.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wide mb-0.5">
                  {conflictFiles.length} conflicting file{conflictFiles.length !== 1 ? "s" : ""}
                </div>
                <ul className="text-xs text-orange-700 dark:text-orange-300 space-y-0.5">
                  {conflictFiles.map(f => (
                    <li key={f} className="font-mono truncate">{f}</li>
                  ))}
                </ul>
              </div>
            )}
            {noOutputYet && (
              <div className="text-xs text-orange-600 dark:text-orange-400">
                Connected — waiting for the agent's first output. If nothing appears after a minute or two the session may be stuck; use Stop and retry.
              </div>
            )}
            <div className="flex items-center gap-3">
              {fixSession && !watchingLive && (
                <button
                  onClick={() => { setSelectedHistoryId(null); setActiveSession(fixSession.id); setViewMode("output"); }}
                  className="text-xs text-orange-700 dark:text-orange-300 hover:text-orange-900 dark:hover:text-orange-100 underline font-medium"
                >
                  Watch live output
                </button>
              )}
              {fixSession && (
                <button
                  onClick={() => handleViewHistory(fixSession.id)}
                  className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-800 dark:hover:text-orange-200 underline"
                >
                  View session log
                </button>
              )}
              <button
                onClick={() => handleStop(ws.id)}
                disabled={actionLoading}
                className="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 underline disabled:opacity-50 ml-auto"
              >
                Stop fix session
              </button>
            </div>
          </div>
        );
      })()}

      {isSelected && !launchingFix && ws.status === "idle" && (() => {
        const lastFixAndMerge = completedSessions.filter(s => s.triggerType === "fix-and-merge").at(-1);
        if (!lastFixAndMerge) return null;
        const succeeded = lastFixAndMerge.status === "completed";
        return (
          <div className={`mt-2 p-2 rounded border ${succeeded ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800" : "bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800"}`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2">
              <span className={`text-xs font-medium ${succeeded ? "text-green-700 dark:text-green-400" : "text-yellow-700 dark:text-yellow-400"}`}>
                {succeeded ? "Fix & Merge completed" : "Fix & Merge stopped"}
              </span>
              <button
                onClick={() => handleViewHistory(lastFixAndMerge.id)}
                className={`text-xs underline ${succeeded ? "text-green-600 dark:text-green-400 hover:text-green-800" : "text-yellow-600 dark:text-yellow-400 hover:text-yellow-800"}`}
              >
                View session output
              </button>
            </div>
            {succeeded && latestCommits[ws.id] && (
              <div className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 truncate" title={latestCommits[ws.id]!.message}>
                {latestCommits[ws.id]!.sha} {latestCommits[ws.id]!.message}
              </div>
            )}
          </div>
        );
      })()}

      {isSelected && (
        <div className="space-y-2 pt-2 border-t border-gray-200 dark:border-gray-700" onClick={(e) => e.stopPropagation()}>
          {(completedSessions.length > 0 || (isThisRunning && liveStats)) && (
            <ContextWindowView
              sessions={completedSessions}
              liveStats={isThisRunning ? liveStats : null}
            />
          )}
          {completedSessions.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Sessions</div>
              {(() => {
                const specialSessions = completedSessions.filter(s =>
                  s.triggerType && s.triggerType !== "agent" && s.triggerType !== "chat"
                  || (!s.triggerType && s.skillName)
                );
                if (specialSessions.length === 0) return null;
                const counts = new Map<string, { label: string; className: string; count: number; lastStatus: string }>();
                for (const s of specialSessions) {
                  const tl = getTriggerTypeLabel(s.triggerType, s.skillName) ?? { label: s.triggerType ?? "Skill", className: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" };
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
                const sessionBadge = SESSION_STATUS_COLORS[session.status] ?? "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400";
                const isActive = selectedHistoryId === session.id;
                const isContinuation = !!session.resumeFromId && completedSessions.some(s => s.id === session.resumeFromId);
                return (
                  <div key={session.id} className={`flex items-center gap-1 ${isContinuation ? "ml-3" : ""}`}>
                    {isContinuation && (
                      <span className="text-gray-300 dark:text-gray-600 shrink-0 select-none">↳</span>
                    )}
                    <button
                      data-session-id={session.id}
                      onClick={() => handleViewHistory(session.id)}
                      className={`flex-1 flex items-center gap-2 py-1 px-2 rounded text-left text-xs ${
                        isActive
                          ? "bg-blue-50 dark:bg-blue-950 text-blue-700 font-medium"
                          : "hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
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
                      <span className="text-xs text-gray-600 dark:text-gray-400">
                        {formatRelativeTime(session.startedAt)}
                      </span>
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-auto">
                        ({formatDuration(session.startedAt, session.endedAt)})
                      </span>
                      <SessionStatsBadge stats={session.stats} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const outputFormat = ws.provider
                          ? getOutputFormatForProvider(ws.provider)
                          : getOutputFormatForAgent(ws.agentCommand ?? prefs.agent_command);
                        const label = getTriggerTypeLabel(session.triggerType, session.skillName)?.label ?? "Agent";
                        setReplaySession({ id: session.id, label: `${label} · ${formatRelativeTime(session.startedAt)}`, outputFormat });
                      }}
                      className="text-[10px] text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors shrink-0"
                      title="Step through this session turn by turn"
                    >
                      ⏯ Replay
                    </button>
                    {ws.status !== "closed" && (
                      session.providerSessionId ? (
                        <div className="flex shrink-0">
                          <button
                            onClick={() => handleContinueFromSession(ws.id, session.id)}
                            disabled={actionLoading}
                            className="text-[10px] bg-green-600 text-white px-1.5 py-0.5 rounded-l hover:bg-green-700 disabled:opacity-50"
                            title="Continue this session with --resume"
                          >
                            Continue
                          </button>
                          <button
                            onClick={() => handleContinueFromSession(ws.id, session.id, true)}
                            disabled={actionLoading}
                            className="text-[10px] bg-green-700 text-white px-1 py-0.5 rounded-r hover:bg-green-800 disabled:opacity-50 border-l border-green-500"
                            title="Continue with --dangerously-skip-permissions (bypasses all permission prompts)"
                          >
                            ⚡
                          </button>
                        </div>
                      ) : (
                        <div className="flex shrink-0">
                          <button
                            onClick={() => handleRestart(ws.id)}
                            disabled={actionLoading}
                            className="text-[10px] bg-brand-600 text-white px-1.5 py-0.5 rounded-l hover:bg-brand-700 disabled:opacity-50"
                            title="Start a new session (previous session has no resume ID)"
                          >
                            Restart
                          </button>
                          <button
                            onClick={() => handleRestart(ws.id, true)}
                            disabled={actionLoading}
                            className="text-[10px] bg-brand-700 text-white px-1 py-0.5 rounded-r hover:bg-brand-800 disabled:opacity-50 border-l border-brand-500"
                            title="Restart with --dangerously-skip-permissions (bypasses all permission prompts)"
                          >
                            ⚡
                          </button>
                        </div>
                      )
                    )}
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {(() => {
            const lastCompleted = completedSessions[completedSessions.length - 1];
            if (!lastCompleted || lastCompleted.status !== "stopped") return null;
            return (
              <FailurePatternHint
                workspaceId={ws.id}
                sessionId={lastCompleted.id}
              />
            );
          })()}

          {!isRunning && (
            <WorkspaceQuickActions
              workspace={ws}
              completedSessions={completedSessions}
              availableSkills={availableSkills}
              expandedQuickActions={expandedQuickActions}
              setExpandedQuickActions={setExpandedQuickActions}
              actionLoading={actionLoading}
              onReview={handleReview}
              onMerge={handleMerge}
              onAutoBisect={handleAutoBisect}
              onExportHandoffBundle={handleExportHandoffBundle}
              onSkillQuickLaunch={handleSkillQuickLaunch}
            />
          )}

          {((selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) || ws.workingDir || true /* always show tab bar for Timeline */) && (
            <div className="flex border-b border-gray-200 dark:border-gray-700">
              {((selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) || ws.workingDir) && (
                <button
                  onClick={() => { setViewMode("output"); }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "output"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Output
                </button>
              )}
              {(selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) && (
                <button
                  onClick={() => {
                    setViewMode("summary");
                    const sid = selectedHistoryId || activeSession || lastSessionPerWorkspace[ws.id];
                    if (sid) handleFetchSummary(sid, isRunning);
                  }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "summary"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Summary
                </button>
              )}
              {ws.workingDir && (
                <button
                  onClick={() => { setViewMode("preview"); }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "preview"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Preview
                </button>
              )}
              {ws.workingDir && (
                <button
                  onClick={() => { setViewMode("artifacts"); }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "artifacts"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Artifacts{visualProofArtifacts.length > 0 ? ` (${visualProofArtifacts.length})` : ws.includeVisualProof ? " ·" : ""}
                </button>
              )}
              <button
                onClick={() => { setViewMode("diagnostics"); }}
                className={`flex-1 text-xs py-1.5 text-center font-medium ${
                  viewMode === "diagnostics"
                    ? "text-blue-700 border-b-2 border-blue-600"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                Diagnostics
              </button>
              <button
                onClick={() => { setViewMode("timeline"); }}
                className={`flex-1 text-xs py-1.5 text-center font-medium ${
                  viewMode === "timeline"
                    ? "text-blue-700 border-b-2 border-blue-600"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                Timeline
              </button>
              {ws.contextPrimer && (
                <button
                  onClick={() => { setViewMode("context"); }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "context"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Context
                </button>
              )}
            </div>
          )}

          {viewMode === "summary" && (
            <WorkspaceSummaryView
              selectedHistoryId={selectedHistoryId}
              activeSession={activeSession}
              lastSessionPerWorkspace={lastSessionPerWorkspace}
              wsId={ws.id}
              summarySessionId={summarySessionId}
              summaryData={summaryData}
              summaryLoading={summaryLoading}
            />
          )}

          {(viewMode === "output" || (isRunning && viewMode !== "preview" && viewMode !== "artifacts" && viewMode !== "diagnostics" && viewMode !== "context")) && (selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) ? (
            <TerminalView
              messages={selectedHistoryId ? historyMessages : (activeSession ? messages : completedMessages)}
              connectionState={selectedHistoryId ? "closed" : (activeSession ? wsState : "closed")}
              parseOutput={prefs.output_parser === "false" ? "false" : "minimal"}
              outputFormat={ws.provider ? getOutputFormatForProvider(ws.provider) : getOutputFormatForAgent(ws.agentCommand ?? prefs.agent_command)}
              prompt={selectedHistoryId ? undefined : lastPrompt}
              title={issue.title}
              multiTurn={isSessionAlive}
              sessionId={selectedHistoryId ?? activeSession ?? undefined}
              footer={isRunning && ws.status !== "closed" ? (
                  <div className="flex gap-2">
                    <TicketMentionInput
                      inputRef={textareaRef}
                      value={prompt}
                      onChange={setPrompt}
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
                      placeholder={isSessionAlive && !isWaitingForInput ? "Agent is working..." : "Message agent..."}
                      rows={2}
                      disabled={isSessionAlive && !isWaitingForInput}
                      className="flex-1 text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none disabled:bg-gray-50 dark:disabled:bg-gray-950 disabled:text-gray-400 dark:disabled:text-gray-500"
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
                        className="text-sm bg-brand-600 text-white px-3 py-1.5 rounded hover:bg-brand-700 disabled:opacity-50 self-end"
                      >
                        Send
                      </button>
                    )}
                  </div>
                ) : undefined}
              />
          ) : null}

          {viewMode === "preview" && ws.workingDir && (
            <WorkspacePreviewPanel preview={preview} branch={ws.branch} />
          )}

          {viewMode === "artifacts" && ws.workingDir && (
            <div className="space-y-3">
              {visualProofArtifacts.length > 0 && (
                <div className="border border-amber-200 dark:border-amber-800 rounded overflow-hidden">
                  <div className="px-3 py-1.5 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 text-[10px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                    Visual Proof ({visualProofArtifacts.length})
                  </div>
                  <div className="divide-y divide-amber-100 dark:divide-amber-900">
                    {visualProofArtifacts.map((a) => (
                      <div key={a.id} className="p-3 space-y-2">
                        {a.caption && (
                          <p className="text-xs text-gray-600 dark:text-gray-400 font-medium">{a.caption}</p>
                        )}
                        {a.type === "image" && (
                          <img
                            src={a.content}
                            alt={a.caption ?? "visual proof"}
                            className="max-w-full rounded border border-gray-200 dark:border-gray-700 cursor-pointer hover:opacity-90"
                            onClick={() => window.open(a.content, "_blank")}
                          />
                        )}
                        {a.type === "link" && (
                          <a href={a.content} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 underline break-all">{a.content}</a>
                        )}
                        {a.type === "text" && (
                          <pre className="text-[11px] font-mono text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">{a.content}</pre>
                        )}
                        {a.type === "video" && (
                          <video
                            src={a.content}
                            controls
                            className="max-h-80 w-full rounded border border-gray-200 dark:border-gray-700"
                          >
                            Your browser does not support the video tag.
                          </video>
                        )}
                        <p className="text-[10px] text-gray-400 dark:text-gray-500">{new Date(a.createdAt).toLocaleString("en-US")}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!visualProofLoading && visualProofArtifacts.length === 0 && ws.includeVisualProof && (
                <div className="text-xs text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded p-3 bg-amber-50 dark:bg-amber-900/20">
                  Visual proof requested — agent has not attached proof yet.
                </div>
              )}
              <WorkspaceArtifactsBrowser workspaceId={ws.id} />
            </div>
          )}

          {viewMode === "diagnostics" && (
            <WorkspaceDiagnosticsPanel workspace={ws} project={project} />
          )}

          {viewMode === "timeline" && (
            <WorkspaceTimelinePanel workspaceId={ws.id} />
          )}

          {viewMode === "context" && ws.contextPrimer && (
            <div className="border border-gray-200 dark:border-gray-700 rounded p-3 max-h-80 overflow-y-auto">
              <div className="prose prose-xs max-w-none text-xs leading-relaxed text-gray-700 dark:text-gray-300">
                <ReactMarkdown>{ws.contextPrimer}</ReactMarkdown>
              </div>
            </div>
          )}

          {!isRunning && viewMode === "output" && (
            <SessionStatsSummary
              stats={selectedHistoryId
                ? completedSessions.find(s => s.id === selectedHistoryId)?.stats ?? null
                : completedSessions.find(s => s.id === lastSessionPerWorkspace[ws.id])?.stats ?? null
              }
            />
          )}

          {/* Idle message input — available on ANY sub-view (output/diff/summary/...) so that
              following up on an idle or In-Review workspace is always possible, not only on the
              output tab. When there is no live session, the only meaningful action is to send
              (which resumes the prior conversation via /launch with resumeFromId), so the
              unreachable "Agent is working / Stop" branch is intentionally gone here. */}
          {!selectedHistoryId && !activeSession && ws.workingDir && ws.status !== "closed" && (
            <div className="flex gap-2">
              <TicketMentionInput
                inputRef={textareaRef}
                value={prompt}
                onChange={(val) => setPrompt(val)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.ctrlKey) {
                    e.preventDefault();
                    if (prompt.trim()) {
                      handleLaunch(ws.id);
                    }
                  }
                }}
                placeholder="Message agent..."
                rows={2}
                className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none disabled:bg-gray-50 dark:disabled:bg-gray-950 disabled:text-gray-400 dark:disabled:text-gray-500"
              />
              <button
                onClick={() => handleLaunch(ws.id)}
                disabled={actionLoading || !prompt.trim()}
                className="text-sm bg-brand-600 text-white px-3 py-1.5 rounded hover:bg-brand-700 disabled:opacity-50 self-end"
              >
                Send
              </button>
            </div>
          )}

          {ws.status !== "closed" && (
            <>
            {!ws.workingDir && (
              <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded px-2 py-1">
                Worktree directory unavailable -- some actions are disabled.
              </p>
            )}
            {/* Plan Approval Card */}
            {ws.pendingPlanPath && ws.workingDir && ws.status !== "closed" && !isRunning && (
              <WorkspacePlanApprovalCard
                wsId={ws.id}
                pendingPlanPath={ws.pendingPlanPath}
                planContent={planContent}
                planEditMode={planEditMode}
                planEditText={planEditText}
                rejectMode={rejectMode}
                rejectFeedback={rejectFeedback}
                actionLoading={actionLoading}
                setPlanEditText={setPlanEditText}
                setRejectFeedback={setRejectFeedback}
                setRejectMode={setRejectMode}
                setPlanEditMode={setPlanEditMode}
                handleRejectPlan={handleRejectPlan}
                handleImplementPlan={handleImplementPlan}
              />
            )}
            <div className="flex gap-2 flex-wrap items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/40 p-2">
              {ws.workingDir && canResume(ws, sessions) && (
                <div className="inline-flex">
                  <WorkspaceActionButton
                    intent="accent"
                    rounded="rounded-l-md"
                    onClick={() => handleResume(ws.id)}
                    disabled={actionLoading}
                  >
                    Resume
                  </WorkspaceActionButton>
                  <WorkspaceActionButton
                    intent="accent"
                    rounded="rounded-r-md"
                    className="px-2 border-l border-accent-700"
                    onClick={() => handleResume(ws.id, true)}
                    disabled={actionLoading}
                    title="Resume with --dangerously-skip-permissions (bypasses all permission prompts)"
                  >
                    ⚡
                  </WorkspaceActionButton>
                </div>
              )}
              {ws.workingDir && canRestart(ws, sessions) && (
                <div className="inline-flex">
                  <WorkspaceActionButton
                    intent="primary"
                    rounded="rounded-l-md"
                    onClick={() => handleRestart(ws.id)}
                    disabled={actionLoading}
                    title="Start a new session (previous session has no resume ID)"
                  >
                    Restart
                  </WorkspaceActionButton>
                  <WorkspaceActionButton
                    intent="primary"
                    rounded="rounded-r-md"
                    className="px-2 border-l border-brand-700"
                    onClick={() => handleRestart(ws.id, true)}
                    disabled={actionLoading}
                    title="Restart with --dangerously-skip-permissions (bypasses all permission prompts)"
                  >
                    ⚡
                  </WorkspaceActionButton>
                </div>
              )}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="primary"
                className="flex-1"
                onClick={() => handleViewDiff(ws.id)}
                disabled={actionLoading}
              >
                {ws.isDirect ? "View Changes" : "View Diff"}
              </WorkspaceActionButton>
              )}
              {ws.workingDir && selectedWorkspace === ws.id && diff && (() => {
                const unresolved = diffComments.filter((c) => c.resolvedAt == null).length;
                if (unresolved === 0) return null;
                return (
                  <span
                    data-testid="unresolved-comments-badge"
                    className="self-center text-xs font-medium px-2 py-1 rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
                    title="Unresolved diff comments — resolve them before merging"
                  >
                    {unresolved} unresolved
                  </span>
                );
              })()}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="primary"
                onClick={() => handleReview(ws.id)}
                disabled={actionLoading || isRunning}
                title="Trigger AI code review"
              >
                Review
              </WorkspaceActionButton>
              )}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="accent"
                className="flex-1"
                onClick={() => handleMerge(ws.id)}
                disabled={actionLoading}
              >
                {ws.isDirect ? "Close" : "Merge"}
              </WorkspaceActionButton>
              )}

              <span className="w-px bg-gray-300 dark:bg-gray-600 self-stretch mx-1" aria-hidden="true" />

              {!ws.isDirect && ws.workingDir && ws.status !== "closed" && !isRunning && (
                <WorkspaceActionButton
                  intent="neutral"
                  onClick={() => handleUpdateBase(ws.id, "rebase")}
                  disabled={actionLoading}
                  title="Rebase onto latest base branch"
                >
                  Update Base
                </WorkspaceActionButton>
              )}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="neutral"
                onClick={() => handleOpenTerminal(ws.id)}
                disabled={actionLoading}
                title="Open terminal in workspace directory"
              >
                Terminal
              </WorkspaceActionButton>
              )}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="neutral"
                onClick={() => handleOpenEditor(ws.id)}
                disabled={actionLoading}
                title="Open workspace directory in VS Code"
              >
                VS Code
              </WorkspaceActionButton>
              )}
              {ws.workingDir && preview.ok && (
                <div className="inline-flex">
                  <WorkspaceActionButton
                    intent="info"
                    rounded="rounded-l-md"
                    onClick={(event) => {
                      event.stopPropagation();
                      window.open(preview.url, "_blank", "noopener,noreferrer");
                    }}
                    disabled={actionLoading}
                    title={`Open dev preview at ${preview.url}`}
                  >
                    Preview
                  </WorkspaceActionButton>
                  <WorkspaceActionButton
                    intent="info"
                    rounded="rounded-r-md"
                    className="px-2 border-l border-sky-700"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyPreviewUrl(preview.url);
                    }}
                    disabled={actionLoading}
                    title={`Copy ${preview.url}`}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span className="sr-only">Copy preview URL</span>
                  </WorkspaceActionButton>
                </div>
              )}
              {ws.workingDir && !preview.ok && (
                <WorkspaceActionButton
                  intent="neutral"
                  disabled
                  title={preview.reason}
                >
                  Preview unavailable
                </WorkspaceActionButton>
              )}
              {ws.workingDir && !isRunning && (
              <WorkspaceActionButton
                intent="warn"
                onClick={() => handleAutoBisect(ws.id)}
                disabled={actionLoading}
                title="Find the commit that introduced the failing test"
              >
                Auto-bisect
              </WorkspaceActionButton>
              )}

              <span className="w-px bg-gray-300 dark:bg-gray-600 self-stretch mx-1" aria-hidden="true" />

              {!ws.isDirect && ws.status !== "closed" && !isRunning && (
                <WorkspaceActionButton
                  intent="ghost"
                  onClick={() => handleCloseWorkspace(ws.id)}
                  disabled={actionLoading}
                  title="Close without merging (e.g. already merged elsewhere or abandoned). Keeps session history."
                >
                  Close
                </WorkspaceActionButton>
              )}
              <WorkspaceActionButton
                intent="ghost"
                className="!text-red-600 dark:!text-red-400 hover:!bg-red-50 dark:hover:!bg-red-950 !border-red-300 dark:!border-red-800"
                onClick={() => handleDeleteWorkspace(ws.id)}
                disabled={actionLoading}
                title="Delete this workspace permanently"
              >
                Delete
              </WorkspaceActionButton>
            </div>
            {mergeError && mergeError.wsId === ws.id && (
              <div className="mt-2 p-2 bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 rounded">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-orange-700 dark:text-orange-400">Merge failed -- AI can fix and retry</span>
                  <button
                    onClick={() => handleFixAndMerge(ws.id, mergeError.message)}
                    disabled={actionLoading}
                    className="text-xs bg-orange-600 text-white px-2 py-1 rounded hover:bg-orange-700 disabled:opacity-50"
                  >
                    Fix &amp; Merge with AI
                  </button>
                </div>
                <p className="mt-1 text-xs text-orange-600 dark:text-orange-400 font-mono break-all">{mergeError.message}</p>
              </div>
            )}
            {conflictState && conflictState.hasConflicts && (
              <div className="mt-2 p-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-red-700 dark:text-red-400">
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
            <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-2">
              <div className="flex gap-2 flex-wrap items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/40 p-2">
                <WorkspaceActionButton
                  intent="info"
                  className="flex-1"
                  onClick={() => handleGenerateGithubDraft(ws.id)}
                  disabled={actionLoading}
                  title="Generate a local GitHub PR or release-note draft and save it as an issue artifact"
                >
                  Generate GitHub Draft
                </WorkspaceActionButton>
                <WorkspaceActionButton
                  intent="warn"
                  onClick={() => void handleExportHandoffBundle(ws.id)}
                  disabled={actionLoading}
                  title="Download a Markdown handoff bundle for this workspace"
                >
                  Export Handoff
                </WorkspaceActionButton>
                <WorkspaceActionButton
                  intent="danger"
                  onClick={() => handleDeleteWorkspace(ws.id)}
                  disabled={actionLoading}
                  title="Delete this workspace permanently"
                >
                  Delete
                </WorkspaceActionButton>
              </div>
              {githubDrafts[ws.id] && (
                <details className="text-xs">
                  <summary className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide cursor-pointer hover:text-gray-600 dark:hover:text-gray-300 flex items-center gap-2">
                    <span>GitHub Draft</span>
                    <button
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleCopyGithubDraft(githubDrafts[ws.id]!);
                      }}
                      className="ml-auto text-[10px] text-blue-600 hover:text-blue-700"
                    >
                      Copy
                    </button>
                  </summary>
                  <div className="mt-1 bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded p-2 max-h-56 overflow-y-auto">
                    <div className="prose prose-xs max-w-none text-[11px] leading-relaxed text-gray-700 dark:text-gray-300">
                      <ReactMarkdown>{githubDrafts[ws.id]!}</ReactMarkdown>
                    </div>
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
