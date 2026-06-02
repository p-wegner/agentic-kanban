import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, and } from "drizzle-orm";
import { existsSync } from "node:fs";
import { resolve as pathResolve, dirname, parse as pathParse, relative, sep } from "node:path";
import {
  issues, projects, preferences, workspaces, sessions, sessionMessages, diffComments, agentSkills, projectStatuses,
} from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";

export interface StaleWorktreeEntry {
  id: string;
  branch: string;
  workingDir: string;
  workspaceStatus: string;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueStatusName: string;
  projectId: string;
  repoPath: string;
}
export interface CleanupWarningEntry {
  id: string;
  branch: string;
  workingDir: string | null;
  cleanupWarning: string;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  projectId: string;
}

import type { ProviderName } from "./agent-provider.js";
import * as realGitService from "./git.service.js";
import { estimateBudget } from "./budget-estimator.service.js";
import type { BudgetEstimate } from "./budget-estimator.service.js";
import { kill as killAgent } from "./agent.service.js";
import { teardownWorktree } from "./workspace-teardown.service.js";
import { runSetupScript } from "./setup-script.js";
import type { SetupScriptResult } from "./setup-script.js";
import type { WorkspaceSymlinkRun } from "@agentic-kanban/shared";
import { writeAgentSkillFile, readLocalSkillPrompt, copySkillToWorktree } from "@agentic-kanban/shared/lib/agent-skill-files";
import { writeTicketContextFile } from "@agentic-kanban/shared/lib/ticket-context";
import { bootstrapSymlinks, parseSymlinkDirs } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import {
  resolveWorkflowStart,
  initWorkspaceWorkflow,
  buildTransitionBlock,
} from "@agentic-kanban/shared/lib/workflow-engine";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { parseStrategyBullseyeConfig, selectProviderFromStrategy } from "./strategy-objective.service.js";
import { preflightAgentProfile } from "./agent-profile-health.service.js";
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
import { buildContextPrimer } from "./context-packer.service.js";
import { auditProcessEvent, guardProcessKill } from "./process-guard.js";

export function createWorkspaceCrudService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
}) {
  const { database, getSessionManager, boardEvents } = deps;
  const gitService = deps.gitService ?? realGitService;

  type SetupRunState = "running" | "success" | "failed" | "skipped";
  type LatestSetupRun = {
    command: string | null;
    state: SetupRunState;
    startedAt: string | null;
    endedAt: string | null;
    exitCode: number | null;
    durationMs: number | null;
    stdoutTail: string | null;
    stderrTail: string | null;
  };
  type LatestSymlinkRun = WorkspaceSymlinkRun;

  function stringifyJson(value: unknown): string {
    return JSON.stringify(value);
  }

  function tailOutput(output: string): string | null {
    const trimmed = output.trim();
    if (!trimmed) return null;
    const lines = trimmed.split(/\r?\n/).slice(-8).join("\n");
    return lines.length > 2000 ? lines.slice(-2000) : lines;
  }

  function buildSetupRunFromResult(command: string, startedAt: string, result: SetupScriptResult): LatestSetupRun {
    const endedAt = new Date().toISOString();
    return {
      command,
      state: result.exitCode === 0 ? "success" : "failed",
      startedAt,
      endedAt,
      exitCode: result.exitCode,
      durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()),
      stdoutTail: tailOutput(result.stdout),
      stderrTail: tailOutput(result.stderr),
    };
  }

  function buildSetupRunFromError(command: string, startedAt: string, err: unknown): LatestSetupRun {
    const endedAt = new Date().toISOString();
    return {
      command,
      state: "failed",
      startedAt,
      endedAt,
      exitCode: null,
      durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()),
      stdoutTail: null,
      stderrTail: tailOutput(err instanceof Error ? err.message : String(err)),
    };
  }

  function skippedSetupRun(command: string | null): LatestSetupRun {
    const now = new Date().toISOString();
    return {
      command,
      state: "skipped",
      startedAt: now,
      endedAt: now,
      exitCode: null,
      durationMs: 0,
      stdoutTail: null,
      stderrTail: null,
    };
  }

  function disabledSymlinkRun(): LatestSymlinkRun {
    const now = new Date().toISOString();
    return {
      state: "disabled",
      dirs: [],
      linked: [],
      skipped: [],
      failed: [],
      startedAt: now,
      endedAt: now,
      error: null,
    };
  }

  function buildSymlinkRun(
    dirs: string[],
    startedAt: string,
    result: { linked: string[]; skipped: string[]; failed: Array<{ dir: string; error: string }> },
  ): LatestSymlinkRun {
    const endedAt = new Date().toISOString();
    const state = result.failed.length > 0
      ? "failed"
      : result.linked.length > 0
        ? "linked"
        : "skipped";
    return {
      state,
      dirs,
      linked: result.linked,
      skipped: result.skipped,
      failed: result.failed,
      startedAt,
      endedAt,
      error: null,
    };
  }

  function buildSymlinkErrorRun(dirs: string[], startedAt: string, err: unknown): LatestSymlinkRun {
    const endedAt = new Date().toISOString();
    return {
      state: "failed",
      dirs,
      linked: [],
      skipped: [],
      failed: [],
      startedAt,
      endedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  async function updateLatestSetupRun(workspaceId: string, run: LatestSetupRun, projectId?: string): Promise<void> {
    await database
      .update(workspaces)
      .set({
        latestSetupCommand: run.command,
        latestSetupState: run.state,
        latestSetupStartedAt: run.startedAt,
        latestSetupEndedAt: run.endedAt,
        latestSetupExitCode: run.exitCode,
        latestSetupDurationMs: run.durationMs,
        latestSetupStdoutTail: run.stdoutTail,
        latestSetupStderrTail: run.stderrTail,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workspaces.id, workspaceId));
    if (projectId) boardEvents?.broadcast(projectId, "workspace_setup");
  }

  async function resolveIssueAndProject(issueId: string): Promise<{
    issue: { projectId: string; issueNumber: number | null; title: string; description: string | null; priority: string | null };
    project: { repoPath: string; defaultBranch: string | null };
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean };
    symlinkConfig: { enabled: boolean; dirs: string[] };
  }> {
    const issueRows = await database
      .select({ projectId: issues.projectId, issueNumber: issues.issueNumber, title: issues.title, description: issues.description, priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);

    if (issueRows.length === 0) {
      throw new WorkspaceError("Issue not found", "NOT_FOUND");
    }

    const issue = issueRows[0];

    const projectRows = await database
      .select({
        repoPath: projects.repoPath,
        defaultBranch: projects.defaultBranch,
        setupScript: projects.setupScript,
        setupBlocking: projects.setupBlocking,
        setupEnabled: projects.setupEnabled,
        symlinkEnabled: projects.symlinkEnabled,
        symlinkDirs: projects.symlinkDirs,
      })
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
      symlinkConfig: {
        enabled: projectRow.symlinkEnabled ?? false,
        dirs: parseSymlinkDirs(projectRow.symlinkDirs),
      },
    };
  }

  async function setupWorktree(
    isDirect: boolean,
    repoPath: string,
    defaultBranch: string | null,
    input: Pick<CreateWorkspaceInput, "branch" | "baseBranch" | "skipSetup">,
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean },
    symlinkConfig: { enabled: boolean; dirs: string[] },
    workspaceId: string,
  ): Promise<{
    branch: string;
    worktreePath: string;
    baseBranch: string | null;
    baseCommitSha: string | null;
    latestSetup: LatestSetupRun;
    setupCompletion?: Promise<LatestSetupRun>;
    symlinkRun: LatestSymlinkRun;
  }> {
    let branch: string;
    let worktreePath: string;
    let baseBranch: string | null;
    let baseCommitSha: string | null;
    let symlinkRun = disabledSymlinkRun();

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
      baseCommitSha = await gitService.revParse(repoPath, baseBranch);
      worktreePath = await gitService.createWorktree(repoPath, branch, baseBranch);
    }

    // Symlink dependency directories from the main checkout into the worktree.
    // Best-effort: never blocks workspace creation on failure.
    if (!isDirect && symlinkConfig.enabled && symlinkConfig.dirs.length > 0) {
      const symlinkStartedAt = new Date().toISOString();
      try {
        const symlinkResult = await bootstrapSymlinks(repoPath, worktreePath, symlinkConfig.dirs);
        symlinkRun = buildSymlinkRun(symlinkConfig.dirs, symlinkStartedAt, symlinkResult);
        if (symlinkResult.linked.length > 0) {
          console.log(`[workspaces] symlink bootstrap: linked [${symlinkResult.linked.join(", ")}] for workspaceId=${workspaceId}`);
        }
        if (symlinkResult.failed.length > 0) {
          console.warn(`[workspaces] symlink bootstrap: failed [${symlinkResult.failed.map(f => `${f.dir}: ${f.error}`).join(", ")}] for workspaceId=${workspaceId}`);
        }
      } catch (err) {
        symlinkRun = buildSymlinkErrorRun(symlinkConfig.dirs, symlinkStartedAt, err);
        console.warn(`[workspaces] symlink bootstrap error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { setupScript, setupBlocking, setupEnabled } = setupConfig;
    let latestSetup = skippedSetupRun(setupScript);
    let setupCompletion: Promise<LatestSetupRun> | undefined;
    if (!isDirect && setupScript && setupEnabled && !input.skipSetup) {
      const startedAt = new Date().toISOString();
      if (setupBlocking) {
        try {
          const result = await runSetupScript(worktreePath, setupScript);
          latestSetup = buildSetupRunFromResult(setupScript, startedAt, result);
          if (result.exitCode === 0) {
            console.log(`[workspaces] setup complete: workspaceId=${workspaceId}`);
          } else {
            console.warn(`[workspaces] setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
          }
        } catch (err) {
          latestSetup = buildSetupRunFromError(setupScript, startedAt, err);
          console.warn(`[workspaces] setup error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        latestSetup = {
          command: setupScript,
          state: "running",
          startedAt,
          endedAt: null,
          exitCode: null,
          durationMs: null,
          stdoutTail: null,
          stderrTail: null,
        };
        setupCompletion = runSetupScript(worktreePath, setupScript).then(result => {
          if (result.exitCode === 0) {
            console.log(`[workspaces] parallel setup complete: workspaceId=${workspaceId}`);
          } else {
            console.warn(`[workspaces] parallel setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
          }
          return buildSetupRunFromResult(setupScript, startedAt, result);
        }).catch(err => {
          console.warn(`[workspaces] parallel setup error: ${err instanceof Error ? err.message : String(err)}`);
          return buildSetupRunFromError(setupScript, startedAt, err);
        });
      }
    }

    return { branch, worktreePath, baseBranch, baseCommitSha, latestSetup, setupCompletion, symlinkRun };
  }

  function buildAgentPrompt(
    issue: { title: string; description: string | null },
    input: Pick<CreateWorkspaceInput, "customPrompt" | "includeVisualProof" | "clarifications">,
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
    // Prepend answered preflight clarifications so the agent starts with the resolved
    // Q&A as part of its spec (the user already reconciled these ambiguities).
    if (input.clarifications?.trim()) {
      prompt = `${input.clarifications.trim()}\n\n${prompt}`;
    }
    if (input.includeVisualProof) {
      prompt += `\n\nAfter completing the implementation, attach visual proof to this ticket. Use the playwright-cli skill to open the running app, take a screenshot of the working result, and call the MCP tool \`attach_artifact\` with { "issueId": "${issueId}", "type": "image", "mimeType": "image/png", "content": "<base64 data URL>", "caption": "Screenshot of the working result" }.`;
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

  async function buildAgentConfig(
    input: Pick<CreateWorkspaceInput, "profile" | "claudeProfile" | "model">,
    projectId?: string,
  ): Promise<{
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
    } else if (projectId) {
      // No explicit profile — consult the project's strategy config for provider policy.
      const strategyRaw = prefMap.get(`board_strategy_${projectId}`);
      if (strategyRaw) {
        try {
          const strategyConfig = parseStrategyBullseyeConfig(strategyRaw);
          const selected = selectProviderFromStrategy(strategyConfig);
          if (selected) {
            if (selected.provider === "codex") {
              if (selected.profileName) prefMap.set("codex_profile", selected.profileName);
              prefMap.set("provider", "codex");
            } else if (selected.provider === "copilot") {
              if (selected.profileName) prefMap.set("copilot_profile", selected.profileName);
              prefMap.set("provider", "copilot");
            } else {
              if (selected.profileName) prefMap.set("claude_profile", selected.profileName);
              prefMap.set("provider", "claude");
            }
            console.log(`[workspaces] strategy provider selection: ${selected.provider}:${selected.profileName} (mode=${selected.policy.mode})`);
          }
        } catch {
          /* non-fatal: fall through to global default */
        }
      }
    }

    const { agentCommand, agentArgs, claudeProfile: resolvedProfile, profile: resolvedProfileSelection, provider, permissionPromptTool } = resolveAgentSettings(prefMap);
    const claudeProfile = provider === "claude"
      ? (resolvedProfile || legacyProfileOverride || prefMap.get("claude_profile") || undefined)
      : resolvedProfileSelection?.name;

    const requestedModel = typeof input.model === "string" ? input.model.trim() : "";
    const model = provider === "claude"
      ? ((requestedModel || prefMap.get("default_model")) || undefined)
      : provider === "codex"
        ? (requestedModel || undefined)
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
    tddMode: boolean;
    includeVisualProof: boolean;
    skillId: string | null;
    claudeProfile: string | undefined;
    agentCommand: string | undefined;
    resolvedProvider: ProviderName;
    model: string | undefined;
    contextPrimer: string | null;
    latestSetup: LatestSetupRun;
    latestSymlink: LatestSymlinkRun;
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
      tddMode: params.tddMode,
      includeVisualProof: params.includeVisualProof,
      skillId: params.skillId,
      status: "active",
      claudeProfile: params.claudeProfile ?? null,
      agentCommand: params.agentCommand ?? null,
      provider: params.resolvedProvider,
      model: params.model ?? null,
      latestSetupCommand: params.latestSetup.command,
      latestSetupState: params.latestSetup.state,
      latestSetupStartedAt: params.latestSetup.startedAt,
      latestSetupEndedAt: params.latestSetup.endedAt,
      latestSetupExitCode: params.latestSetup.exitCode,
      latestSetupDurationMs: params.latestSetup.durationMs,
      latestSetupStdoutTail: params.latestSetup.stdoutTail,
      latestSetupStderrTail: params.latestSetup.stderrTail,
      latestSymlinkState: params.latestSymlink.state,
      latestSymlinkStartedAt: params.latestSymlink.startedAt,
      latestSymlinkEndedAt: params.latestSymlink.endedAt,
      latestSymlinkDirs: stringifyJson(params.latestSymlink.dirs),
      latestSymlinkLinked: stringifyJson(params.latestSymlink.linked),
      latestSymlinkSkipped: stringifyJson(params.latestSymlink.skipped),
      latestSymlinkFailed: stringifyJson(params.latestSymlink.failed),
      latestSymlinkError: params.latestSymlink.error,
      contextPrimer: params.contextPrimer,
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
    contextFiles?: string[];
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
      contextFiles: params.contextFiles,
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

  function installTddHook(worktreePath: string): void {
    try {
      const hooksDir = join(worktreePath, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "commit-msg");
      const hookScript = `#!/bin/sh
# TDD mode: ensure AC test commit comes before implementation commits.
MSG=$(cat "$1")
# If this commit is the AC test commit, allow it.
if echo "$MSG" | grep -qE '^test: AC for #[0-9]+'; then
  exit 0
fi
# Check if an AC test commit already exists on this branch.
if git log --oneline | grep -qE ' test: AC for #[0-9]+'; then
  exit 0
fi
echo "TDD mode: write failing AC tests first." >&2
echo "  Commit your tests with: git commit -m 'test: AC for #<issue-number>'" >&2
exit 1
`;
      writeFileSync(hookPath, hookScript, { encoding: "utf-8" });
      try {
        chmodSync(hookPath, 0o755);
      } catch {
        // chmod may fail on Windows; hook still runs via Git for Windows bash
      }
      console.log(`[workspaces] TDD commit-msg hook installed: ${hookPath}`);
    } catch (err) {
      console.warn(`[workspaces] failed to install TDD hook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    const isDirect = input.isDirect === true;
    const requiresReview = input.requiresReview === true;
    const thoroughReview = input.thoroughReview === true;
    const tddMode = input.tddMode === true;
    const includeVisualProof = input.includeVisualProof === true;
    const skillId = input.skillId || null;
    const now = new Date().toISOString();
    const id = randomUUID();

    let branch = input.branch ?? "";
    let worktreePath: string | null = null;
    let repoPath: string | null = null;
    let baseBranch: string | null = null;
    let baseCommitSha: string | null = null;
    let latestSetup: LatestSetupRun = skippedSetupRun(null);
    let latestSymlink: LatestSymlinkRun = disabledSymlinkRun();
    let setupCompletion: Promise<LatestSetupRun> | undefined;
    let claudeProfile: string | undefined;
    let agentCommand: string | undefined;
    let resolvedProvider: ProviderName = "claude";
    // Hoisted so it is in scope in the catch block's failure handler. The real
    // value (priority-derived default or explicit input) is assigned inside try.
    let planMode = input.planMode === true;
    // Tracks whether the workspace row was committed to the DB. Used to decide
    // between rollback-and-throw (post-insert failure) vs insert-then-return-error
    // (pre-insert failure) in the catch block.
    let workspaceInserted = false;

    try {
      const { issue, project, setupConfig, symlinkConfig } = await resolveIssueAndProject(input.issueId);
      repoPath = project.repoPath;

      // Default plan mode on for high/critical priority when not explicitly set.
      // This ensures expensive misunderstandings are caught before implementation begins.
      const isHighPriority = issue.priority === "high" || issue.priority === "critical";
      planMode = input.planMode !== undefined ? input.planMode === true : isHighPriority;

      ({ branch, worktreePath, baseBranch, baseCommitSha, latestSetup, setupCompletion, symlinkRun: latestSymlink } = await setupWorktree(
        isDirect, project.repoPath, project.defaultBranch, input, setupConfig, symlinkConfig, id,
      ));

      // Run context packer (best-effort: never blocks workspace creation).
      let contextPrimer: string | null = null;
      if (!isDirect && !input.skipContextPacker) {
        try {
          const packed = await buildContextPrimer(
            {
              issueId: input.issueId,
              issueTitle: issue.title,
              issueDescription: issue.description,
              projectId: issue.projectId,
              repoPath: project.repoPath,
            },
            database,
          );
          if (packed.primer.trim()) contextPrimer = packed.primer;
        } catch (err) {
          console.warn(`[workspaces] context-packer failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Inject ticket details (+ optional context primer) into the worktree as
      // `CLAUDE.local.md` so the agent's first turn has the spec without foraging.
      // Gitignored — never enters the merge. Best-effort: a write failure must not
      // block workspace creation. Skipped for direct workspaces.
      let ticketContextPath: string | null = null;
      if (!isDirect && worktreePath) {
        ticketContextPath = await writeTicketContextFile(worktreePath, {
          issueNumber: issue.issueNumber,
          title: issue.title,
          description: issue.description,
          contextPrimer,
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

      const agentConfig = await buildAgentConfig(input, issue.projectId);
      claudeProfile = agentConfig.claudeProfile;
      agentCommand = agentConfig.agentCommand;
      resolvedProvider = agentConfig.resolvedProvider;

      await insertWorkspaceRecord({
        id, issueId: input.issueId, branch, worktreePath, baseBranch, isDirect,
        baseCommitSha, requiresReview, thoroughReview, planMode, tddMode, includeVisualProof,
        skillId: effectiveSkillId, claudeProfile, agentCommand, resolvedProvider, model: agentConfig.model,
        contextPrimer, latestSetup, latestSymlink, now,
      });
      workspaceInserted = true;

      if (setupCompletion) {
        setupCompletion
          .then((run) => updateLatestSetupRun(id, run, issue.projectId))
          .catch((err) => console.warn(`[workspaces] failed to persist setup status: ${err instanceof Error ? err.message : String(err)}`));
      }

      if (tddMode && worktreePath) {
        installTddHook(worktreePath);
      }

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
        contextFiles: ticketContextPath ? [ticketContextPath] : undefined,
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
        latestSetup,
        latestSymlink,
        sessionId,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      if (workspaceInserted) {
        // The workspace row was committed but the agent failed to start.
        // Atomically roll back: delete the row and remove the orphaned worktree,
        // then re-throw so the route returns 500 instead of a misleading 201.
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[workspaces] agent launch failed, rolling back workspace ${id}: ${errorMsg}`);
        try {
          await database.delete(workspaces).where(eq(workspaces.id, id));
        } catch (dbErr) {
          console.warn(`[workspaces] failed to delete workspace row during rollback: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        }
        if (!isDirect && worktreePath && repoPath) {
          try {
            await gitService.removeWorktree(repoPath, worktreePath);
            console.log(`[workspaces] cleaned up orphaned worktree during rollback: ${worktreePath}`);
          } catch (cleanupErr) {
            console.warn(`[workspaces] failed to remove worktree during rollback: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
          }
        }
        throw err;
      }
      return handleCreateFailure(err, {
        id, issueId: input.issueId, branch, worktreePath, repoPath, baseBranch, isDirect,
        baseCommitSha, requiresReview, thoroughReview, planMode, includeVisualProof,
        claudeProfile, agentCommand, resolvedProvider, now,
      });
    }
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    const wsSessions = await database
      .select({ id: sessions.id, status: sessions.status, pid: sessions.pid })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));

    const runningSessions = wsSessions.filter(s => s.status === "running");
    if (getSessionManager && runningSessions.length > 0) {
      for (const s of runningSessions) {
        // Graceful stop first (lets the agent flush + lets the session manager
        // mark the DB status as user-stopped).
        await getSessionManager().stopSession(s.id).catch(() => {});
      }
    }

    // Hard-kill the agent process TREE for every running session BEFORE removing the
    // worktree. The graceful stop above only kills the main agent process; its
    // descendant processes (git / powershell / node spawned by the agent) keep
    // running and hold open file handles inside the worktree, which makes the
    // recursive directory removal race and fail on Windows (EBUSY/EPERM/ENOTEMPTY),
    // leaving the worktree + branch registration behind.
    for (const s of runningSessions) {
      try {
        // `kill` taskkills the whole process tree (taskkill /T /F on Windows) using
        // the in-memory tracked pid. Fall back to the persisted sessions.pid for
        // detached/restored sessions whose ChildProcess handle is no longer tracked.
        const killed = killAgent(s.id);
        if (!killed && s.pid) {
          await killProcessTree(s.pid);
        }
      } catch (err) {
        console.warn(`[workspaces] failed to hard-kill session ${s.id} (pid=${s.pid ?? "?"})`, err);
      }
    }

    const wsRow = await database
      .select({
        workingDir: workspaces.workingDir,
        isDirect: workspaces.isDirect,
        branch: workspaces.branch,
        repoPath: projects.repoPath,
        teardownScript: projects.teardownScript,
        setupEnabled: projects.setupEnabled,
      })
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

    // A shared-worktree fork child reuses its parent's workingDir. Never remove the
    // directory while another (e.g. the parent) workspace still points at it — this
    // row is already deleted above, so any match here is a genuine other sharer.
    let sharedByOthers = false;
    if (workingDir && !isDirect && repoPath) {
      const sharers = await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.workingDir, workingDir));
      sharedByOthers = sharers.length > 0;
      if (sharedByOthers) {
        console.log(`[workspaces] worktree ${workingDir} still referenced by ${sharers.length} other workspace(s) — skipping removal`);
      }
    }

    if (workingDir && !isDirect && repoPath && !sharedByOthers) {
      // Free everything the worktree spun up BEFORE removing it: dir procs + the
      // worktree's dev ports + the project's generic teardownScript. Killing the
      // dir/port holders first also prevents the EBUSY/ENOTEMPTY removal race.
      await teardownWorktree({
        workingDir,
        branch: wsRow[0]?.branch,
        isDirect,
        teardownScript: wsRow[0]?.teardownScript,
        setupEnabled: wsRow[0]?.setupEnabled,
        label: "delete",
      });

      // Use git as the authoritative step to drop the worktree registration + branch
      // (`git worktree remove --force` also deletes the directory). This succeeds even
      // when a stray file handle survives, and unlike `git worktree prune` it does not
      // require the directory to already be gone.
      let removed = false;
      try {
        await gitService.removeWorktree(repoPath, workingDir);
        removed = true;
      } catch (err) {
        console.warn(`[workspaces] git worktree remove failed for ${workingDir} — retrying directory removal`, err);
      }

      // Fall back to (or follow up with) a retrying directory removal. Windows releases
      // file handles asynchronously after a process dies, so a transient lock right
      // after the kill should not be treated as a permanent failure.
      const dirRemoved = await removeDirWithRetry(workingDir);

      // Final fallback: prune dangling registrations whose directory is now gone.
      await gitService.pruneWorktrees(repoPath).catch(() => {});

      if (!removed && !dirRemoved) {
        console.warn(`[workspaces] failed to fully clean up worktree at ${workingDir} — manual cleanup may be required`);
      }
    }
  }

  /** Force-kill a process tree by pid. Windows: taskkill /F /T; otherwise SIGKILL. Guards already-dead pids. */
  async function killProcessTree(pid: number): Promise<void> {
    if (!pid || pid <= 0) return;
    if (!guardProcessKill(pid, { reason: "workspace-cleanup-fallback" })) return;
    if (process.platform === "win32") {
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        p.on("error", () => resolve());
        p.on("close", () => resolve());
      });
      auditProcessEvent({ action: "workspace-cleanup-taskkill-issued", pid });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
        auditProcessEvent({ action: "workspace-cleanup-sigkill-group-issued", pid });
      } catch {
        try {
          process.kill(pid, "SIGKILL");
          auditProcessEvent({ action: "workspace-cleanup-sigkill-issued", pid });
        } catch { /* already dead */ }
      }
    }
  }

  /** Remove a directory recursively, retrying to ride out async Windows file-handle release. */
  async function removeDirWithRetry(dir: string, attempts = 5, backoffMs = 300): Promise<boolean> {
    const { rm } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    for (let i = 0; i < attempts; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        if (!existsSync(dir)) return true;
      } catch (err) {
        if (i === attempts - 1) {
          console.warn(`[workspaces] directory removal failed after ${attempts} attempts: ${dir}`, err);
          return false;
        }
      }
      if (!existsSync(dir)) return true;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (i + 1)));
    }
    return !existsSync(dir);
  }

  /**
   * Close a workspace WITHOUT merging — for work that was abandoned or already
   * merged out-of-band. Stops any running agent, removes the worktree (non-direct),
   * and sets status to "closed" with a closedAt timestamp. Leaves mergedAt null so
   * the UI distinguishes a manual close from a real merge. Preserves session history
   * (unlike deleteWorkspace, which destroys the record).
   */
  async function closeWorkspace(workspaceId: string): Promise<{ id: string; status: "closed" }> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (workspace.status === "closed") return { id: workspaceId, status: "closed" };

    // Stop any RUNNING agent so it doesn't keep working against a closed workspace.
    // Only target running sessions — stopSession unconditionally rewrites status to
    // "stopped"/endedAt, so calling it on already-completed sessions would corrupt the
    // very history this close path promises to preserve (see deleteWorkspace).
    const wsSessions = await database
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));
    const runningSessions = wsSessions.filter((s) => s.status === "running");
    if (getSessionManager) {
      for (const s of runningSessions) {
        await getSessionManager().stopSession(s.id).catch(() => {});
      }
    }

    // Clean up the worktree for non-direct workspaces (mirrors merge/close behaviour).
    if (!workspace.isDirect && workspace.workingDir) {
      const { repoPath } = await resolveProjectRepo(workspaceId, database).catch(() => ({ repoPath: null as string | null }));
      if (repoPath) {
        try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* best effort */ }
      }
    }

    const now = new Date().toISOString();
    await database
      .update(workspaces)
      .set({ status: "closed", workingDir: workspace.isDirect ? workspace.workingDir : null, closedAt: now, updatedAt: now })
      .where(eq(workspaces.id, workspaceId));

    const projectId = await resolveProjectId(workspaceId, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_closed");

    return { id: workspaceId, status: "closed" };
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

  /**
   * List closed/merged workspaces whose worktree directories still exist on disk.
   * Returns data needed by the stale-worktree cleanup UI: issue info, branch, status,
   * and whether the directory is still present.
   */
  async function listStaleWorktrees(projectId?: string): Promise<StaleWorktreeEntry[]> {
    const conditions = [eq(workspaces.status, "closed")];
    if (projectId) {
      conditions.push(eq(issues.projectId, projectId));
    }
    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    const rows = await database
      .select({
        id: workspaces.id,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        status: workspaces.status,
        closedAt: workspaces.closedAt,
        mergedAt: workspaces.mergedAt,
        updatedAt: workspaces.updatedAt,
        issueId: workspaces.issueId,
        issueNumber: issues.issueNumber,
        issueTitle: issues.title,
        issueStatusName: projectStatuses.name,
        projectId: issues.projectId,
        repoPath: projects.repoPath,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .leftJoin(projects, eq(issues.projectId, projects.id))
      .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(whereClause);

    const results: StaleWorktreeEntry[] = [];

    for (const row of rows) {
      // Skip entries without a workingDir or repoPath
      if (!row.workingDir || !row.repoPath) continue;

      // Check if the directory actually still exists on disk
      if (!existsSync(row.workingDir)) continue;

      results.push({
        id: row.id,
        branch: row.branch,
        workingDir: row.workingDir,
        workspaceStatus: row.status,
        closedAt: row.closedAt,
        mergedAt: row.mergedAt,
        updatedAt: row.updatedAt,
        issueId: row.issueId,
        issueNumber: row.issueNumber ?? 0,
        issueTitle: row.issueTitle ?? "",
        issueStatusName: row.issueStatusName ?? "",
        projectId: row.projectId,
        repoPath: row.repoPath,
      });
    }

    return results;
  }

  /**
   * Safely remove a stale worktree directory. Validates that the workspace is closed
   * and that the workingDir is within the project's managed .worktrees/ directory,
   * rejecting arbitrary or unsafe paths.
   */
  async function removeStaleWorktree(workspaceId: string): Promise<{ success: boolean; error?: string }> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) {
      return { success: false, error: "Workspace not found" };
    }
    if (workspace.status !== "closed") {
      return { success: false, error: "Workspace is not closed" };
    }
    if (!workspace.workingDir) {
      return { success: false, error: "Workspace has no working directory" };
    }

    const resolved = await resolveProjectRepo(workspaceId, database).catch(() => ({ repoPath: null as string | null, defaultBranch: null as string | null }));
    if (!resolved.repoPath) {
      return { success: false, error: "Could not resolve project repo path" };
    }
    const repoPath = resolved.repoPath;

    // Validate the workingDir is inside the managed .worktrees/ directory
    const worktreesRoot = pathResolve(dirname(repoPath), ".worktrees");
    const targetResolved = pathResolve(workspace.workingDir);
    const relativeToWorktreesRoot = relative(worktreesRoot, targetResolved);
    const root = pathParse(targetResolved).root;
    const isInsideWorktreesRoot = relativeToWorktreesRoot !== ""
      && relativeToWorktreesRoot !== ".."
      && !relativeToWorktreesRoot.startsWith(`..${sep}`)
      && pathParse(relativeToWorktreesRoot).root === "";

    if (targetResolved === pathResolve(repoPath) || targetResolved === root || !isInsideWorktreesRoot) {
      return { success: false, error: "Refusing to remove path outside managed worktrees directory" };
    }

    if (!existsSync(workspace.workingDir)) {
      // Directory already gone — just null out workingDir in DB
      const now = new Date().toISOString();
      await database
        .update(workspaces)
        .set({ workingDir: null, updatedAt: now })
        .where(eq(workspaces.id, workspaceId));
      return { success: true };
    }

    try {
      await gitService.removeWorktree(repoPath, workspace.workingDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to remove worktree: ${message}` };
    }

    // Null out workingDir so it no longer shows as stale
    const now = new Date().toISOString();
    await database
      .update(workspaces)
      .set({ workingDir: null, updatedAt: now })
      .where(eq(workspaces.id, workspaceId));

    return { success: true };
  }

  /** Read-only dry-run: compute what would happen on launch without side effects. */
  async function computeLaunchPreview(input: CreateWorkspaceInput): Promise<{
    branch: string | null;
    baseBranch: string | null;
    isDirect: boolean;
    planMode: boolean;
    tddMode: boolean;
    requiresReview: boolean;
    setupScript: { enabled: boolean; command: string | null; blocking: boolean; willRun: boolean } | null;
    skill: { id: string; name: string } | null;
    provider: string;
    profile: string | null;
    model: string | null;
    warnings: string[];
    budgetEstimate: BudgetEstimate;
  }> {
    const isDirect = input.isDirect === true;
    const warnings: string[] = [];

    // 1. Resolve issue + project (same lookup as createWorkspace)
    const { issue, project, setupConfig } = await resolveIssueAndProject(input.issueId);

    // 2. Resolve plan mode default (high/critical → plan mode on)
    const isHighPriority = issue.priority === "high" || issue.priority === "critical";
    const planMode = input.planMode !== undefined ? input.planMode === true : isHighPriority;
    const tddMode = input.tddMode === true;
    const requiresReview = input.requiresReview === true;

    // 3. Branch / base-branch resolution (no worktree creation)
    let branch: string | null;
    let baseBranch: string | null;
    if (isDirect) {
      try {
        branch = await gitService.getCurrentBranch(project.repoPath);
      } catch {
        branch = "(unknown)";
      }
      baseBranch = null;
    } else {
      branch = input.branch ?? "";
      baseBranch = input.baseBranch || project.defaultBranch || null;
      if (!baseBranch) {
        warnings.push("No base branch configured — workspace creation will fail. Set a project default branch or choose a base branch.");
      }
    }

    // 4. Agent config resolution (provider, profile, model) — reuses same logic
    const agentConfig = await buildAgentConfig(input, issue.projectId);

    // 5. Skill resolution (name only, no file writes)
    const skillId = input.skillId || null;
    let skill: { id: string; name: string } | null = null;
    if (skillId) {
      const skillRows = await database.select({ id: agentSkills.id, name: agentSkills.name }).from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
      if (skillRows.length > 0) skill = skillRows[0];
    }

    // 6. Setup script info (computed, not run)
    const setupScript = setupConfig.setupScript
      ? {
          enabled: setupConfig.setupEnabled,
          command: setupConfig.setupScript,
          blocking: setupConfig.setupBlocking,
          willRun: setupConfig.setupEnabled && !input.skipSetup,
        }
      : null;

    // 7. Conflict detection: existing active/idle workspaces on this issue
    const existingWs = await database
      .select({ id: workspaces.id, status: workspaces.status, branch: workspaces.branch, isDirect: workspaces.isDirect })
      .from(workspaces)
      .where(eq(workspaces.issueId, input.issueId));
    const activeExisting = existingWs.filter(ws => ws.status === "active" || ws.status === "idle" || ws.status === "fixing");
    if (activeExisting.length > 0) {
      const labels = activeExisting.map(ws =>
        `${ws.branch || "direct"} (${ws.status})`
      );
      warnings.push(
        `Issue already has ${activeExisting.length} active workspace(s): ${labels.join(", ")}. Multiple concurrent workspaces on the same issue may cause merge conflicts.`,
      );
    }

    // 8. Branch name collision check (for non-direct workspaces)
    if (!isDirect && branch) {
      const branchExists = existingWs.some(ws => ws.branch === branch);
      if (branchExists) {
        warnings.push(`Branch "${branch}" already has a workspace. This will create a new worktree on the same branch.`);
      }
    }

    // 9. Missing base branch warning
    if (isDirect && !project.defaultBranch) {
      warnings.push("Project has no default branch configured. Some features (merge, diff) may not work.");
    }

    // 10. Profile availability check
    if (agentConfig.resolvedProfileSelection) {
      const { provider, name } = agentConfig.resolvedProfileSelection;
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      const profileCheck = preflightAgentProfile(prefMap, provider, name);
      if (!profileCheck.ok) {
        for (const err of profileCheck.errors) {
          warnings.push(`Profile unavailable: ${err}`);
        }
      }
    }

    // 12. Budget estimation (non-blocking — never throws)
    const budgetEstimate = await estimateBudget(database, input.issueId, agentConfig.resolvedProvider).catch(
      () => ({
        risk: "low" as const,
        estimatedTokens: null,
        avgTokensFromHistory: null,
        sessionCount: 0,
        descriptionTokens: 0,
        reason: "Estimation unavailable",
      }),
    );

    return {
      branch,
      baseBranch,
      isDirect,
      planMode,
      tddMode,
      requiresReview,
      setupScript,
      skill,
      provider: agentConfig.resolvedProvider,
      profile: agentConfig.resolvedProfile ?? agentConfig.resolvedProfileSelection?.name ?? null,
      model: agentConfig.model ?? null,
      warnings,
      budgetEstimate,
    };
  }

  /**
   * List closed workspaces that have a pending cleanup warning (worktree removal failed post-merge).
   */
  async function listCleanupWarnings(projectId?: string): Promise<CleanupWarningEntry[]> {
    const conditions = [eq(workspaces.status, "closed")];
    if (projectId) {
      conditions.push(eq(issues.projectId, projectId));
    }
    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    const rows = await database
      .select({
        id: workspaces.id,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        cleanupWarning: workspaces.cleanupWarning,
        closedAt: workspaces.closedAt,
        mergedAt: workspaces.mergedAt,
        updatedAt: workspaces.updatedAt,
        issueId: workspaces.issueId,
        issueNumber: issues.issueNumber,
        issueTitle: issues.title,
        projectId: issues.projectId,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(whereClause);

    return rows
      .filter((row) => row.cleanupWarning != null && row.cleanupWarning !== "")
      .map((row) => ({
        id: row.id,
        branch: row.branch,
        workingDir: row.workingDir,
        cleanupWarning: row.cleanupWarning as string,
        closedAt: row.closedAt,
        mergedAt: row.mergedAt,
        updatedAt: row.updatedAt,
        issueId: row.issueId,
        issueNumber: row.issueNumber ?? 0,
        issueTitle: row.issueTitle ?? "",
        projectId: row.projectId ?? "",
      }));
  }

  /**
   * Retry cleanup for a workspace with a pending cleanup warning. Runs the safe worktree
   * removal logic and clears the warning on success.
   */
  async function retryCleanup(workspaceId: string): Promise<{ success: boolean; error?: string }> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) {
      return { success: false, error: "Workspace not found" };
    }
    if (workspace.status !== "closed") {
      return { success: false, error: "Workspace is not closed" };
    }
    if (!workspace.cleanupWarning) {
      return { success: false, error: "No pending cleanup warning for this workspace" };
    }

    // Reuse the safe stale-worktree removal logic which validates path safety.
    const result = await removeStaleWorktree(workspaceId);

    if (result.success) {
      // Clear the warning now that cleanup succeeded.
      await database.update(workspaces)
        .set({ cleanupWarning: null, updatedAt: new Date().toISOString() })
        .where(eq(workspaces.id, workspaceId));
    }

    return result;
  }

  return {
    createWorkspace,
    deleteWorkspace,
    closeWorkspace,
    markReadyForMerge,
    setupWorkspace,
    updateWorkspace,
    getWorkspace,
    listStaleWorktrees,
    removeStaleWorktree,
    listCleanupWarnings,
    retryCleanup,
    computeLaunchPreview,
  };
}
