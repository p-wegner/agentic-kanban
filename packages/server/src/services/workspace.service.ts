import { randomUUID } from "node:crypto";
import { issues, projects, preferences, workspaces, sessions, sessionMessages, diffComments, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import type { ProviderName } from "./agent-provider.js";
import * as gitService from "./git.service.js";
import { runSetupScript } from "./setup-script.js";
import { writeAgentSkillFile, readLocalSkillPrompt } from "@agentic-kanban/shared/lib/agent-skill-files";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { moveIssueToInProgress, resolveProjectRepo, resolveProjectId, resolveProjectFull, moveIssueToDone, getWorkspaceById, updateWorkspaceStatus } from "../repositories/workspace.repository.js";
import { killProcessesInDir } from "./process-cleanup.js";
import { runScript } from "./script-runner.js";
import { parseDiffStats } from "./board-aggregation.service.js";
import { getConflictingFiles, buildConflictResolutionPrompt, buildFixAndMergePrompt, runLearningStep } from "./merge-helpers.service.js";
import { buildImplementPrompt } from "./plan-mode.service.js";
import { PREF_AUTO_START_FOLLOWUP } from "../constants/preference-keys.js";
import { autoStartFollowups } from "./followup-workspace.service.js";
import { loadAgentSettings } from "./agent-settings.service.js";
import type { AgentSettings } from "./agent-settings.service.js";
import { getDiffComments } from "../repositories/session.repository.js";

// --- Error types for service-to-route communication ---

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST",
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// --- Shared helpers ---

function applyWorkspaceAgentSelection(settings: AgentSettings, workspace: typeof workspaces.$inferSelect): AgentSettings {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot") return settings;

  const profileName = workspace.claudeProfile || undefined;
  const agentArgs = provider === "claude"
    ? settings.agentArgs
    : settings.agentArgs
      ?.split(/\s+/)
      .filter((arg) => arg && arg !== "--dangerously-skip-permissions")
      .join(" ") || undefined;
  return {
    ...settings,
    agentArgs,
    provider,
    claudeProfile: provider === "claude" ? profileName : undefined,
    profile: profileName ? { provider: provider as ProviderName, name: profileName } : undefined,
  };
}

function requireBaseBranch(baseBranch: string | null | undefined): string {
  if (!baseBranch) {
    throw new WorkspaceError(
      "No default branch configured for this project. Set a default branch in project settings or choose a base branch.",
      "BAD_REQUEST",
    );
  }
  return baseBranch;
}

// --- Input / Output types ---

export interface CreateWorkspaceInput {
  issueId: string;
  branch?: string;
  isDirect?: boolean;
  baseBranch?: string;
  requiresReview?: boolean;
  thoroughReview?: boolean;
  planMode?: boolean;
  includeVisualProof?: boolean;
  skipSetup?: boolean;
  customPrompt?: string;
  skillId?: string;
  profile?: { provider?: string; name?: string };
  claudeProfile?: string;
}

export interface CreateWorkspaceResult {
  id: string;
  issueId: string;
  branch: string;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  status: string;
  provider: ProviderName;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

// --- Service factory ---

export function createWorkspaceService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
}) {
  const { database, getSessionManager, boardEvents } = deps;

  async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    const isDirect = input.isDirect === true;
    const requiresReview = input.requiresReview === true;
    const thoroughReview = input.thoroughReview === true;
    const planMode = input.planMode === true;
    const includeVisualProof = input.includeVisualProof === true;
    const now = new Date().toISOString();
    const id = randomUUID();
    let sessionId: string | undefined;
    let worktreePath: string | null = null;
    let baseBranch: string | null = null;
    let baseCommitSha: string | null = null;
    let branch: string = input.branch ?? "";
    let claudeProfile: string | undefined;
    let agentCommand: string | undefined;
    let resolvedProvider: ProviderName = "claude";

    try {
      // Resolve issue → project
      const issueRows = await database
        .select({ projectId: issues.projectId, title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .limit(1);

      if (issueRows.length === 0) {
        throw new WorkspaceError("Issue not found", "NOT_FOUND");
      }

      const issue = issueRows[0];

      const projectRows = await database
        .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1);

      if (projectRows.length === 0) {
        throw new WorkspaceError("Project not found", "NOT_FOUND");
      }

      const project = projectRows[0];

      // Fetch setup script config
      const setupConfigRows = await database
        .select({ setupScript: projects.setupScript, setupBlocking: projects.setupBlocking, setupEnabled: projects.setupEnabled })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1);
      const setupScript = setupConfigRows[0]?.setupScript;
      const setupBlocking = setupConfigRows[0]?.setupBlocking ?? true;
      const setupEnabled = setupConfigRows[0]?.setupEnabled ?? true;

      if (isDirect) {
        branch = await gitService.getCurrentBranch(project.repoPath);
        worktreePath = project.repoPath;
        baseBranch = null;
        baseCommitSha = await gitService.getHeadCommitSha(project.repoPath);
      } else {
        baseBranch = input.baseBranch || project.defaultBranch;
        if (!baseBranch) {
          throw new WorkspaceError(
            "No default branch configured for this project. Set a default branch in project settings or choose a base branch.",
            "BAD_REQUEST",
          );
        }
        worktreePath = await gitService.createWorktree(project.repoPath, branch, baseBranch ?? undefined);
      }

      // Run setup script for isolated git worktrees only
      if (!isDirect && setupScript && worktreePath && setupEnabled && !input.skipSetup) {
        if (setupBlocking) {
          try {
            const result = await runSetupScript(worktreePath, setupScript);
            if (result.exitCode === 0) {
              console.log(`[workspaces] setup complete: workspaceId=${id}`);
            } else {
              console.warn(`[workspaces] setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
            }
          } catch (err) {
            console.warn(`[workspaces] setup error: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          runSetupScript(worktreePath, setupScript).then(result => {
            if (result.exitCode === 0) {
              console.log(`[workspaces] parallel setup complete: workspaceId=${id}`);
            } else {
              console.warn(`[workspaces] parallel setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
            }
          }).catch(err => {
            console.warn(`[workspaces] parallel setup error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

      // Build agent prompt
      let agentPrompt: string;
      if (input.customPrompt) {
        agentPrompt = input.customPrompt;
      } else {
        agentPrompt = issue.title;
        if (issue.description) {
          agentPrompt += `\n\n${issue.description}`;
        }
      }
      if (includeVisualProof) {
        const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
        agentPrompt += `\n\nAfter completing the implementation, attach visual proof to this ticket. Use the playwright-cli skill to open the running app, take a screenshot of the working result, and post it as an artifact:\nPOST http://localhost:${serverPort}/api/issues/${input.issueId}/artifacts\nBody: { "type": "image", "mimeType": "image/png", "content": "<base64 data URL>", "caption": "Screenshot of the working result" }`;
      }

      // Write skill file for progressive disclosure
      const skillId: string | null = input.skillId || null;
      let skillName: string | null = null;
      if (skillId && worktreePath) {
        const skillRows = await database.select().from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
        if (skillRows.length > 0) {
          const skill = skillRows[0];
          skillName = skill.name;
          const localPrompt = await readLocalSkillPrompt(project.repoPath, skill.name);
          const effectiveSkill = localPrompt ? { ...skill, prompt: localPrompt } : skill;
          await writeAgentSkillFile(worktreePath, effectiveSkill);
        }
      }

      // Resolve agent settings from preferences + body overrides
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      const profileOverride = input.profile;
      const legacyProfileOverride = input.claudeProfile;
      if (profileOverride?.name) {
        if (profileOverride.provider === "codex") {
          prefMap.set("codex_profile", profileOverride.name);
          prefMap.set("provider", "codex");
        } else if (profileOverride.provider === "copilot") {
          prefMap.set("copilot_profile", profileOverride.name);
          prefMap.set("provider", "copilot");
        } else {
          prefMap.set("claude_profile", profileOverride.name);
          prefMap.set("provider", "claude");
        }
      } else if (legacyProfileOverride) {
        prefMap.set("claude_profile", legacyProfileOverride);
        prefMap.set("provider", "claude");
      }

      const { agentCommand: resolvedCommand, agentArgs, claudeProfile: resolvedProfile, profile: resolvedProfileSelection, provider, permissionPromptTool } = resolveAgentSettings(prefMap);
      resolvedProvider = provider;
      agentCommand = resolvedCommand;
      claudeProfile = resolvedProfileSelection?.name || legacyProfileOverride || prefMap.get("claude_profile") || undefined;

      // Insert workspace DB record
      await database.insert(workspaces).values({
        id,
        issueId: input.issueId,
        branch,
        workingDir: worktreePath,
        baseBranch,
        isDirect,
        baseCommitSha,
        requiresReview,
        thoroughReview,
        planMode,
        includeVisualProof,
        skillId,
        status: "active",
        claudeProfile: claudeProfile ?? null,
        agentCommand: agentCommand ?? null,
        provider: resolvedProvider,
        createdAt: now,
        updatedAt: now,
      });

      // Auto-move issue to "In Progress"
      await moveIssueToInProgress(input.issueId, issue.projectId, now, database);

      // Auto-launch agent
      if (getSessionManager) {
        const truncatedPrompt = agentPrompt.length > 80 ? agentPrompt.slice(0, 80) + "..." : agentPrompt;
        console.log(`[workspaces] auto-launch: workspaceId=${id} branch=${branch} isDirect=${isDirect} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"}`);
        const executorProvider = toExecutorProvider(resolvedProvider);
        sessionId = await getSessionManager().startSession({
          workspaceId: id,
          prompt: agentPrompt,
          agentCommand,
          agentArgs,
          claudeProfile: resolvedProfile,
          permissionPromptTool,
          planMode,
          provider: executorProvider,
          triggerType: skillName ? `skill:${skillName}` : "agent",
          profile: resolvedProfileSelection,
        });
      }

      // Broadcast board event
      boardEvents?.broadcast(issue.projectId, "workspace_created");

      return {
        id,
        issueId: input.issueId,
        branch,
        workingDir: worktreePath,
        baseBranch,
        isDirect,
        planMode,
        includeVisualProof,
        status: "active",
        provider: resolvedProvider,
        sessionId,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Re-throw domain errors (NOT_FOUND, BAD_REQUEST) — these are intentional
      if (err instanceof WorkspaceError) throw err;

      // Unexpected errors: still save workspace record with error info
      console.error(`[workspaces] create failed: ${errorMsg}`);

      try {
        await database.insert(workspaces).values({
          id,
          issueId: input.issueId,
          branch,
          workingDir: worktreePath,
          baseBranch,
          isDirect,
          baseCommitSha,
          requiresReview,
          thoroughReview,
          planMode,
          includeVisualProof,
          status: "active",
          claudeProfile: claudeProfile ?? null,
          agentCommand: agentCommand ?? null,
          provider: resolvedProvider,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        // DB insert may fail if worktree creation itself failed
      }

      return {
        id,
        issueId: input.issueId,
        branch,
        workingDir: worktreePath,
        baseBranch,
        isDirect,
        planMode,
        includeVisualProof,
        status: "active",
        provider: resolvedProvider,
        createdAt: now,
        updatedAt: now,
        error: errorMsg,
      };
    }
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    // Get session IDs for this workspace
    const wsSessions = await database
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));

    // Kill any running agents before deleting
    if (getSessionManager && wsSessions.some(s => s.status === "running")) {
      for (const s of wsSessions) {
        if (s.status === "running") {
          await getSessionManager().stopSession(s.id).catch(() => {});
        }
      }
    }

    // Get workspace data for worktree cleanup before deleting
    const wsRow = await database
      .select({ workingDir: workspaces.workingDir, isDirect: workspaces.isDirect, repoPath: projects.repoPath })
      .from(workspaces)
      .leftJoin(issues, eq(workspaces.issueId, issues.id))
      .leftJoin(projects, eq(issues.projectId, projects.id))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const workingDir = wsRow[0]?.workingDir;
    const isDirect = wsRow[0]?.isDirect;
    const repoPath = wsRow[0]?.repoPath;

    // Cascade delete: diff comments → session messages → sessions → workspace
    await database.delete(diffComments).where(eq(diffComments.workspaceId, workspaceId));
    if (wsSessions.length > 0) {
      const sessionIds = wsSessions.map(s => s.id);
      await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    }
    await database.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));

    // Remove the worktree directory (non-direct workspaces only)
    if (workingDir && !isDirect && repoPath) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(workingDir, { recursive: true, force: true });
        await gitService.pruneWorktrees(repoPath).catch(() => {});
      } catch {
        // Best-effort — don't fail if worktree cleanup fails
      }
    }
  }

  async function markReadyForMerge(workspaceId: string): Promise<{ id: string; readyForMerge: boolean }> {
    const wsRows = await database
      .select({ issueId: workspaces.issueId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (wsRows.length === 0) {
      throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    }

    const now = new Date().toISOString();
    await database.update(workspaces).set({ readyForMerge: true, updatedAt: now }).where(eq(workspaces.id, workspaceId));

    if (boardEvents) {
      const issueRows = await database
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, wsRows[0].issueId))
        .limit(1);
      if (issueRows.length > 0) {
        boardEvents.broadcast(issueRows[0].projectId, "workspace_ready_for_merge");
      }
    }

    return { id: workspaceId, readyForMerge: true };
  }

  async function setupWorkspace(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    if (workspace.workingDir) {
      return { id, workingDir: workspace.workingDir };
    }

    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    console.log(`[workspace-service] setup: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath} baseBranch=${baseBranch}`);

    const worktreePath = await gitService.createWorktree(repoPath, workspace.branch, baseBranch);
    console.log(`[workspace-service] setup complete: workspaceId=${id} worktreePath=${worktreePath}`);

    const now = new Date().toISOString();
    await database
      .update(workspaces)
      .set({ workingDir: worktreePath, baseBranch, updatedAt: now })
      .where(eq(workspaces.id, id));

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_setup");

    return { id, workingDir: worktreePath };
  }

  async function getWorkspaceDiff(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir && !workspace.branch) {
      throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    }

    let diff = "";
    let conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null = null;
    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    if (workspace.isDirect) {
      diff = workspace.workingDir
        ? await gitService.getWorkingTreeDiff(workspace.workingDir)
        : "";
    } else {
      let usedWorktree = false;
      if (workspace.workingDir) {
        try {
          diff = await gitService.getDiff(workspace.workingDir, baseBranch);
          conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
          usedWorktree = true;
        } catch {
          // Worktree directory exists but is not a valid git repo — fall through
        }
      }
      if (!usedWorktree) {
        if (workspace.branch) {
          diff = await gitService.getDiffFromRepo(repoPath, workspace.branch, baseBranch);
        } else {
          diff = "";
        }
      }
    }

    const stats = parseDiffStats(diff);
    const comments = await getDiffComments(id, undefined, database);
    console.log(`[workspace-service] diff: workspaceId=${id} isDirect=${workspace.isDirect} files=${stats.filesChanged} +${stats.insertions} -${stats.deletions} conflicts=${conflicts?.hasConflicts ?? "n/a"} comments=${comments.length}`);
    return { diff, stats, comments, conflicts };
  }

  async function mergeWorkspace(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    const { project, repoPath, defaultBranch } = await resolveProjectFull(id, database);

    // Pre-merge cleanup: kill processes and run teardown script
    if (workspace.workingDir && !workspace.isDirect) {
      try {
        const killed = await killProcessesInDir(workspace.workingDir);
        if (killed > 0) console.log(`[workspace-service] killed ${killed} process(es) in ${workspace.workingDir}`);
      } catch { /* ignore */ }
      if (project?.teardownScript && project.setupEnabled !== false) {
        try {
          const r = await runScript(project.teardownScript, workspace.workingDir, `teardown:${id}`);
          console.log(`[workspace-service] teardown script: ${r.ok ? "ok" : "failed"} — ${r.output.slice(0, 100)}`);
        } catch { /* ignore */ }
      }
    }

    // Direct workspace: no merge needed, just close
    if (workspace.isDirect) {
      const now = new Date().toISOString();
      await updateWorkspaceStatus(id, "closed", { closedAt: now }, database);
      await moveIssueToDone(id, workspace.issueId, now, database, true);

      const projectId = await resolveProjectId(id, database);
      if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

      return { id, mergeOutput: "Direct workspace closed (no merge needed)" };
    }

    // Load preferences for learning step + auto-start checks
    const prefRows = await database.select().from(preferences);
    const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

    // Optional learning step
    if (workspace.workingDir && getSessionManager) {
      await runLearningStep(id, prefMap, database, getSessionManager!);
    }

    // Check for merge conflicts
    if (workspace.workingDir) {
      const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
      const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
      if (conflicts.hasConflicts) {
        throw new WorkspaceError(
          "Merge conflicts detected",
          "BAD_REQUEST",
          { conflictingFiles: conflicts.conflictingFiles },
        );
      }
    }

    console.log(`[workspace-service] merge: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath}`);

    // Sync branch ref to HEAD before merging
    if (workspace.workingDir) {
      const synced = await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
      if (synced) {
        console.log(`[workspace-service] synced branch ${workspace.branch} to worktree HEAD`);
      }
    }

    const result = await gitService.mergeBranch(repoPath, workspace.branch);

    // Cleanup worktree
    if (workspace.workingDir) {
      try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* best effort */ }
    }

    // Delete merged branch
    try {
      await gitService.deleteBranch(repoPath, workspace.branch);
      console.log(`[workspace-service] deleted branch ${workspace.branch}`);
    } catch { /* ignore */ }

    const now = new Date().toISOString();
    await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now }, database);
    await moveIssueToDone(id, workspace.issueId, now, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

    // Auto-start follow-up issues
    try {
      if (prefMap.get(PREF_AUTO_START_FOLLOWUP) === "true" && projectId) {
        await autoStartFollowups(workspace.issueId, projectId, database, getSessionManager!, prefMap, { boardEvents });
      }
    } catch (err) {
      console.warn("[workspace-service] auto_start_followup check failed:", err);
    }

    return { id, mergeOutput: result };
  }

  async function getConflicts(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir || workspace.isDirect) {
      return { hasConflicts: false, conflictingFiles: [] };
    }

    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    return gitService.detectConflicts(workspace.workingDir, baseBranch);
  }

  async function updateBase(id: string, mode: "rebase" | "merge") {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir || workspace.isDirect) {
      throw new WorkspaceError("Not supported for direct workspaces", "BAD_REQUEST");
    }
    if (workspace.status === "closed") {
      throw new WorkspaceError("Workspace is closed", "BAD_REQUEST");
    }

    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    let result: { success: boolean; conflictingFiles?: string[]; error?: string };
    if (mode === "merge") {
      result = await gitService.mergeBaseIntoBranch(workspace.workingDir, baseBranch);
    } else {
      result = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch);
    }

    console.log(`[workspace-service] update-base: workspaceId=${id} mode=${mode} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "board_changed");

    return result;
  }

  async function abortRebase(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) {
      throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    }

    await gitService.abortRebase(workspace.workingDir);
    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "board_changed");
    return { ok: true };
  }

  async function resolveConflicts(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    if (workspace.status === "fixing") throw new WorkspaceError("Conflict resolution already in progress", "BAD_REQUEST");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const conflictingFiles = await getConflictingFiles(workspace.workingDir);
    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    const prompt = buildConflictResolutionPrompt(conflictingFiles, baseBranch);

    const { agentCommand, agentArgs, claudeProfile, profile, provider } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database), workspace);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile,
      provider: toExecutorProvider(provider), multiTurn: true, triggerType: "fix-conflicts",
    });

    await updateWorkspaceStatus(id, "fixing", {}, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  async function fixAndMerge(id: string, mergeError?: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    if (workspace.status === "fixing") throw new WorkspaceError("Fix already in progress", "BAD_REQUEST");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const errorMessage = mergeError || "Unknown merge error";
    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    const prompt = buildFixAndMergePrompt(errorMessage, baseBranch);

    const { agentCommand, agentArgs, claudeProfile, profile, provider } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database), workspace);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile,
      provider: toExecutorProvider(provider), multiTurn: true, triggerType: "fix-and-merge",
    });

    await updateWorkspaceStatus(id, "fixing", {}, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  async function getLatestCommit(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) return { sha: null, message: null };
    const commit = await gitService.getLatestCommit(workspace.workingDir);
    return commit ?? { sha: null, message: null };
  }

  return {
    createWorkspace,
    deleteWorkspace,
    markReadyForMerge,
    setupWorkspace,
    getWorkspaceDiff,
    mergeWorkspace,
    getConflicts,
    updateBase,
    abortRebase,
    resolveConflicts,
    fixAndMerge,
    getLatestCommit,
  };
}
