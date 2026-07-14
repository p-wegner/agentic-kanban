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
import { workspaceServicesService, resolveServiceHost } from "./workspace-services.service.js";
import { provisionServicesForLaunch } from "./workspace-create-stack.service.js";
import type { ServiceStackState } from "@agentic-kanban/shared";
import type { TicketContext } from "@agentic-kanban/shared/lib/ticket-context";
import { withTransaction, type Database, type TransactionClient } from "../db/index.js";
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
import type { WorkflowDb } from "@agentic-kanban/shared/lib/workflow-engine";
import { toExecutorProvider } from "./agent-settings.service.js";
import { preflightAgentProfile } from "./agent-profile-health.service.js";
import { emitButlerSystemEvent } from "./butler-event-feed.js";
import { moveIssueToInProgressStrict } from "../repositories/workspace.repository.js";
import {
  updateWorkspaceServiceState,
  getWorkspaceLifecycleStatus,
} from "../repositories/workspace-service-state.repository.js";
import {
  WorkspaceError,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
  type GitService,
} from "./workspace-internals.js";
import { createWorkspaceProvisionService } from "./workspace-provision.service.js";
import {
  provisionSiblingWorktrees,
  insertSiblingWorktreeRecords,
  rollbackSiblingWorktrees,
  type SiblingWorktree,
} from "./workspace-repos.service.js";

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
    project: { repoPath: string; defaultBranch: string | null; defaultSkillId: string | null; servicesConfig: string | null };
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
      project: { repoPath: projectRow.repoPath, defaultBranch: projectRow.defaultBranch, defaultSkillId: projectRow.defaultSkillId ?? null, servicesConfig: projectRow.servicesConfig ?? null },
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
    serviceState: string | null;
    latestSetup: LatestSetupRun;
    latestSymlink: LatestSymlinkRun;
    now: string;
    database?: Database | TransactionClient;
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
      serviceState: params.serviceState,
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

  /**
   * Compensating rollback for the on-disk git worktree + branch provisioned by
   * setupWorktree BEFORE the DB transaction opens. Cross-resource atomicity gap
   * (#893): if anything after provisioning throws (txn rollback, workflow-init
   * failure, or a WorkspaceError surfaced from agent-config resolution), the
   * worktree directory + branch persist with no backing DB row — an orphan the
   * board can't see or cascade-clean. Removing it here is the compensation step.
   *
   * No-op for direct workspaces (they reuse the main checkout — there is nothing
   * to remove) and when no worktree was provisioned (failure happened earlier).
   * Best-effort: a failed removal is logged, never re-thrown, so it can't mask the
   * original error.
   */
  async function rollbackOrphanedWorktree(
    isDirect: boolean,
    worktreePath: string | null,
    repoPath: string | null,
  ): Promise<void> {
    if (isDirect || !worktreePath || !repoPath) return;
    try {
      await gitService.removeWorktree(repoPath, worktreePath);
      console.log(`[workspaces] cleaned up orphaned worktree: ${worktreePath}`);
    } catch (cleanupErr) {
      console.warn(`[workspaces] failed to remove worktree after create error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
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

    await rollbackOrphanedWorktree(params.isDirect, params.worktreePath, params.repoPath);

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
   * OFF the HTTP hot path (setImmediate, same pattern as the merge endpoint #578), and
   * AFTER the workspace row exists: provision the service stack (#F3b — the up to 120s
   * `up --wait` no longer blocks the 201), persist its state, write the (service-aware)
   * ticket-context, then launch the builder agent. A failure here can't reach
   * createWorkspace's catch block, so it's handled locally: persist the error + downgrade
   * status, and surface a Butler event when a stale safety policy blocked it.
   */
  function scheduleDeferredProvisionAndLaunch(
    agentLaunchArgs: Parameters<typeof launchAgent>[0],
    ctx: {
      workspaceId: string;
      projectId: string;
      isDirect: boolean;
      worktreePath: string | null;
      servicesConfigRaw: string | null;
      branch: string;
      createdAt: string;
      siblings: SiblingWorktree[];
      issue: { issueNumber: number | null; title: string; description: string | null; projectId: string };
      contextPrimer: string | null;
      timing: (phase: string, startMs: number) => void;
    },
  ): void {
    const { workspaceId, projectId, timing } = ctx;
    setImmediate(() => {
      void (async () => {
        // 1. Provision the service stack (off the hot path) and persist its state. No-op
        //    (null, no fs/docker) when the project declares no enabled stack — so the
        //    common no-stack deferred path is launch-only.
        let serviceState: ServiceStackState | null = null;
        // Shared-worktree ADOPTION (finding 12): an adopted state records a CO-RESIDENT
        // workspace's stack — this workspace never owns it, so the convergence teardowns
        // below must never down it (the engine's last-reference guard is the backstop).
        let stackAdopted = false;
        if (!ctx.isDirect && ctx.worktreePath) {
          const t = Date.now();
          const provisioned = await provisionServicesForLaunch(database, {
            servicesConfigRaw: ctx.servicesConfigRaw,
            workspaceId,
            workspaceCreatedAt: ctx.createdAt,
            branch: ctx.branch,
            leadingWorktreePath: ctx.worktreePath,
            siblings: ctx.siblings,
          });
          serviceState = provisioned?.state ?? null;
          stackAdopted = provisioned?.adopted ?? false;
          if (serviceState) {
            timing("service-stack", t);
            if (serviceState.status === "error") {
              console.warn(`[services] stack for branch ${ctx.branch} came up with status=error: ${serviceState.error ?? ""}`);
              // Surface the failure via the Butler feed too — a non-throwing error
              // state never reaches the deferred catch handler below (#20).
              emitButlerSystemEvent({
                projectId,
                kind: "workspace_error",
                workspaceId,
                text: `Service stack failed to start for branch ${ctx.branch}: ${(serviceState.error ?? "unknown error").slice(0, 200)}`,
              });
            }
            let persistedRows = 0;
            try {
              persistedRows = await updateWorkspaceServiceState(workspaceId, stringifyJson(serviceState), database);
              if (persistedRows > 0) boardEvents?.broadcast(projectId, "workspace_setup");
            } catch (dbErr) {
              // #F5b: if the state can't be persisted, no teardown path can find the stack
              // (they all gate on the STORED state) — it would orphan. Tear it down now.
              // Never for an ADOPTED stack: the co-resident owner still references it.
              console.warn(`[services] failed to persist service_state for ${workspaceId}; ${stackAdopted ? "adopted stack left to its owner" : "tearing the stack down to avoid an orphan"}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
              if (serviceState.status === "up" && !stackAdopted) {
                await workspaceServicesService.teardownWorkspaceServices({
                  composeProjectName: serviceState.composeProjectName,
                  composeWorktreePath: ctx.worktreePath,
                  releasedByWorkspaceId: workspaceId,
                });
              }
              serviceState = null;
            }

            // A 0-row persist means the workspace was DELETED or closed/merged during
            // the long `up --wait` window: its delete/close teardown ran BEFORE the
            // state existed, so nothing else will ever down the fresh stack (#F5c).
            // Converge here — tear it down (unless it is a co-resident's ADOPTED stack,
            // which the owner still references) and abandon the rest of the launch chain.
            if (serviceState && persistedRows === 0) {
              console.warn(`[services] workspace ${workspaceId} was deleted/closed during service provisioning; ${stackAdopted ? "leaving the adopted co-resident stack up" : "tearing the stack down"} and skipping the agent launch`);
              if (serviceState.status === "up" && !stackAdopted) {
                await workspaceServicesService.teardownWorkspaceServices({
                  composeProjectName: serviceState.composeProjectName,
                  composeWorktreePath: ctx.worktreePath,
                  releasedByWorkspaceId: workspaceId,
                });
              }
              return;
            }

            // 2. REWRITE the ticket-context (already written pre-insert, minus the
            //    service section): on "up" add the running-stack section (host+ports);
            //    on "error" add an explicit stack-FAILED note so the agent knows the
            //    declared services are absent instead of burning the session against a
            //    missing database (#20).
            if (serviceState && ctx.worktreePath) {
              const stackSection: NonNullable<TicketContext["serviceStack"]> =
                serviceState.status === "up"
                  ? {
                      ports: serviceState.ports,
                      envFilePath: serviceState.envFilePath,
                      composeProjectName: serviceState.composeProjectName,
                      serviceHost: resolveServiceHost(),
                    }
                  : {
                      status: "error",
                      error: serviceState.error ?? null,
                      ports: serviceState.ports,
                      envFilePath: serviceState.envFilePath,
                      composeProjectName: serviceState.composeProjectName,
                      serviceHost: resolveServiceHost(),
                    };
              await writeWorktreeTicketContext(
                ctx.worktreePath,
                ctx.issue,
                ctx.contextPrimer,
                ctx.siblings.map((s) => ({ name: s.name, worktreePath: s.worktreePath })),
                stackSection,
              );
            }
          }
        }

        // 3. Launch the builder agent — after re-checking the workspace still exists
        //    and is open: it may have been deleted or closed while the (up to 120s)
        //    provisioning ran, and an agent must never launch into a removed workspace.
        const lifecycle = await getWorkspaceLifecycleStatus(workspaceId, database);
        if (!lifecycle || lifecycle.status === "closed" || lifecycle.status === "merged") {
          console.warn(`[workspaces] workspace ${workspaceId} is ${lifecycle ? lifecycle.status : "deleted"} — skipping the deferred agent launch`);
          return;
        }
        const t2 = Date.now();
        await launchAgent(agentLaunchArgs);
        timing("agent-launch", t2);
      })().catch((err: unknown) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const staleSafetyPolicy =
          err instanceof WorkspaceError && err.data?.code === "STALE_SAFETY_POLICY";
        const persistedError = staleSafetyPolicy ? `STALE_SAFETY_POLICY: ${errorMsg}` : errorMsg;
        const nextStatus = staleSafetyPolicy ? "error" : "idle";
        console.error(`[workspaces] deferred provision/launch failed for workspace ${workspaceId}: ${errorMsg}`);
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
    // Sibling worktrees provisioned for the project's additional repos (multi-repo);
    // hoisted so the catch block can roll them back alongside the leading worktree.
    let siblingWorktrees: SiblingWorktree[] = [];

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

      // Multi-repo (full-peers): a worktree on the same branch in every additional
      // repo. No-op for single-repo projects and direct workspaces. A failure here
      // throws so the catch-block rollback removes leading + sibling worktrees.
      if (!isDirect) {
        t = Date.now();
        siblingWorktrees = await provisionSiblingWorktrees({ gitService, database, projectId: issue.projectId, branch });
        if (siblingWorktrees.length > 0) timing("sibling-worktrees", t);
      }

      // Per-workspace Docker service stack provisioning has MOVED off the HTTP hot path
      // (#F3b): the row is inserted with service_state null below, and the deferred step
      // (after the 201 flushes) provisions the stack, persists its state, and only then
      // launches the agent — so `up --wait` (up to 120s) never blocks the create response.

      // Run context packer (best-effort: never blocks workspace creation).
      let contextPrimer: string | null = null;
      if (!isDirect && !input.skipContextPacker) {
        t = Date.now();
        contextPrimer = await packContextPrimer(input, issue, project);
        timing("context-packer", t);
      }

      // Inject ticket details (+ context primer + stack profile) into the worktree as a
      // gitignored `CLAUDE.local.md`. Written WITHOUT the service-stack section here (the
      // stack isn't provisioned until the deferred step); the deferred step REWRITES this
      // file to add the running-stack section once the stack is up. Skipped for direct
      // workspaces. This write is cheap (never the hot-path cost — only `up --wait` was).
      const ticketContextPath = !isDirect && worktreePath
        ? await writeWorktreeTicketContext(
            worktreePath,
            issue,
            contextPrimer,
            siblingWorktrees.map((s) => ({ name: s.name, worktreePath: s.worktreePath })),
            null,
          )
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
          contextPrimer, serviceState: null,
          latestSetup, latestSymlink, now, database: tx,
        });

        // Multi-repo: per-repo worktree records ride the same transaction as the
        // workspace row, so a rollback leaves no dangling repo rows.
        if (siblingWorktrees.length > 0) {
          await insertSiblingWorktreeRecords(id, issue.projectId, siblingWorktrees, tx);
        }

        // Place the workspace on the workflow start node + sync the derived status.
        // Any failure here rolls back the workspace row inserted above.
        if (hasWorkflowStart) {
          await initWorkspaceWorkflow(tx as unknown as WorkflowDb, { workspaceId: id, issueId: input.issueId });
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

      // Defer service-stack provisioning + agent launch off the hot path so the HTTP
      // response is sent before any long-running work begins. setImmediate ensures the
      // Hono response write (including the JSON body flush) happens before the first tick
      // — the same pattern as the merge endpoint fix (#578). Provisioning lives here (not
      // pre-insert) so `up --wait` doesn't block the 201, and so the compose name is keyed
      // on the now-persisted workspace id (#F1).
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
      scheduleDeferredProvisionAndLaunch(agentLaunchArgs, {
        workspaceId: id,
        projectId: issue.projectId,
        isDirect,
        worktreePath,
        servicesConfigRaw: project.servicesConfig,
        branch,
        createdAt: now,
        siblings: siblingWorktrees,
        issue: { issueNumber: issue.issueNumber, title: issue.title, description: issue.description, projectId: issue.projectId },
        contextPrimer,
        timing,
      });

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
      if (err instanceof WorkspaceError) {
        // A WorkspaceError raised AFTER the worktree was provisioned (e.g. an
        // agent-config WorkspaceError, or a workflow-init / move-to-In-Progress
        // failure inside the DB txn) would otherwise re-throw without removing the
        // on-disk worktree+branch, leaving an orphan with no backing row (#893).
        // Compensate first, then surface the original WorkspaceError unchanged.
        await rollbackOrphanedWorktree(isDirect, worktreePath, repoPath);
        await rollbackSiblingWorktrees(gitService, siblingWorktrees);
        throw err;
      }
      // Agent launch is now deferred (setImmediate), so failures there are handled
      // in the background callback and never reach this catch block. Only pre-return
      // failures (worktree setup, DB insert, workflow init) land here.
      await rollbackSiblingWorktrees(gitService, siblingWorktrees);
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
