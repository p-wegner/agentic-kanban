// Workspace action handlers extracted from WorkspacePanel (launch / resume /
// merge / review / conflict-resolution / lifecycle). Behaviour-preserving: the
// handler bodies are a verbatim move; the panel destructures them with the same
// names so its render + child props are unchanged. Deps (page state + setters)
// are threaded via the options object.
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, apiPost, apiPatch, apiDelete } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { buildQuickLaunchBody, buildDefaultLaunchPrompt } from "../lib/workspace-launch.js";
import { getSettings } from "../lib/settingsStore.js";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import type { AgentOutputMessage, IssueWithStatus, WorkspaceResponse, DiffResponse, DiffComment, SessionSummaryResponse } from "@agentic-kanban/shared";
import type { WorkspaceViewMode } from "./useWorkspaceSession.js";

/** React state setter that accepts either a value or a functional update —
 * structurally identical to `React.Dispatch<React.SetStateAction<T>>`, which is
 * exactly what the page passes for each of these deps. */
type Setter<T> = Dispatch<SetStateAction<T>>;

/** Conflict-resolution panel state shared with the diff endpoint shape. */
type ConflictState = { hasConflicts: boolean; conflictingFiles: string[] } | null;
/** Optimistic launch banner state for fix-and-merge / resolve-conflicts. */
type LaunchingFix = { wsId: string; kind: "fix-and-merge" | "resolve" } | null;
/** Inline merge-error banner state, keyed to the failing workspace. */
type MergeErrorState = { wsId: string; message: string } | null;
/** Per-workspace session listing — structurally mirrors the page's session rows. */
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

interface WorkspaceActionsDeps {
  issue: IssueWithStatus;
  selectedProfile: string;
  selectedModel: string;
  prefs: Record<string, string>;
  requiresReview: boolean;
  suggestion: string;
  isClaudeQuickLaunch: boolean;
  isCodexQuickLaunch: boolean;
  isRunning: boolean;
  prompt: string;
  activeSession: string | null;
  messages: AgentOutputMessage[];
  lastSessionPerWorkspace: Record<string, string>;
  disconnect: () => void;
  fetchWorkspaces: () => Promise<void> | void;
  onWorkspaceChange?: () => void;
  onWorkspaceCreating?: (issueId: string) => void;
  onWorkspaceCreateSettled?: (issueId: string) => void;
  setActionLoading: Setter<boolean>;
  setActiveSession: Setter<string | null>;
  setCompletedMessages: Setter<AgentOutputMessage[]>;
  setConflictState: Setter<ConflictState>;
  setDiff: Setter<DiffResponse | null>;
  setDiffComments: Setter<DiffComment[]>;
  setEditingProfileWsId: Setter<string | null>;
  setError: Setter<string | null>;
  setHistoryMessages: Setter<AgentOutputMessage[]>;
  setLastPrompt: Setter<string>;
  setLastSessionPerWorkspace: Setter<Record<string, string>>;
  setLaunchingFix: Setter<LaunchingFix>;
  setMergeError: Setter<MergeErrorState>;
  setMonitorRunning: Setter<boolean>;
  setPlanEditMode: Setter<Record<string, boolean>>;
  setPlanEditText: Setter<Record<string, string>>;
  setPrompt: Setter<string>;
  setQuickDropdownOpen: Setter<boolean>;
  setRejectFeedback: Setter<Record<string, string>>;
  setRejectMode: Setter<Record<string, boolean>>;
  setSelectedHistoryId: Setter<string | null>;
  setSelectedWorkspace: Setter<string | null>;
  setShowCreate: Setter<boolean>;
  setViewMode: Setter<WorkspaceViewMode>;
  setWorkspaceSessions: Setter<Record<string, SessionInfo[]>>;
}

export function useWorkspaceActions(deps: WorkspaceActionsDeps) {
  const {
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
  } = deps;
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
        setLastPrompt(buildDefaultLaunchPrompt(issue));
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
        setLastPrompt(buildDefaultLaunchPrompt(issue));
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
        setLastSessionPerWorkspace((prev: Record<string, string>) => ({ ...prev, [wsId]: activeSession }));
        setCompletedMessages(messages);
      }
      setActiveSession(null);
      await fetchWorkspaces();
      setWorkspaceSessions((prev: Record<string, SessionInfo[]>) => {
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
      setPlanEditMode((prev: Record<string, boolean>) => ({ ...prev, [wsId]: false }));
      setPlanEditText((prev: Record<string, string>) => ({ ...prev, [wsId]: "" }));
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
      setRejectMode((prev: Record<string, boolean>) => ({ ...prev, [wsId]: false }));
      setRejectFeedback((prev: Record<string, string>) => ({ ...prev, [wsId]: "" }));
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

  return {
    handleQuickLaunch, handleSkillQuickLaunch, handleLaunch, handleChangeProfile,
    handleSendTurn, handleStop, handleViewDiff, handleMerge, handleFixAndMerge,
    handleOpenTerminal, handleOpenEditor, copyPreviewUrl, handleUpdateBase,
    handleMonitorRunNow, handleAbortRebase, handleResolveConflicts, handleResume,
    handleRestart, handleContinueFromSession, handleAutoBisect, handleReview,
    handleImplementPlan, handleRejectPlan, handleDeleteWorkspace, handleCloseWorkspace,
  };
}
