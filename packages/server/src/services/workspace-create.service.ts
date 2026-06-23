/**
 * Workspace creation + launch-preview, extracted from workspace-crud.service.ts.
 *
 * This owns the create ORCHESTRATION: resolving the issue/project, inserting the
 * DB row, moving the issue to In Progress, and deferring the agent launch off the
 * hot path. The side-effecting worktree provisioning + agent-config/prompt/skill
 * resolution it sequences live in workspace-provision.service.ts (instantiated
 * below). computeLaunchPreview is the read-only dry-run of that same pipeline. The
 * crud service instantiates this factory and delegates the two public methods,
 * passing the same injected deps so gitService stays substitutable in tests.
 */

import { randomUUID } from "node:crypto";
import { isResolvedDependencyStatusView } from "@agentic-kanban/shared/lib/status-view";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { derivePortsFromBranch } from "./worktree-ports.js";
import { withTransaction, type Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import type { ProviderName } from "./agent-provider.js";
import { estimateBudget } from "./budget-estimator.service.js";
import type { BudgetEstimate } from "./budget-estimator.service.js";
import {
  skippedSetupRun,
  disabledSymlinkRun,
  type LatestSetupRun,
  type LatestSymlinkRun,
} from "./workspace-run-records.js";
import { parseSymlinkDirs } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import { initWorkspaceWorkflow } from "@agentic-kanban/shared/lib/workflow-engine";
import { toExecutorProvider } from "./agent-settings.service.js";
import { preflightAgentProfile } from "./agent-profile-health.service.js";
import { emitButlerSystemEvent } from "./butler-event-feed.js";
import { moveIssueToInProgressStrict } from "../repositories/workspace.repository.js";
import {
  WorkspaceError,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
  type GitService,
} from "./workspace-internals.js";
import { createWorkspaceProvisionService } from "./workspace-provision.service.js";

export function createWorkspaceCreateService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService: GitService;
}) {
  const { database, getSessionManager, boardEvents, gitService } = deps;

  // Worktree provisioning + agent-config/prompt/skill resolution live in a sibling
  // service sharing database + gitService.
  const provision = createWorkspaceProvisionService({ database, gitService });
  const {
    setupWorktree,
    buildAgentConfig,
    installTddHook,
    packContextPrimer,
    writeWorktreeTicketContext,
    resolveAgentPromptAndSkill,
  } = provision;

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
    database?: Database;
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
    }, params.database ?? database);
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

    return {
      id: params.id,
      issueId: params.issueId,
      branch: params.branch,
      workingDir: params.worktreePath,
      baseBranch: params.baseBranch,
      isDirect: params.isDirect,
      planMode: params.planMode,
      includeVisualProof: params.includeVisualProof,
      status: "error",
      provider: params.resolvedProvider,
      createdAt: params.now,
      updatedAt: params.now,
      error: errorMsg,
    };
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
      await withTransaction(database, async (tx) => {
        await insertWorkspaceRecord({
          id, issueId: input.issueId, branch, worktreePath, baseBranch, isDirect,
          baseCommitSha, requiresReview, thoroughReview, planMode, tddMode, includeVisualProof,
          skillId: effectiveSkillId, claudeProfile, agentCommand, resolvedProvider, model: agentConfig.model,
          contextPrimer, latestSetup, latestSymlink, now, database: tx,
        });

        // Place the workspace on the workflow start node + sync the derived status.
        // Any failure here rolls back the workspace row inserted above.
        if (hasWorkflowStart) {
          await initWorkspaceWorkflow(tx, { workspaceId: id, issueId: input.issueId });
        } else {
          await moveIssueToInProgressStrict(input.issueId, issue.projectId, now, tx);
        }
      }, "workspace create db writes");
      timing("db-writes", t);

      if (setupCompletion) {
        setupCompletion
          .then((run) => updateLatestSetupRun(id, run, issue.projectId))
          .catch((err) => console.warn(`[workspaces] failed to persist setup status: ${err instanceof Error ? err.message : String(err)}`));
      }

      if (tddMode && worktreePath) {
        installTddHook(worktreePath);
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
