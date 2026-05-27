import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { issues, projects, preferences, workspaces, sessions, sessionMessages, diffComments, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import type { ProviderName } from "./agent-provider.js";
import * as gitService from "./git.service.js";
import { createBackup } from "../db/backup.js";
import { runSetupScript } from "./setup-script.js";
import { writeAgentSkillFile, readLocalSkillPrompt, copySkillToWorktree } from "@agentic-kanban/shared/lib/agent-skill-files";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { moveIssueToInProgress, resolveProjectRepo, resolveProjectId, resolveProjectFull, moveIssueToDone, getWorkspaceById, updateWorkspaceStatus, getWorkspaceDetails } from "../repositories/workspace.repository.js";
import { killProcessesInDir } from "./process-cleanup.js";
import { runScript } from "./script-runner.js";
import { parseDiffStats } from "./board-aggregation.service.js";
import { getConflictingFiles, buildConflictResolutionPrompt, buildFixAndMergePrompt, runLearningStep } from "./merge-helpers.service.js";
import { buildImplementPrompt } from "./plan-mode.service.js";
import { PREF_AUTO_START_FOLLOWUP } from "../constants/preference-keys.js";
import { autoStartFollowups } from "./followup-workspace.service.js";
import { loadAgentSettings } from "./agent-settings.service.js";
import type { AgentSettings } from "./agent-settings.service.js";
import { getDiffComments, createDiffComment as createDiffCommentRepo, updateDiffComment as updateDiffCommentRepo, findDiffComment, deleteDiffComment, findResumableSession, getWorkspaceSessions, getWorkspaceSkillName } from "../repositories/session.repository.js";

// --- Error types for service-to-route communication ---

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
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

// --- Turn result type ---

export type TurnResult =
  | { type: "sent" }
  | { type: "resumed"; sessionId: string };

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
  /** Name of a disk-only skill (no DB entry) — used when id starts with "disk:" */
  skillName?: string;
  profile?: { provider?: string; name?: string };
  claudeProfile?: string;
  /** Claude model tier (e.g. "opus"). Falls back to the default_model preference when omitted. */
  model?: string;
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

// --- Merge serialization: one active merge per repo at a time ---

const activeMerges = new Map<string, Promise<unknown>>();

// --- Service factory ---

export function createWorkspaceService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
}) {
  const { database, getSessionManager, boardEvents } = deps;

  // --- createWorkspace helpers ---

  async function resolveIssueAndProject(issueId: string): Promise<{
    issue: { projectId: string; title: string; description: string | null };
    project: { repoPath: string; defaultBranch: string | null };
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean };
  }> {
    const issueRows = await database
      .select({ projectId: issues.projectId, title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);

    if (issueRows.length === 0) {
      throw new WorkspaceError("Issue not found", "NOT_FOUND");
    }

    const issue = issueRows[0];

    const projectRows = await database
      .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch, setupScript: projects.setupScript, setupBlocking: projects.setupBlocking, setupEnabled: projects.setupEnabled })
      .from(projects)
      .where(eq(projects.id, issue.projectId))
      .limit(1);

    if (projectRows.length === 0) {
      throw new WorkspaceError("Project not found", "NOT_FOUND");
    }

    const projectRow = projectRows[0];
    return {
      issue,
      project: { repoPath: projectRow.repoPath, defaultBranch: projectRow.defaultBranch },
      setupConfig: {
        setupScript: projectRow.setupScript ?? null,
        setupBlocking: projectRow.setupBlocking ?? true,
        setupEnabled: projectRow.setupEnabled ?? true,
      },
    };
  }

  async function setupWorktree(
    isDirect: boolean,
    repoPath: string,
    defaultBranch: string | null,
    input: Pick<CreateWorkspaceInput, "branch" | "baseBranch" | "skipSetup">,
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean },
    workspaceId: string,
  ): Promise<{ branch: string; worktreePath: string; baseBranch: string | null; baseCommitSha: string | null }> {
    let branch: string;
    let worktreePath: string;
    let baseBranch: string | null;
    let baseCommitSha: string | null;

    if (isDirect) {
      branch = await gitService.getCurrentBranch(repoPath);
      worktreePath = repoPath;
      baseBranch = null;
      baseCommitSha = await gitService.getHeadCommitSha(repoPath);
    } else {
      baseBranch = input.baseBranch || defaultBranch;
      if (!baseBranch) {
        throw new WorkspaceError(
          "No default branch configured for this project. Set a default branch in project settings or choose a base branch.",
          "BAD_REQUEST",
        );
      }
      branch = input.branch ?? "";
      worktreePath = await gitService.createWorktree(repoPath, branch, baseBranch);
      baseCommitSha = null;
    }

    const { setupScript, setupBlocking, setupEnabled } = setupConfig;
    if (!isDirect && setupScript && setupEnabled && !input.skipSetup) {
      if (setupBlocking) {
        try {
          const result = await runSetupScript(worktreePath, setupScript);
          if (result.exitCode === 0) {
            console.log(`[workspaces] setup complete: workspaceId=${workspaceId}`);
          } else {
            console.warn(`[workspaces] setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
          }
        } catch (err) {
          console.warn(`[workspaces] setup error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        runSetupScript(worktreePath, setupScript).then(result => {
          if (result.exitCode === 0) {
            console.log(`[workspaces] parallel setup complete: workspaceId=${workspaceId}`);
          } else {
            console.warn(`[workspaces] parallel setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
          }
        }).catch(err => {
          console.warn(`[workspaces] parallel setup error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

    return { branch, worktreePath, baseBranch, baseCommitSha };
  }

  function buildAgentPrompt(
    issue: { title: string; description: string | null },
    input: Pick<CreateWorkspaceInput, "customPrompt" | "includeVisualProof">,
    issueId: string,
  ): string {
    let prompt: string;
    if (input.customPrompt) {
      prompt = input.customPrompt;
    } else {
      prompt = issue.title;
      if (issue.description) {
        prompt += `\n\n${issue.description}`;
      }
    }
    if (input.includeVisualProof) {
      const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
      prompt += `\n\nAfter completing the implementation, attach visual proof to this ticket. Use the playwright-cli skill to open the running app, take a screenshot of the working result, and post it as an artifact:\nPOST http://localhost:${serverPort}/api/issues/${issueId}/artifacts\nBody: { "type": "image", "mimeType": "image/png", "content": "<base64 data URL>", "caption": "Screenshot of the working result" }`;
    }
    return prompt;
  }

  async function resolveSkillFile(
    skillId: string | null,
    diskSkillName: string | null,
    worktreePath: string,
    repoPath: string,
  ): Promise<string | null> {
    if (skillId) {
      const skillRows = await database.select().from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
      if (skillRows.length === 0) return null;
      const skill = skillRows[0];
      const localPrompt = await readLocalSkillPrompt(repoPath, skill.name);
      const effectiveSkill = localPrompt ? { ...skill, prompt: localPrompt } : skill;
      await writeAgentSkillFile(worktreePath, effectiveSkill);
      return skill.name;
    }
    if (diskSkillName) {
      const copied = await copySkillToWorktree(repoPath, diskSkillName, worktreePath);
      return copied ? diskSkillName : null;
    }
    return null;
  }

  async function buildAgentConfig(input: Pick<CreateWorkspaceInput, "profile" | "claudeProfile" | "model">): Promise<{
    agentCommand: string | undefined;
    agentArgs: string | undefined;
    claudeProfile: string | undefined;
    resolvedProfile: string | undefined;
    resolvedProvider: ProviderName;
    resolvedProfileSelection: { provider: ProviderName; name: string } | undefined;
    permissionPromptTool: string | undefined;
    model: string | undefined;
  }> {
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

    const { agentCommand, agentArgs, claudeProfile: resolvedProfile, profile: resolvedProfileSelection, provider, permissionPromptTool } = resolveAgentSettings(prefMap);
    const claudeProfile = resolvedProfileSelection?.name || legacyProfileOverride || prefMap.get("claude_profile") || undefined;

    // Model is Claude-only. Per-request model wins; otherwise fall back to the default_model preference.
    const model = provider === "claude"
      ? ((input.model ?? prefMap.get("default_model")) || undefined)
      : undefined;

    return { agentCommand, agentArgs, claudeProfile, resolvedProfile, resolvedProvider: provider, resolvedProfileSelection, permissionPromptTool, model };
  }

  async function insertWorkspaceRecord(params: {
    id: string;
    issueId: string;
    branch: string;
    worktreePath: string | null;
    baseBranch: string | null;
    isDirect: boolean;
    baseCommitSha: string | null;
    requiresReview: boolean;
    thoroughReview: boolean;
    planMode: boolean;
    includeVisualProof: boolean;
    skillId: string | null;
    claudeProfile: string | undefined;
    agentCommand: string | undefined;
    resolvedProvider: ProviderName;
    model: string | undefined;
    now: string;
  }): Promise<void> {
    await database.insert(workspaces).values({
      id: params.id,
      issueId: params.issueId,
      branch: params.branch,
      workingDir: params.worktreePath,
      baseBranch: params.baseBranch,
      isDirect: params.isDirect,
      baseCommitSha: params.baseCommitSha,
      requiresReview: params.requiresReview,
      thoroughReview: params.thoroughReview,
      planMode: params.planMode,
      includeVisualProof: params.includeVisualProof,
      skillId: params.skillId,
      status: "active",
      claudeProfile: params.claudeProfile ?? null,
      agentCommand: params.agentCommand ?? null,
      provider: params.resolvedProvider,
      model: params.model ?? null,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  async function launchAgent(params: {
    workspaceId: string;
    branch: string;
    isDirect: boolean;
    agentPrompt: string;
    agentCommand: string | undefined;
    agentArgs: string | undefined;
    resolvedProfile: string | undefined;
    permissionPromptTool: string | undefined;
    planMode: boolean;
    resolvedProvider: ProviderName;
    resolvedProfileSelection: { provider: ProviderName; name: string } | undefined;
    model: string | undefined;
    skillName: string | null;
  }): Promise<string | undefined> {
    if (!getSessionManager) return undefined;
    const truncatedPrompt = params.agentPrompt.length > 80 ? params.agentPrompt.slice(0, 80) + "..." : params.agentPrompt;
    console.log(`[workspaces] auto-launch: workspaceId=${params.workspaceId} branch=${params.branch} isDirect=${params.isDirect} prompt="${truncatedPrompt}" agentCommand=${params.agentCommand ?? "default"}`);
    const executorProvider = toExecutorProvider(params.resolvedProvider);
    return getSessionManager().startSession({
      workspaceId: params.workspaceId,
      prompt: params.agentPrompt,
      agentCommand: params.agentCommand,
      agentArgs: params.agentArgs,
      claudeProfile: params.resolvedProfile,
      permissionPromptTool: params.permissionPromptTool,
      planMode: params.planMode,
      provider: executorProvider,
      triggerType: params.skillName ? `skill:${params.skillName}` : "agent",
      profile: params.resolvedProfileSelection,
      model: params.model,
    });
  }

  async function handleCreateFailure(err: unknown, params: {
    id: string;
    issueId: string;
    branch: string;
    worktreePath: string | null;
    repoPath: string | null;
    baseBranch: string | null;
    isDirect: boolean;
    baseCommitSha: string | null;
    requiresReview: boolean;
    thoroughReview: boolean;
    planMode: boolean;
    includeVisualProof: boolean;
    claudeProfile: string | undefined;
    agentCommand: string | undefined;
    resolvedProvider: ProviderName;
    now: string;
  }): Promise<CreateWorkspaceResult> {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[workspaces] create failed: ${errorMsg}`);

    // Clean up orphaned worktree if one was created before the failure
    if (!params.isDirect && params.worktreePath && params.repoPath) {
      try {
        await gitService.removeWorktree(params.repoPath, params.worktreePath);
        console.log(`[workspaces] cleaned up orphaned worktree: ${params.worktreePath}`);
      } catch (cleanupErr) {
        console.warn(`[workspaces] failed to remove worktree after create error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      }
    }

    try {
      await database.insert(workspaces).values({
        id: params.id,
        issueId: params.issueId,
        branch: params.branch,
        workingDir: params.worktreePath,
        baseBranch: params.baseBranch,
        isDirect: params.isDirect,
        baseCommitSha: params.baseCommitSha,
        requiresReview: params.requiresReview,
        thoroughReview: params.thoroughReview,
        planMode: params.planMode,
        includeVisualProof: params.includeVisualProof,
        status: "active",
        claudeProfile: params.claudeProfile ?? null,
        agentCommand: params.agentCommand ?? null,
        provider: params.resolvedProvider,
        createdAt: params.now,
        updatedAt: params.now,
      });
    } catch {
      // DB insert may fail if worktree creation itself failed
    }

    return {
      id: params.id,
      issueId: params.issueId,
      branch: params.branch,
      workingDir: params.worktreePath,
      baseBranch: params.baseBranch,
      isDirect: params.isDirect,
      planMode: params.planMode,
      includeVisualProof: params.includeVisualProof,
      status: "active",
      provider: params.resolvedProvider,
      createdAt: params.now,
      updatedAt: params.now,
      error: errorMsg,
    };
  }

  async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    const isDirect = input.isDirect === true;
    const requiresReview = input.requiresReview === true;
    const thoroughReview = input.thoroughReview === true;
    const planMode = input.planMode === true;
    const includeVisualProof = input.includeVisualProof === true;
    const skillId = input.skillId || null;
    const now = new Date().toISOString();
    const id = randomUUID();

    // Mutable state for error recovery
    let branch = input.branch ?? "";
    let worktreePath: string | null = null;
    let repoPath: string | null = null;
    let baseBranch: string | null = null;
    let baseCommitSha: string | null = null;
    let claudeProfile: string | undefined;
    let agentCommand: string | undefined;
    let resolvedProvider: ProviderName = "claude";

    try {
      const { issue, project, setupConfig } = await resolveIssueAndProject(input.issueId);
      repoPath = project.repoPath;

      ({ branch, worktreePath, baseBranch, baseCommitSha } = await setupWorktree(
        isDirect, project.repoPath, project.defaultBranch, input, setupConfig, id,
      ));

      const agentPrompt = buildAgentPrompt(issue, { ...input, includeVisualProof }, input.issueId);

      const skillName = worktreePath
        ? await resolveSkillFile(skillId, input.skillName ?? null, worktreePath, project.repoPath)
        : null;

      const agentConfig = await buildAgentConfig(input);
      claudeProfile = agentConfig.claudeProfile;
      agentCommand = agentConfig.agentCommand;
      resolvedProvider = agentConfig.resolvedProvider;

      await insertWorkspaceRecord({
        id, issueId: input.issueId, branch, worktreePath, baseBranch, isDirect,
        baseCommitSha, requiresReview, thoroughReview, planMode, includeVisualProof,
        skillId, claudeProfile, agentCommand, resolvedProvider, model: agentConfig.model, now,
      });

      await moveIssueToInProgress(input.issueId, issue.projectId, now, database);

      const sessionId = await launchAgent({
        workspaceId: id, branch, isDirect, agentPrompt,
        agentCommand, agentArgs: agentConfig.agentArgs,
        resolvedProfile: agentConfig.resolvedProfile,
        permissionPromptTool: agentConfig.permissionPromptTool,
        planMode, resolvedProvider,
        resolvedProfileSelection: agentConfig.resolvedProfileSelection,
        model: agentConfig.model,
        skillName,
      });

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
      if (err instanceof WorkspaceError) throw err;
      return handleCreateFailure(err, {
        id, issueId: input.issueId, branch, worktreePath, repoPath, baseBranch, isDirect,
        baseCommitSha, requiresReview, thoroughReview, planMode, includeVisualProof,
        claudeProfile, agentCommand, resolvedProvider, now,
      });
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

    // Serialize merges per repo: reject with 409 if one is already in flight for this repo
    if (activeMerges.has(repoPath)) {
      throw new WorkspaceError(
        "A merge is already in progress for this repository. Please wait for it to complete.",
        "CONFLICT",
      );
    }

    const mergePromise = doMerge(id, workspace, project, repoPath, defaultBranch);
    activeMerges.set(repoPath, mergePromise);
    try {
      return await mergePromise;
    } finally {
      activeMerges.delete(repoPath);
    }
  }

  async function doMerge(
    id: string,
    workspace: typeof workspaces.$inferSelect,
    project: typeof projects.$inferSelect | null,
    repoPath: string,
    defaultBranch: string | null,
  ) {

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

    // Guard: refuse merge if main checkout has uncommitted tracked changes.
    // git merge --no-ff will abort if tracked files are dirty, leaving the repo in an error
    // state and potentially overwriting the caller's work. Fail fast with a clear message.
    const uncommittedInMain = await gitService.getUncommittedTrackedChanges(repoPath);
    if (uncommittedInMain.length > 0) {
      const preview = uncommittedInMain.slice(0, 10).join("\n");
      const suffix = uncommittedInMain.length > 10 ? `\n…and ${uncommittedInMain.length - 10} more` : "";
      throw new WorkspaceError(
        `Cannot merge: the main checkout has ${uncommittedInMain.length} uncommitted tracked change(s). ` +
          `Commit or stash these before merging:\n${preview}${suffix}`,
        "CONFLICT",
        { uncommittedFiles: uncommittedInMain },
      );
    }

    console.log(`[workspace-service] merge: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath}`);

    // Sync branch ref to HEAD before merging
    if (workspace.workingDir) {
      const synced = await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
      if (synced) {
        console.log(`[workspace-service] synced branch ${workspace.branch} to worktree HEAD`);
      }
    }

    // Mandatory pre-merge backup. Non-fatal: backup trouble must not block a legit merge.
    try {
      await createBackup("pre-merge");
    } catch (err) {
      console.warn("[backup] pre-merge backup failed (non-fatal):", err instanceof Error ? err.message : String(err));
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
    if (workspace.status === "fixing") throw new WorkspaceError("Conflict resolution already in progress", "CONFLICT");
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
    if (workspace.status === "fixing") throw new WorkspaceError("Fix already in progress", "CONFLICT");
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

  async function launchSession(id: string, body: Record<string, unknown> = {}) {
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    let prompt = body.prompt as string | undefined;
    if (!prompt) {
      const issueRows = await database
        .select({ title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, ws0.issueId))
        .limit(1);
      if (issueRows.length === 0) {
        throw new WorkspaceError("Cannot build prompt: issue not found", "NOT_FOUND");
      }
      const iss = issueRows[0];
      prompt = iss.description ? `${iss.title}\n\n${iss.description}` : iss.title;
    }

    const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, resumeWithNewModel, permissionPromptTool } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database, body.agentCommand as string | undefined), ws0);

    const truncatedPrompt = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
    const skipPermissions = typeof body.skipPermissions === "boolean" ? body.skipPermissions : undefined;

    console.log(`[workspace-service] launch: workspaceId=${id} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"} agentArgs=${agentArgs ?? "none"} profile=${claudeProfile ?? "none"} resumeFromId=${body.resumeFromId ?? "none"} resumeWithNewModel=${resumeWithNewModel} skipPermissions=${skipPermissions ?? "default"}`);

    const planMode = ws0.planMode ?? false;
    const resumeFromId = typeof body.resumeFromId === "string" ? body.resumeFromId : undefined;

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, resumeFromId, claudeProfile,
      provider: toExecutorProvider(agentProvider), multiTurn: false, permissionPromptTool,
      planMode, resumeWithNewModel, triggerType: "chat", profile: agentProfile, skipPermissions,
    });

    await updateWorkspaceStatus(id, "active", {
      claudeProfile: claudeProfile ?? null,
      agentCommand: agentCommand ?? null,
      provider: agentProvider,
    }, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  async function sendTurn(id: string, content: string): Promise<TurnResult> {
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const resumable = await findResumableSession(id, database);
    if (!resumable) {
      throw new WorkspaceError("No session found for this workspace", "NOT_FOUND");
    }

    if (resumable.session.status === "running") {
      const result = getSessionManager().sendTurn(resumable.session.id, content);
      if (!result.ok) {
        throw new WorkspaceError(result.error || "Agent is busy", "CONFLICT");
      }
      return { type: "sent" };
    }

    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    const planMode = ws0.planMode ?? false;
    const { agentCommand, agentArgs, claudeProfile, profile, provider, resumeWithNewModel, permissionPromptTool } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database), ws0);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt: content, agentCommand, agentArgs,
      resumeFromId: resumable.session.id, claudeProfile, profile,
      provider: toExecutorProvider(provider), multiTurn: false, planMode,
      resumeWithNewModel, permissionPromptTool, triggerType: "chat",
    });

    await updateWorkspaceStatus(id, "active", {
      claudeProfile: claudeProfile ?? null,
      agentCommand: agentCommand ?? null,
      provider,
    }, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { type: "resumed", sessionId };
  }

  async function stopWorkspace(id: string): Promise<{ stopped: boolean }> {
    const runningSessions = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    let stopped = false;
    if (getSessionManager) {
      for (const session of runningSessions) {
        if (session.status === "running") {
          await getSessionManager().stopSession(session.id);
          stopped = true;
        }
      }
    }

    await updateWorkspaceStatus(id, "idle", {}, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_stopped");

    return { stopped };
  }

  async function implementPlan(id: string): Promise<{ sessionId: string }> {
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!ws0.pendingPlanPath) throw new WorkspaceError("No pending plan to implement", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, permissionPromptTool } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database, undefined), ws0);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt: buildImplementPrompt(), agentCommand, agentArgs, claudeProfile,
      provider: toExecutorProvider(agentProvider), multiTurn: false, permissionPromptTool,
      planMode: false, triggerType: "plan-implement", profile: agentProfile,
    });

    const now = new Date().toISOString();
    await database.update(workspaces).set({
      status: "active", pendingPlanPath: null,
      claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null,
      provider: agentProvider, updatedAt: now,
    }).where(eq(workspaces.id, id));

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  async function openTerminal(id: string): Promise<{ workingDir: string; command: string }> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");

    const { agentCommand, agentArgs } = await loadAgentSettings(database);
    const resolvedCommand = agentCommand || "claude";
    const fullCommand = agentArgs ? `${resolvedCommand} ${agentArgs}` : resolvedCommand;

    if (process.platform === "win32") {
      const tmpScript = join(tmpdir(), `terminal-${id}.cmd`);
      writeFileSync(tmpScript, `@cd /d "${workspace.workingDir}"\r\n@${fullCommand}\r\n`);
      spawn("cmd.exe", ["/c", "start", `Terminal - ${workspace.branch}`, tmpScript], {
        detached: true, stdio: "ignore",
      }).unref();
    } else {
      spawn("x-terminal-emulator", [
        "-e", `bash -c 'cd "${workspace.workingDir}" && ${fullCommand}; exec bash'`,
      ], { detached: true, stdio: "ignore" }).unref();
    }

    console.log(`[workspace-service] terminal: workspaceId=${id} workingDir=${workspace.workingDir} command=${fullCommand}`);
    return { workingDir: workspace.workingDir, command: fullCommand };
  }

  async function openEditor(id: string): Promise<void> {
    const ws = await getWorkspaceById(id, database);
    if (!ws) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!ws.workingDir) throw new WorkspaceError("Workspace has no working directory", "BAD_REQUEST");

    const which = spawnSync("code", ["--version"], { shell: true, windowsHide: true });
    if (which.status !== 0) {
      throw new WorkspaceError("VS Code (code) is not installed or not in PATH", "BAD_REQUEST");
    }

    spawn("code", [ws.workingDir], { shell: true, windowsHide: true, detached: true }).unref();
  }

  async function updateWorkspace(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
    const validStatuses = ["active", "reviewing", "idle", "closed"];
    if (body.status && !validStatuses.includes(body.status as string)) {
      throw new WorkspaceError("Invalid status. Must be active, reviewing, idle, or closed", "BAD_REQUEST");
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) updates.status = body.status;
    if (body.workingDir !== undefined) updates.workingDir = body.workingDir;
    if (body.planMode !== undefined) updates.planMode = body.planMode === true;

    await database.update(workspaces).set(updates).where(eq(workspaces.id, id));

    return { id };
  }

  async function getWorkspace(id: string) {
    return getWorkspaceDetails(id, database);
  }

  async function listComments(workspaceId: string, filePath?: string) {
    return getDiffComments(workspaceId, filePath, database);
  }

  async function createComment(
    workspaceId: string,
    body: { filePath: string; body: string; lineNumOld?: number | null; lineNumNew?: number | null; side?: string },
  ) {
    const ws = await getWorkspaceById(workspaceId, database);
    if (!ws) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    return createDiffCommentRepo(workspaceId, body, database);
  }

  async function updateComment(workspaceId: string, commentId: string, body: string) {
    const existing = await findDiffComment(commentId, workspaceId, database);
    if (!existing) throw new WorkspaceError("Comment not found", "NOT_FOUND");
    await updateDiffCommentRepo(commentId, body, database);
    return { id: commentId };
  }

  async function deleteComment(workspaceId: string, commentId: string) {
    const existing = await findDiffComment(commentId, workspaceId, database);
    if (!existing) throw new WorkspaceError("Comment not found", "NOT_FOUND");
    await deleteDiffComment(commentId, database);
  }

  async function getSessions(workspaceId: string) {
    const ws = await getWorkspaceById(workspaceId, database);
    const skillName = await getWorkspaceSkillName(ws?.skillId ?? null, database);
    const result = await getWorkspaceSessions(workspaceId, database);
    return result.map(s => ({ ...s, skillName }));
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
    launchSession,
    sendTurn,
    stopWorkspace,
    implementPlan,
    openTerminal,
    openEditor,
    updateWorkspace,
    getWorkspace,
    listComments,
    createComment,
    updateComment,
    deleteComment,
    getSessions,
  };
}
