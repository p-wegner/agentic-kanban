/**
 * Workspace creation + launch-preview, extracted from workspace-crud.service.ts.
 *
 * This owns the constructive side of a workspace lifecycle: resolving the issue/
 * project, setting up the worktree (+ symlink bootstrap + setup script), resolving
 * the agent config/skill/prompt, inserting the DB row, and deferring the agent
 * launch off the hot path. computeLaunchPreview is the read-only dry-run of that
 * same pipeline. Both share the create-only helpers below. The crud service
 * instantiates this factory and delegates the two public methods, passing the same
 * injected deps so gitService stays substitutable in tests.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { isResolvedDependencyStatusView } from "@agentic-kanban/shared/lib/status-view";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { derivePortsFromBranch } from "./worktree-ports.js";
import { buildAgentPrompt } from "./workspace-create/policy.js";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import type { ProviderName } from "./agent-provider.js";
import { estimateBudget } from "./budget-estimator.service.js";
import type { BudgetEstimate } from "./budget-estimator.service.js";
import { runSetupScript } from "./setup-script.js";
import {
  buildSetupRunFromResult,
  buildSetupRunFromError,
  skippedSetupRun,
  disabledSymlinkRun,
  buildSymlinkRun,
  buildSymlinkErrorRun,
  type LatestSetupRun,
  type LatestSymlinkRun,
} from "./workspace-run-records.js";
import { writeAgentSkillFile, readLocalSkillPrompt, copySkillToWorktree } from "@agentic-kanban/shared/lib/agent-skill-files";
import { writeTicketContextFile } from "@agentic-kanban/shared/lib/ticket-context";
import { bootstrapSymlinks, parseSymlinkDirs } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import {
  resolveWorkflowStart,
  initWorkspaceWorkflow,
  buildTransitionBlock,
} from "@agentic-kanban/shared/lib/workflow-engine";
import { toExecutorProvider } from "./agent-settings.service.js";
import { resolveStrategyProviderSelection } from "./strategy-objective.service.js";
import { resolveProviderConfig } from "./provider-config-resolution.js";
import { preflightAgentProfile } from "./agent-profile-health.service.js";
import { emitButlerSystemEvent } from "./butler-event-feed.js";
import { DEFAULT_BUILDER_GUARDRAILS, PREF_BUILDER_GUARDRAILS } from "../constants/preference-keys.js";
import { moveIssueToInProgress } from "../repositories/workspace.repository.js";
import {
  WorkspaceError,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
  type GitService,
} from "./workspace-internals.js";
import { buildContextPrimer } from "./context-packer.service.js";
import { getStackProfile } from "./stack-profile.service.js";

export function createWorkspaceCreateService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService: GitService;
}) {
  const { database, getSessionManager, boardEvents, gitService } = deps;

  function stringifyJson(value: unknown): string {
    return JSON.stringify(value);
  }

  async function updateLatestSetupRun(workspaceId: string, run: LatestSetupRun, projectId?: string): Promise<void> {
    await crudRepo.updateLatestSetupRunFields(workspaceId, run, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_setup");
  }

  async function resolveIssueAndProject(issueId: string): Promise<{
    issue: { projectId: string; issueNumber: number | null; title: string; description: string | null; priority: string | null };
    project: { repoPath: string; defaultBranch: string | null; defaultSkillId: string | null };
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean };
    symlinkConfig: { enabled: boolean; dirs: string[] };
  }> {
    const issueRows = await crudRepo.getIssueForWorkspaceCreate(issueId, database);

    if (issueRows.length === 0) {
      throw new WorkspaceError("Issue not found", "NOT_FOUND");
    }

    const issue = issueRows[0];

    const projectRows = await crudRepo.getProjectForWorkspaceCreate(issue.projectId, database);

    if (projectRows.length === 0) {
      throw new WorkspaceError("Project not found", "NOT_FOUND");
    }

    const projectRow = projectRows[0];
    return {
      issue,
      project: { repoPath: projectRow.repoPath, defaultBranch: projectRow.defaultBranch, defaultSkillId: projectRow.defaultSkillId ?? null },
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
    issue?: { issueNumber?: number | null; title: string },
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
      branch = input.branch || (issue ? suggestBranchName(issue) : "");
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

  // buildAgentPrompt / neutralizeBuildTimeVisualVerification /
  // isBuildTimeVisualVerificationInstruction are pure policy — extracted to
  // ./workspace-create/policy.ts and unit-tested there. Imported at top of file.

  async function resolveSkillFile(
    skillId: string | null,
    diskSkillName: string | null,
    worktreePath: string,
    repoPath: string,
  ): Promise<string | null> {
    if (skillId) {
      const skillRows = await crudRepo.getAgentSkillById(skillId, database);
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
    systemInstructions: string;
  }> {
    const prefRows = await crudRepo.getAllPreferences(database);
    const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

    // Impure inputs: an explicit profile/claudeProfile override takes precedence;
    // otherwise consult the project's strategy config (DB + live quota) for the
    // provider policy. The pure decision below consumes the resolved selection.
    const hasOverride = Boolean(input.profile?.name) || Boolean(input.claudeProfile);
    const strategySelection = !hasOverride && projectId
      ? await resolveStrategyProviderSelection(database, projectId)
      : null;

    const resolved = resolveProviderConfig({
      prefMap,
      profileOverride: input.profile,
      legacyProfileOverride: input.claudeProfile,
      strategySelection,
      // Precedence: an explicit per-workspace model wins; otherwise honor the strategy policy's
      // pinned model (#818) so a project can run e.g. claude/sonnet without the global
      // default_model footgun. resolveProviderConfig still falls back to default_model when both
      // are unset, and drops a model that doesn't belong to the resolved provider.
      requestedModel: input.model ?? strategySelection?.model,
    });
    for (const note of resolved.notes) {
      console.log(`[workspaces] ${note}`);
    }

    return {
      agentCommand: resolved.agentCommand,
      agentArgs: resolved.agentArgs,
      claudeProfile: resolved.profileName,
      resolvedProfile: resolved.profileName,
      resolvedProvider: resolved.provider,
      resolvedProfileSelection: resolved.profileSelection,
      permissionPromptTool: resolved.permissionPromptTool,
      model: resolved.model,
      systemInstructions: prefMap.get(PREF_BUILDER_GUARDRAILS) ?? DEFAULT_BUILDER_GUARDRAILS,
    };
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
    await crudRepo.insertWorkspaceRecordRow({
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
    }, database);
  }

  async function assertNoOpenDirectWorkspaceForIssue(issueId: string): Promise<void> {
    const openDirectRows = await crudRepo.findOpenDirectWorkspacesForIssue(issueId, database);

    if (openDirectRows.length === 0) return;

    const first = openDirectRows[0];
    const extraCount = Math.max(0, openDirectRows.length - 1);
    const suffix = extraCount > 0 ? ` and ${extraCount} other open direct workspace(s)` : "";
    throw new WorkspaceError(
      `Issue already has an open direct workspace (${first.id}, branch ${first.branch}, status ${first.status}${first.updatedAt ? `, updated ${first.updatedAt}` : ""})${suffix}. Close or delete the existing direct workspace before creating another workspace; direct workspaces share the main checkout.`,
      "CONFLICT",
      { code: "OPEN_DIRECT_WORKSPACE", workspaceId: first.id, status: first.status, branch: first.branch },
    );
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
    systemInstructions: string;
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
      systemInstructions: params.systemInstructions,
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
      const issueRows = await crudRepo.getIssueProjectId(params.issueId, database);
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
      await crudRepo.insertWorkspaceRecordRow({
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
      }, database);
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

  /**
   * Best-effort context-packer run. Returns the primer text, or null when packing
   * is empty or fails — packing must never block workspace creation.
   */
  async function packContextPrimer(
    input: CreateWorkspaceInput,
    issue: { title: string; description: string | null; projectId: string },
    project: { repoPath: string },
  ): Promise<string | null> {
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
      if (packed.primer.trim()) return packed.primer;
    } catch (err) {
      console.warn(`[workspaces] context-packer failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  /**
   * Inject ticket details (+ optional context primer + detected stack profile) into
   * the worktree as a gitignored CLAUDE.local.md so the agent's first turn has the
   * spec without foraging. Returns the file path. The stack-profile read is
   * best-effort — a failure there must not block creation.
   */
  async function writeWorktreeTicketContext(
    worktreePath: string,
    issue: { issueNumber: number | null; title: string; description: string | null; projectId: string },
    contextPrimer: string | null,
  ): Promise<string | null> {
    let stackProfile = null;
    try {
      stackProfile = await getStackProfile(issue.projectId, database);
    } catch (err) {
      console.warn(`[workspaces] stack-profile read failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    return writeTicketContextFile(worktreePath, {
      issueNumber: issue.issueNumber,
      title: issue.title,
      description: issue.description,
      contextPrimer,
      stackProfile,
    });
  }

  /**
   * Build the agent prompt and resolve the effective skill. Merges the base prompt
   * with the issue's configurable workflow (start-node guidance + transitions) and
   * resolves the skill from explicit input → workflow node → project default,
   * materializing the chosen skill file into the worktree. Returns the prompt, the
   * resolved skill name (for session attribution), and the effective skill id (for
   * the workspace row).
   */
  async function resolveAgentPromptAndSkill(params: {
    issue: { projectId: string; issueNumber: number | null; title: string; description: string | null; priority: string | null };
    input: CreateWorkspaceInput;
    includeVisualProof: boolean;
    workspaceId: string;
    worktreePath: string | null;
    project: { repoPath: string; defaultSkillId: string | null };
    skillId: string | null;
  }): Promise<{ agentPrompt: string; skillName: string | null; effectiveSkillId: string | null; hasWorkflowStart: boolean }> {
    const { issue, input, includeVisualProof, workspaceId, worktreePath, project, skillId } = params;
    let agentPrompt = buildAgentPrompt(issue, { ...input, includeVisualProof }, input.issueId);

    // Resolve the issue's configurable workflow (if any). The start node's
    // guidance + valid transitions are injected into the prompt, and its
    // attached skill is used when the caller didn't pick one explicitly.
    const workflowStart = await resolveWorkflowStart(database, input.issueId);
    let effectiveSkillId = skillId;
    let effectiveDiskSkill = input.skillName ?? null;
    if (workflowStart) {
      agentPrompt += `\n\n${buildTransitionBlock(workflowStart.node, workflowStart.transitions, workspaceId)}`;
      if (!effectiveSkillId && !effectiveDiskSkill) {
        effectiveSkillId = workflowStart.node.skillId ?? null;
        effectiveDiskSkill = workflowStart.node.skillName ?? null;
      }
    }

    // Fall back to the project-level default skill so Insights "By Skill" can
    // attribute sessions even when no explicit skill was chosen and the issue has
    // no workflow that provides one.
    if (!effectiveSkillId && !effectiveDiskSkill && project.defaultSkillId) {
      effectiveSkillId = project.defaultSkillId;
    }

    const skillName = worktreePath
      ? await resolveSkillFile(effectiveSkillId, effectiveDiskSkill, worktreePath, project.repoPath)
      : null;

    return { agentPrompt, skillName, effectiveSkillId, hasWorkflowStart: Boolean(workflowStart) };
  }

  /**
   * Launch the builder agent OFF the hot path (setImmediate) so the HTTP response
   * flushes before any long-running git/binary work begins (same pattern as the
   * merge endpoint, #578). A deferred launch failure can't reach createWorkspace's
   * catch block, so it's handled here: persist the error + downgrade the workspace
   * status, and surface a Butler event when a stale safety policy blocked it.
   */
  function scheduleDeferredAgentLaunch(
    agentLaunchArgs: Parameters<typeof launchAgent>[0],
    ctx: { workspaceId: string; projectId: string; timing: (phase: string, startMs: number) => void },
  ): void {
    const { workspaceId, projectId, timing } = ctx;
    setImmediate(() => {
      const t = Date.now();
      void launchAgent(agentLaunchArgs)
        .then(() => timing("agent-launch", t))
        .catch((err: unknown) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const staleSafetyPolicy =
            err instanceof WorkspaceError && err.data?.code === "STALE_SAFETY_POLICY";
          const persistedError = staleSafetyPolicy ? `STALE_SAFETY_POLICY: ${errorMsg}` : errorMsg;
          const nextStatus = staleSafetyPolicy ? "error" : "idle";
          console.error(`[workspaces] deferred agent launch failed for workspace ${workspaceId}: ${errorMsg}`);
          if (staleSafetyPolicy) {
            emitButlerSystemEvent({
              projectId,
              kind: "workspace_error",
              workspaceId,
              text: `Workspace launch blocked by stale safety policy for ${workspaceId}: ${errorMsg.slice(0, 200)}`,
            });
          }
          crudRepo.updateWorkspaceLaunchFailure(workspaceId, {
            status: nextStatus,
            latestLaunchError: persistedError,
            updatedAt: new Date().toISOString(),
          }, database)
            .catch((dbErr: unknown) => console.warn(`[workspaces] failed to update workspace status after deferred launch failure: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`));
        });
    });
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

    const phaseStart = Date.now();
    const timing = (phase: string, startMs: number) =>
      console.log(`[workspaces-timing] workspaceId=${id} phase=${phase} durationMs=${Date.now() - startMs}`);

    try {
      let t = Date.now();
      const { issue, project, setupConfig, symlinkConfig } = await resolveIssueAndProject(input.issueId);
      timing("resolve-issue", t);
      repoPath = project.repoPath;

      await assertNoOpenDirectWorkspaceForIssue(input.issueId);

      // Default plan mode on for high/critical priority when not explicitly set.
      // This ensures expensive misunderstandings are caught before implementation begins.
      const isHighPriority = issue.priority === "high" || issue.priority === "critical";
      planMode = input.planMode !== undefined ? input.planMode === true : isHighPriority;

      t = Date.now();
      ({ branch, worktreePath, baseBranch, baseCommitSha, latestSetup, setupCompletion, symlinkRun: latestSymlink } = await setupWorktree(
        isDirect, project.repoPath, project.defaultBranch, input, setupConfig, symlinkConfig, id, issue,
      ));
      timing("worktree-setup", t);

      // Run context packer (best-effort: never blocks workspace creation).
      let contextPrimer: string | null = null;
      if (!isDirect && !input.skipContextPacker) {
        t = Date.now();
        contextPrimer = await packContextPrimer(input, issue, project);
        timing("context-packer", t);
      }

      // Inject ticket details (+ optional context primer + stack profile) into the
      // worktree as a gitignored `CLAUDE.local.md`. Skipped for direct workspaces.
      const ticketContextPath = !isDirect && worktreePath
        ? await writeWorktreeTicketContext(worktreePath, issue, contextPrimer)
        : null;

      const { agentPrompt, skillName, effectiveSkillId, hasWorkflowStart } = await resolveAgentPromptAndSkill({
        issue, input, includeVisualProof, workspaceId: id, worktreePath, project, skillId,
      });

      const agentConfig = await buildAgentConfig(input, issue.projectId);
      claudeProfile = agentConfig.claudeProfile;
      agentCommand = agentConfig.agentCommand;
      resolvedProvider = agentConfig.resolvedProvider;

      t = Date.now();
      await insertWorkspaceRecord({
        id, issueId: input.issueId, branch, worktreePath, baseBranch, isDirect,
        baseCommitSha, requiresReview, thoroughReview, planMode, tddMode, includeVisualProof,
        skillId: effectiveSkillId, claudeProfile, agentCommand, resolvedProvider, model: agentConfig.model,
        contextPrimer, latestSetup, latestSymlink, now,
      });
      workspaceInserted = true;
      timing("db-insert", t);

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
      if (hasWorkflowStart) {
        await initWorkspaceWorkflow(database, { workspaceId: id, issueId: input.issueId }).catch(() =>
          moveIssueToInProgress(input.issueId, issue.projectId, now, database),
        );
      } else {
        await moveIssueToInProgress(input.issueId, issue.projectId, now, database);
      }

      timing("total", phaseStart);

      boardEvents?.broadcast(issue.projectId, "workspace_created");

      // Defer agent launch off the hot path so the HTTP response is sent before any
      // long-running git/binary operations begin.  setImmediate ensures the Hono
      // response write (including the JSON body flush) happens before the first tick
      // of launchAgent — the same pattern used by the merge endpoint fix (#578).
      const agentLaunchArgs = {
        workspaceId: id, branch, isDirect, agentPrompt,
        agentCommand, agentArgs: agentConfig.agentArgs,
        resolvedProfile: agentConfig.resolvedProfile,
        permissionPromptTool: agentConfig.permissionPromptTool,
        planMode, resolvedProvider,
        resolvedProfileSelection: agentConfig.resolvedProfileSelection,
        model: agentConfig.model,
        systemInstructions: agentConfig.systemInstructions,
        contextFiles: ticketContextPath ? [ticketContextPath] : undefined,
        skillName,
      };
      scheduleDeferredAgentLaunch(agentLaunchArgs, { workspaceId: id, projectId: issue.projectId, timing });

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
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      // Agent launch is now deferred (setImmediate), so failures there are handled
      // in the background callback and never reach this catch block. Only pre-return
      // failures (worktree setup, DB insert, workflow init) land here.
      return handleCreateFailure(err, {
        id, issueId: input.issueId, branch, worktreePath, repoPath, baseBranch, isDirect,
        baseCommitSha, requiresReview, thoroughReview, planMode, includeVisualProof,
        claudeProfile, agentCommand, resolvedProvider, now,
      });
    }
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
    ports: { serverPort: number; clientPort: number } | null;
    blockedBy: { issueNumber: number; title: string }[];
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
      branch = input.branch || suggestBranchName(issue);
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
      const skillRows = await crudRepo.getAgentSkillNameById(skillId, database);
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
    const existingWs = await crudRepo.findExistingWorkspacesForIssue(input.issueId, database);
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
      const prefRows = await crudRepo.getAllPreferences(database);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      const profileCheck = preflightAgentProfile(prefMap, provider, name);
      if (!profileCheck.ok) {
        for (const err of profileCheck.errors) {
          warnings.push(`Profile unavailable: ${err}`);
        }
      }
    }

    // 11. Dependency blocking check
    const BLOCKING_DEP_TYPES = ["depends_on", "blocked_by"] as const;
    const depRows = await crudRepo.getDependenciesForIssue(input.issueId, database);

    const blockerIds = depRows
      .filter(d => BLOCKING_DEP_TYPES.includes(d.type as typeof BLOCKING_DEP_TYPES[number]))
      .map(d => d.dependsOnId);

    let blockedBy: { issueNumber: number; title: string }[] = [];
    if (blockerIds.length > 0) {
      const blockerIssues = await crudRepo.getBlockerIssues(blockerIds, database);

      blockedBy = blockerIssues
        .filter(b => !isResolvedDependencyStatusView({ statusName: b.statusName, currentNodeId: b.currentNodeId, currentNodeType: b.currentNodeType }))
        .map(b => ({ issueNumber: b.issueNumber!, title: b.title }));
    }

    // 12. Derive expected worktree ports from the branch name (null for direct workspaces)
    let ports: { serverPort: number; clientPort: number } | null = null;
    if (!isDirect && branch) {
      ports = derivePortsFromBranch(branch);
    }

    // 13. Budget estimation (non-blocking — never throws)
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
      ports,
      blockedBy,
    };
  }

  return {
    createWorkspace,
    computeLaunchPreview,
  };
}
