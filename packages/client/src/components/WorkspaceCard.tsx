import React from "react";
import ReactMarkdown from "react-markdown";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { getWorkspacePreviewUrl } from "../lib/workspace-preview.js";
import { getOutputFormatForAgent, getOutputFormatForProvider } from "../lib/agent-output-parser.js";
import { TerminalView } from "./TerminalView.js";
import { WorkspacePreviewPanel } from "./WorkspacePreviewPanel.js";
import { WorkspaceDiagnosticsPanel } from "./WorkspaceDiagnosticsPanel.js";
import { WorkspaceTimelinePanel } from "./WorkspaceTimelinePanel.js";
import { FailurePatternHint } from "./FailurePatternHint.js";
import TicketMentionInput from "./TicketMentionInput.js";
import { SetupStatusPanel } from "./SetupStatusPanel.js";
import { ServiceStackStatusPanel } from "./ServiceStackStatusPanel.js";
import { WorkspaceScorecardPanel } from "./WorkspaceScorecardPanel.js";
import { WorkspaceViewTabs } from "./WorkspaceViewTabs.js";
import { WorkspaceClosedActions } from "./WorkspaceClosedActions.js";
import { WorkspaceFixingStatus } from "./WorkspaceFixingStatus.js";
import { WorkspaceArtifactsView } from "./WorkspaceArtifactsView.js";
import { WorkspaceSessionList } from "./WorkspaceSessionList.js";
import { WorkspaceActionBar } from "./WorkspaceActionBar.js";
import { WorkspacePlanApprovalCard } from "./WorkspacePlanApprovalCard.js";
import { WorkspaceSummaryView } from "./WorkspaceSummaryView.js";
import {
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  STATUS_COLORS,
  getTriggerTypeLabel,
  humanizeSkillName,
  profileOptionValue,
  providerLabel,
  type ProfileOption,
} from "../lib/workspace-helpers.js";
import { SessionStatsSummary } from "../lib/session-stats.js";
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
  handleResetWorkspaceToIdle: (wsId: string) => void;
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
  handleResetWorkspaceToIdle,
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

      <ServiceStackStatusPanel serviceState={ws.serviceState ?? null} />

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
        <WorkspaceScorecardPanel
          wsId={ws.id}
          scorecard={scorecard}
          expandedScorecards={expandedScorecards}
          setExpandedScorecards={setExpandedScorecards}
        />
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

      {isSelected && ws.status === "fixing" && (
        <WorkspaceFixingStatus
          ws={ws}
          sessions={sessions}
          activeSession={activeSession}
          messages={messages}
          wsState={wsState}
          actionLoading={actionLoading}
          setSelectedHistoryId={setSelectedHistoryId}
          setActiveSession={setActiveSession}
          setViewMode={setViewMode}
          handleViewHistory={handleViewHistory}
          handleStop={handleStop}
        />
      )}

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
            <WorkspaceSessionList
              ws={ws}
              completedSessions={completedSessions}
              selectedHistoryId={selectedHistoryId}
              actionLoading={actionLoading}
              prefs={prefs}
              handleViewHistory={handleViewHistory}
              setReplaySession={setReplaySession}
              handleContinueFromSession={handleContinueFromSession}
              handleRestart={handleRestart}
            />
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

          {!isRunning && ws.status !== "blocked" && (
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

          {/* always render the tab bar (Timeline included) */ (
            <WorkspaceViewTabs
              ws={ws}
              viewMode={viewMode}
              setViewMode={setViewMode}
              selectedHistoryId={selectedHistoryId}
              historyMessages={historyMessages}
              activeSession={activeSession}
              completedMessages={completedMessages}
              lastSessionPerWorkspace={lastSessionPerWorkspace}
              isRunning={isRunning}
              visualProofArtifacts={visualProofArtifacts}
              handleFetchSummary={handleFetchSummary}
            />
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
            <WorkspaceArtifactsView
              wsId={ws.id}
              includeVisualProof={ws.includeVisualProof}
              visualProofArtifacts={visualProofArtifacts}
              visualProofLoading={visualProofLoading}
            />
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
            <WorkspaceActionBar
              ws={ws}
              sessions={sessions}
              selectedWorkspace={selectedWorkspace}
              isRunning={isRunning}
              actionLoading={actionLoading}
              diff={diff}
              diffComments={diffComments}
              canResume={canResume}
              canRestart={canRestart}
              handleResume={handleResume}
              handleRestart={handleRestart}
              handleViewDiff={handleViewDiff}
              handleReview={handleReview}
              handleMerge={handleMerge}
              handleUpdateBase={handleUpdateBase}
              handleResetWorkspaceToIdle={handleResetWorkspaceToIdle}
              handleOpenTerminal={handleOpenTerminal}
              handleOpenEditor={handleOpenEditor}
              copyPreviewUrl={copyPreviewUrl}
              handleAutoBisect={handleAutoBisect}
              handleCloseWorkspace={handleCloseWorkspace}
              handleDeleteWorkspace={handleDeleteWorkspace}
            />
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
            <WorkspaceClosedActions
              wsId={ws.id}
              actionLoading={actionLoading}
              githubDrafts={githubDrafts}
              handleGenerateGithubDraft={handleGenerateGithubDraft}
              handleExportHandoffBundle={handleExportHandoffBundle}
              handleDeleteWorkspace={handleDeleteWorkspace}
              handleCopyGithubDraft={handleCopyGithubDraft}
            />
          )}
        </div>
      )}
    </div>
  );
}
