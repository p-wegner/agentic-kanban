import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  issues, projects, preferences, workspaces, sessions, sessionMessages, diffComments, agentSkills,
} from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import type { ProviderName } from "./agent-provider.js";
import * as realGitService from "./git.service.js";
import { runSetupScript } from "./setup-script.js";
import { writeAgentSkillFile, readLocalSkillPrompt, copySkillToWorktree } from "@agentic-kanban/shared/lib/agent-skill-files";
import { writeTicketContextFile } from "@agentic-kanban/shared/lib/ticket-context";
import {
  resolveWorkflowStart,
  initWorkspaceWorkflow,
  buildTransitionBlock,
} from "@agentic-kanban/shared/lib/workflow-engine";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { emitButlerSystemEvent } from "./butler-event-feed.js";
import {
  moveIssueToInProgress,
  resolveProjectRepo,
  resolveProjectId,
  getWorkspaceById,
  getWorkspaceDetails,
} from "../repositories/workspace.repository.js";
import {
  WorkspaceError,
  requireBaseBranch,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
  type GitService,
} from "./workspace-internals.js";

export function createWorkspaceCrudService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
}) {
  const { database, getSessionManager, boardEvents } = deps;
  const gitService = deps.gitService ?? realGitService;

  async function resolveIssueAndProject(issueId: string): Promise<{
    issue: { projectId: string; issueNumber: number | null; title: string; description: string | null };
    project: { repoPath: string; defaultBranch: string | null };
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean };
  }> {
    const issueRows = await database
      .select({ projectId: issues.projectId, issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
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
    // Claude Code treats prompts that start with `/` as slash-command invocations
    // (e.g. ticket title "/merge endpoint ..." → "Unknown command: /merge", agent exits in 3s).
    // Prefix a space to neutralize without altering meaning.
    if (prompt.startsWith("/")) {
      prompt = " " + prompt;
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

    try {
      const issueRows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, params.issueId)).limit(1);
      if (issueRows.length > 0) {
        emitButlerSystemEvent({ projectId: issueRows[0].projectId, kind: "workspace_error", workspaceId: params.id, text: `Workspace creation failed for issue ${params.issueId} (branch ${params.branch}): ${errorMsg.slice(0, 200)}` });
      }
    } catch { /* best-effort */ }

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

      // Inject ticket details into the worktree as `CLAUDE.local.md` so the agent's
      // first turn has the spec without foraging. Gitignored — never enters the merge.
      // Best-effort: a write failure must not block workspace creation. Skipped for
      // direct workspaces (workingDir is the user's real checkout root).
      if (!isDirect && worktreePath) {
        await writeTicketContextFile(worktreePath, {
          issueNumber: issue.issueNumber,
          title: issue.title,
          description: issue.description,
        });
      }

      let agentPrompt = buildAgentPrompt(issue, { ...input, includeVisualProof }, input.issueId);

      // Resolve the issue's configurable workflow (if any). The start node's
      // guidance + valid transitions are injected into the prompt, and its
      // attached skill is used when the caller didn't pick one explicitly.
      const workflowStart = await resolveWorkflowStart(database, input.issueId);
      let effectiveSkillId = skillId;
      let effectiveDiskSkill = input.skillName ?? null;
      if (workflowStart) {
        agentPrompt += `\n\n${buildTransitionBlock(workflowStart.node, workflowStart.transitions, id)}`;
        if (!effectiveSkillId && !effectiveDiskSkill) {
          effectiveSkillId = workflowStart.node.skillId ?? null;
          effectiveDiskSkill = workflowStart.node.skillName ?? null;
        }
      }

      const skillName = worktreePath
        ? await resolveSkillFile(effectiveSkillId, effectiveDiskSkill, worktreePath, project.repoPath)
        : null;

      const agentConfig = await buildAgentConfig(input);
      claudeProfile = agentConfig.claudeProfile;
      agentCommand = agentConfig.agentCommand;
      resolvedProvider = agentConfig.resolvedProvider;

      await insertWorkspaceRecord({
        id, issueId: input.issueId, branch, worktreePath, baseBranch, isDirect,
        baseCommitSha, requiresReview, thoroughReview, planMode, includeVisualProof,
        skillId: effectiveSkillId, claudeProfile, agentCommand, resolvedProvider, model: agentConfig.model, now,
      });

      // Place the workspace on the workflow start node + sync the derived status.
      // Falls back to the legacy "In Progress" move when the issue has no workflow.
      if (workflowStart) {
        await initWorkspaceWorkflow(database, { workspaceId: id, issueId: input.issueId }).catch(() =>
          moveIssueToInProgress(input.issueId, issue.projectId, now, database),
        );
      } else {
        await moveIssueToInProgress(input.issueId, issue.projectId, now, database);
      }

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
    const wsSessions = await database
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));

    if (getSessionManager && wsSessions.some(s => s.status === "running")) {
      for (const s of wsSessions) {
        if (s.status === "running") {
          await getSessionManager().stopSession(s.id).catch(() => {});
        }
      }
    }

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

    await database.delete(diffComments).where(eq(diffComments.workspaceId, workspaceId));
    if (wsSessions.length > 0) {
      const sessionIds = wsSessions.map(s => s.id);
      await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    }
    await database.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));

    if (workingDir && !isDirect && repoPath) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(workingDir, { recursive: true, force: true });
        await gitService.pruneWorktrees(repoPath).catch(() => {});
      } catch {
        // Best-effort
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

  return {
    createWorkspace,
    deleteWorkspace,
    markReadyForMerge,
    setupWorkspace,
    updateWorkspace,
    getWorkspace,
  };
}
