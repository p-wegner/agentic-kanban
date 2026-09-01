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

import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { isTerminalWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { workspaceServicesService, resolveServiceHost } from "./workspace-services.service.js";
import { reapWorkspaceContainer } from "./devcontainer-workspace.service.js";
import { provisionServicesForLaunch } from "./workspace-create-stack.service.js";
import type { ServiceStackState } from "@agentic-kanban/shared";
import type { TicketContext } from "@agentic-kanban/shared/lib/ticket-context";
import { withTransaction, type Database, type TransactionClient } from "../db/index.js";
import type { SessionLauncher } from "./session.manager.js";
import type { BoardEventSink } from "./board-events.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import {
  beginProvisioning,
  finishProvisioning,
  updateProvisioning,
} from "../repositories/workspace-provisioning.repository.js";
import { warnIfBranchHeldByLiveWorkspace } from "./workspace-branch-holders.js";
import { warnIfWorktreePathNotRegistered } from "./workspace-worktree-reconcile.js";
import {
  claimBranchForCreate, releaseBranchForCreate, worktreeClaimPath, type BranchCreateClaimToken,
} from "./workspace-branch-create-claim.js";
import type { ProviderName } from "./agent-provider.js";
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
import { emitButlerSystemEvent } from "./butler-event-feed.js";
import { moveIssueToInProgressStrict } from "../repositories/workspace.repository.js";
import {
  insertWorkspaceIssueMembers,
  filterIssuesWithLiveGroupWorkspace,
} from "../repositories/workspace-issue-members.repository.js";
import { buildGroupPromptSection } from "./workspace-create/policy.js";
import { createWorkspaceCreateFailureHandler } from "./workspace-create/failure.js";
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
import { createLaunchPreviewService } from "./workspace-launch-preview.service.js";
import { getIssueReposTouched } from "./repo-tags.service.js";
import {
  provisionSiblingWorktrees,
  resolveSiblingInstallOptions,
  runBackgroundSiblingInstalls,
  resolveEffectiveRepoScope,
  insertSiblingWorktreeRecords,
  rollbackSiblingWorktrees,
  type SiblingWorktree,
} from "./workspace-repos.service.js";
import { insertWorkspaceSetupRun } from "../repositories/workspace-setup-run.repository.js";
import { insertWorkspaceSymlinkRun } from "../repositories/workspace-symlink-run.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export function createWorkspaceCreateService(deps: {
  database: Database;
  getSessionManager?: () => SessionLauncher;
  boardEvents?: BoardEventSink;
  gitService: GitService;
}) {
  const { database, getSessionManager, boardEvents, gitService } = deps;

  // Worktree provisioning + agent-config/prompt/skill resolution live in a sibling
  // service sharing database + gitService.
  const provision = createWorkspaceProvisionService({ database, gitService });
  const {
    setupWorktree,
    buildAgentConfig,
    installCommitMsgHook,
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
    /** Defaults to "active" — pass "blocked" when a blocking setup script failed (#169). */
    status?: string;
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
      status: params.status ?? "active",
      claudeProfile: params.claudeProfile ?? null,
      agentCommand: params.agentCommand ?? null,
      provider: params.resolvedProvider,
      model: params.model ?? null,
      contextPrimer: params.contextPrimer,
      serviceState: params.serviceState,
      createdAt: params.now,
      updatedAt: params.now,
    }, params.database ?? database);
    // #815: the setup run is its own table now — same handle, so it lands in the same
    // transaction as the workspace row. Written even for the `state: "skipped"` run a
    // project with no setup script produces: that is what the eight columns held, and the
    // projection distinguishes it from "no record at all".
    await insertWorkspaceSetupRun(params.id, {
      command: params.latestSetup.command,
      state: params.latestSetup.state,
      startedAt: params.latestSetup.startedAt,
      endedAt: params.latestSetup.endedAt,
      exitCode: params.latestSetup.exitCode,
      durationMs: params.latestSetup.durationMs,
      stdoutTail: params.latestSetup.stdoutTail,
      stderrTail: params.latestSetup.stderrTail,
    }, params.database ?? database);
    // #798: the symlink run is its own table now — written with the same handle, so it is
    // in the same transaction as the workspace row when the caller passes one. Written even
    // for the `state: "disabled"` run a project with the feature off produces: the columns
    // always carried it, and the diagnostics panel distinguishes "disabled" from "pending".
    await insertWorkspaceSymlinkRun(params.id, {
      state: params.latestSymlink.state,
      startedAt: params.latestSymlink.startedAt,
      endedAt: params.latestSymlink.endedAt,
      dirs: stringifyJson(params.latestSymlink.dirs),
      linked: stringifyJson(params.latestSymlink.linked),
      skipped: stringifyJson(params.latestSymlink.skipped),
      failed: stringifyJson(params.latestSymlink.failed),
      error: params.latestSymlink.error,
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

  /**
   * Ticket group (#661): validate and resolve the group's MEMBER issues. Members must
   * exist, belong to the lead's project, and not already be served — by an open
   * workspace of their own or by another live group. Duplicates and the lead itself
   * are dropped silently (callers may pass a whole coupled component).
   */
  async function resolveGroupMembers(
    input: CreateWorkspaceInput,
    leadProjectId: string,
  ): Promise<Array<{ id: string; issueNumber: number | null; title: string; description: string | null }>> {
    const unique = [...new Set(input.memberIssueIds ?? [])].filter((memberId) => memberId && memberId !== input.issueId);
    if (unique.length === 0) return [];

    const members: Array<{ id: string; issueNumber: number | null; title: string; description: string | null }> = [];
    for (const memberId of unique) {
      const rows = await crudRepo.getIssueForWorkspaceCreate(memberId, database);
      if (rows.length === 0) {
        throw new WorkspaceError(`Ticket-group member issue not found: ${memberId}`, "NOT_FOUND");
      }
      const member = rows[0];
      if (member.projectId !== leadProjectId) {
        throw new WorkspaceError(
          `Ticket-group member ${memberId} belongs to a different project than the lead issue — a group shares one worktree, so all members must live in one project.`,
          "CONFLICT",
          { code: "GROUP_MEMBER_WRONG_PROJECT", issueId: memberId },
        );
      }
      members.push({ id: memberId, issueNumber: member.issueNumber, title: member.title, description: member.description });
    }

    const openOwn = await crudRepo.findOpenWorkspacesForIssues(unique, database);
    if (openOwn.length > 0) {
      throw new WorkspaceError(
        `Ticket-group member already has an open workspace (issue ${openOwn[0].issueId} → workspace ${openOwn[0].id}, branch ${openOwn[0].branch}). Close it first, or start the group without that member.`,
        "CONFLICT",
        { code: "GROUP_MEMBER_HAS_WORKSPACE", workspaceId: openOwn[0].id, issueId: openOwn[0].issueId },
      );
    }
    const inLiveGroup = await filterIssuesWithLiveGroupWorkspace(unique, database);
    if (inLiveGroup.size > 0) {
      const first = [...inLiveGroup][0];
      throw new WorkspaceError(
        `Ticket-group member ${first} is already served as a member of another live group workspace.`,
        "CONFLICT",
        { code: "GROUP_MEMBER_IN_LIVE_GROUP", issueId: first },
      );
    }
    return members;
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

  const { rollbackOrphanedWorktree, handleCreateFailure } =
    createWorkspaceCreateFailureHandler({ gitService, database });

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
      /** #628 — the per-repo install timeout, for the deferred background install run. */
      installTimeoutMs?: number;
      issue: { issueNumber: number | null; title: string; description: string | null; projectId: string };
      contextPrimer: string | null;
      /** Ticket group (#661): member tickets, preserved across the service-stack rewrite. */
      groupTickets?: Array<{ issueNumber: number | null; title: string; description: string | null }>;
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
            if (serviceState.status === "error" && serviceState.deferred) {
              // A deliberate capacity deferral (#56), not a failure — log calmly and do
              // NOT raise a workspace_error alarm on the Butler feed.
              console.log(`[services] stack for branch ${ctx.branch} deferred (admission cap): ${serviceState.error ?? ""}`);
            } else if (serviceState.status === "error") {
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
              console.warn(`[services] failed to persist service_state for ${workspaceId}; ${stackAdopted ? "adopted stack left to its owner" : "tearing the stack down to avoid an orphan"}: ${errorMessage(dbErr)}`);
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
              // #576: the devcontainer provisioned by setupWorktree leaks for exactly the
              // same reason the stack does — the delete/close teardown ran before this
              // workspace had anything for it to find. The stack teardown above is gated
              // on an ADOPTED stack (a co-resident still uses it); the container is not
              // shared that way, so it is always ours to reap.
              try {
                if (ctx.worktreePath) await reapWorkspaceContainer({ worktreePath: ctx.worktreePath, workspaceId });
              } catch (err) {
                console.warn(`[services] container reap failed (non-fatal) for ${workspaceId}: ${errorMessage(err)}`);
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
                      lintWarnings: serviceState.lintWarnings ?? null,
                    }
                  : {
                      status: "error",
                      error: serviceState.error ?? null,
                      ports: serviceState.ports,
                      envFilePath: serviceState.envFilePath,
                      composeProjectName: serviceState.composeProjectName,
                      serviceHost: resolveServiceHost(),
                      lintWarnings: serviceState.lintWarnings ?? null,
                    };
              await writeWorktreeTicketContext(
                ctx.worktreePath,
                ctx.issue,
                ctx.contextPrimer,
                ctx.siblings.map((s) => ({ name: s.name, worktreePath: s.worktreePath })),
                stackSection,
                ctx.groupTickets,
              );
            }
          }
        }

        // 3. Launch the builder agent — after re-checking the workspace still exists
        //    and is open: it may have been deleted or closed while the (up to 120s)
        //    provisioning ran, and an agent must never launch into a removed workspace.
        const lifecycle = await getWorkspaceLifecycleStatus(workspaceId, database);
        if (!lifecycle || isTerminalWorkspaceStatus(lifecycle.status)) {
          console.warn(`[workspaces] workspace ${workspaceId} is ${lifecycle ? lifecycle.status : "deleted"} — skipping the deferred agent launch`);
          return;
        }
        // #628 — the deferred dependency installs. Started BEFORE the launch and deliberately
        // NOT awaited: the whole point is that the agent reads its first file in seconds
        // instead of 30-60 minutes into a 17-repo install run. Each repo's row moves
        // pending -> running -> done|failed as it goes, and the merge gate refuses to land
        // the branch while any of them is outstanding or failed.
        if (ctx.siblings.some((sib) => sib.installDeferred)) {
          void runBackgroundSiblingInstalls({
            workspaceId,
            projectId,
            siblings: ctx.siblings,
            database,
            installMode: "background",
            installTimeoutMs: ctx.installTimeoutMs,
            onProgress: () => boardEvents?.broadcast(projectId, "workspace_setup"),
          }).catch((err: unknown) => {
            console.warn(`[workspaces] background sibling installs failed for ${workspaceId}: ${errorMessage(err)}`);
          });
        }

        const t2 = Date.now();
        await launchAgent(agentLaunchArgs);
        timing("agent-launch", t2);
      })().catch((err: unknown) => {
        const errorMsg = errorMessage(err);
        const staleSafetyPolicy =
          err instanceof WorkspaceError && err.data?.code === "STALE_SAFETY_POLICY";
        const persistedError = staleSafetyPolicy ? `STALE_SAFETY_POLICY: ${errorMsg}` : errorMsg;
        console.error(`[workspaces] deferred provision/launch failed for workspace ${workspaceId}: ${errorMsg}`);
        emitButlerSystemEvent({
          projectId,
          kind: "workspace_error",
          workspaceId,
          text: staleSafetyPolicy
            ? `Workspace launch blocked by stale safety policy for ${workspaceId}: ${errorMsg.slice(0, 200)}`
            : `Deferred provision/launch failed for workspace ${workspaceId}: ${errorMsg.slice(0, 200)}`,
        });
        // #859: EVERY deferred failure lands in "error" with the reason persisted — never a
        // bare "idle". An idle row with a null launch error reads as "paused on purpose":
        // nothing relaunches it, the launch-failures panel cannot classify it, and the
        // observed incident had the workspace sit dead while looking healthy until a
        // sweeper mistook its worktree for an orphan. "error" is the state this path
        // already used for the stale-safety refusal, and `latestLaunchError` is what
        // `getWorkspaceLaunchFailures` classifies as `preflight-failed`.
        crudRepo.updateWorkspaceLaunchFailure(workspaceId, {
          status: "error",
          latestLaunchError: persistedError,
          updatedAt: new Date().toISOString(),
        }, database)
          .then((written) => {
            if (!written) {
              console.warn(`[workspaces] deferred launch failure for ${workspaceId} was NOT persisted (status write matched no row — closed/deleted concurrently?); the failure above is only in this log`);
            }
          })
          .catch((dbErr: unknown) => console.warn(`[workspaces] failed to update workspace status after deferred launch failure: ${errorMessage(dbErr)}`));
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
    // #628 — resolved inside the multi-repo branch below, read again by the deferred
    // background install run, which happens after this scope has returned.
    let siblingInstallTimeoutMs: number | undefined;
    // #630: whether the in-flight marker exists, so both exits can clear it exactly once.
    let provisioningMarked = false;
    // #673/#736: the token for the worktree-directory claim this call took, so the `finally`
    // below releases exactly THIS claim — never a successor's, after a TTL takeover.
    let createClaim: BranchCreateClaimToken | null = null;

    const phaseStart = Date.now();
    const timing = (phase: string, startMs: number) =>
      console.log(`[workspaces-timing] workspaceId=${id} phase=${phase} durationMs=${Date.now() - startMs}`);

    try {
      let t = Date.now();
      const { issue, project, setupConfig, symlinkConfig } = await resolveIssueAndProject(input.issueId);
      timing("resolve-issue", t);
      repoPath = project.repoPath;

      // Ticket group (#661): resolve + validate member issues BEFORE any disk work, so a
      // bad group fails as a clean 4xx rather than after minutes of provisioning.
      const groupMembers = await resolveGroupMembers(input, issue.projectId);

      t = Date.now();
      await assertNoOpenDirectWorkspaceForIssue(input.issueId);
      // #673 item 1: claim the WORKTREE DIRECTORY this create will provision BEFORE the
      // DB-based live-workspace read below — that read is blind to a still-provisioning
      // sibling create for 80s–8+ minutes, which is how #670 got two workspaces on one
      // worktree 9s apart. No `await` between resolving the branch and claiming it is what
      // makes this atomic against another in-process create for the same directory. #736:
      // the key is the resolved `.worktrees/<repoDirName>/<leaf>` path (`project.repoPath`
      // is already in hand, synchronously), so an explicit branch naming ANOTHER issue's
      // number contends correctly too; a branch resolving to a DIFFERENT directory (provider
      // showdown, #366) is still untouched.
      if (!isDirect) {
        const branchForClaim = input.branch || suggestBranchName(issue);
        const claimPath = worktreeClaimPath(project.repoPath, branchForClaim);
        createClaim = claimBranchForCreate({ repoPath: project.repoPath, issueId: input.issueId, branch: branchForClaim });
        if (!createClaim) {
          throw new WorkspaceError(
            `A workspace creation is already in flight for the worktree directory "${claimPath}", which issue ${input.issueId} on branch "${branchForClaim}" resolves to. Every branch of one issue collapses to that one directory (ak-<issue-number>), so two creates cannot provision it at once even when their branches deliberately differ. Wait for the in-flight create to finish; the next create then takes the "-2" alternative directory and can proceed.`,
            "CONFLICT",
            { code: "BRANCH_CREATE_IN_FLIGHT", issueId: input.issueId, branch: branchForClaim, worktreePath: claimPath },
          );
        }
        await warnIfBranchHeldByLiveWorkspace(branchForClaim, database);
      }
      timing("assert-no-open-direct", t);

      // Default plan mode on for high/critical priority when not explicitly set.
      // This ensures expensive misunderstandings are caught before implementation begins.
      const isHighPriority = issue.priority === "high" || issue.priority === "critical";
      planMode = input.planMode !== undefined ? input.planMode === true : isHighPriority;

      // Resolve the effective agent profile BEFORE provisioning the worktree/devcontainer
      // (#155): setupWorktree's devcontainer provision call and the launch-time call in
      // session-lifecycle.ts must agree on the profile, because `devcontainer up` reuses an
      // existing container and its creation-time mounts win — a setup-path call that
      // provisions with a different (or no) profile freezes the WRONG profile mount for the
      // container's whole lifetime, regardless of what the later launch resolves to.
      t = Date.now();
      const agentConfig = await buildAgentConfig(input, issue.projectId);
      // The project's profile allowlist permits nothing right now. Refusing here — before
      // the worktree exists — is the whole point of the restriction: launching on the
      // next-best profile would spend the wrong subscription, which for a project pinned
      // to a client account is worse than not running at all.
      if (agentConfig.profileHold) {
        throw new WorkspaceError(
          `Profile allowlist blocks this launch: ${agentConfig.profileHold}. Wait for an allowed profile to become available, or change the project's allowed profiles.`,
          "CONFLICT",
          { code: "PROFILE_ALLOWLIST_HOLD", projectId: issue.projectId },
        );
      }
      // #876: the resolved profile does not carry a data-handling tag the project
      // requires (e.g. "no-training"). Refused the same way as the allowlist hold above
      // and for the same reason — the profile pool that satisfies this is an operator
      // decision (tag the profile, or change the requirement), not something a launch
      // can silently work around.
      if (agentConfig.dataHandlingHold) {
        throw new WorkspaceError(
          `Data-handling requirement blocks this launch: ${agentConfig.dataHandlingHold}. Tag a compliant profile ` +
            `via its profile_capabilities preference, or change the project's required data labels.`,
          "CONFLICT",
          { code: "DATA_HANDLING_REQUIREMENT_HOLD", projectId: issue.projectId },
        );
      }
      claudeProfile = agentConfig.claudeProfile;
      agentCommand = agentConfig.agentCommand;
      resolvedProvider = agentConfig.resolvedProvider;
      timing("agent-config", t);

      // #630: mark the create as in flight BEFORE anything lands on disk. Everything from
      // here to the final transaction is invisible to the board otherwise — minutes on a
      // single repo, tens of minutes on a multi-repo project — so a restart in this window
      // used to leave worktrees and branches nobody had a record of.
      await beginProvisioning({
        id,
        issueId: input.issueId,
        projectId: issue.projectId,
        branch: input.branch || (isDirect ? null : suggestBranchName(issue)),
        worktreePath: null,
      }, database);
      provisioningMarked = true;

      t = Date.now();
      ({ branch, worktreePath, baseBranch, baseCommitSha, latestSetup, setupCompletion, symlinkRun: latestSymlink } = await setupWorktree(
        isDirect, project.repoPath, project.defaultBranch, input, setupConfig, symlinkConfig, id,
        {
          claudeProfile: agentConfig.claudeProfile,
          settingsProfile: agentConfig.claudeProfile && agentConfig.claudeProfile !== "default"
            ? agentConfig.claudeProfile
            : undefined,
        },
        issue,
      ));
      timing("worktree-setup", t);
      // The branch is only settled here (it can be derived), and the worktree path is what a
      // reclaim needs — record both before the sibling loop, which is the long part.
      await updateProvisioning(id, { phase: "siblings", branch, worktreePath }, database).catch(() => {});

      if (!isDirect && worktreePath) {
        await warnIfWorktreePathNotRegistered(gitService, project.repoPath, worktreePath, id, issue.projectId);
      }

      // Multi-repo (full-peers): a worktree on the same branch in every additional
      // repo. No-op for single-repo projects and direct workspaces. A failure here
      // throws so the catch-block rollback removes leading + sibling worktrees.
      if (!isDirect) {
        t = Date.now();
        // #627: how the per-repo dependency installs run is a per-project choice — sequential
        // (default) or bounded-parallel — plus an optional timeout, since the setup script's
        // 5-minute default is a hard ceiling a cold Maven repo can exceed.
        const projectInstallOpts = await resolveSiblingInstallOptions(issue.projectId, database);
        // #628 — an explicit per-launch mode beats the project preference, so a single
        // expensive multi-repo ticket can be started hands-off without changing the project.
        const installOpts = { ...projectInstallOpts, installMode: input.installMode ?? projectInstallOpts.installMode };
        siblingInstallTimeoutMs = installOpts.installTimeoutMs;
        // #629: with no explicit scope, fall back to what the TICKET says it touches
        // (`repo:<name>` tags) instead of provisioning every repo. The monitor's auto-starter
        // calls createWorkspace({ issueId }) with nothing else, so this is the path that
        // matters most — it is where "all 17 repos" came from.
        const repoScope = resolveEffectiveRepoScope({
          explicit: input.repoScope,
          reposTouched: await getIssueReposTouched(input.issueId, database),
          leadingRepoName: basename(project.repoPath) || project.repoPath,
        });
        siblingWorktrees = await provisionSiblingWorktrees({
          gitService, database, projectId: issue.projectId, branch, repoScope,
          // #629: `skipSetup` suppressed only the leading repo's setup script, so on a
          // multi-repo project the installs that dominate provisioning ran anyway.
          skipSetup: input.skipSetup === true,
          ...installOpts,
        });
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
      t = Date.now();
      const ticketContextPath = !isDirect && worktreePath
        ? await writeWorktreeTicketContext(
            worktreePath,
            issue,
            contextPrimer,
            siblingWorktrees.map((s) => ({ name: s.name, worktreePath: s.worktreePath })),
            null,
            groupMembers,
          )
        : null;
      if (ticketContextPath) timing("ticket-context", t);

      // #269: this span (skill materialization + prompt assembly) was part of the
      // ~153s the phase timers left unaccounted — keep it instrumented.
      t = Date.now();
      // eslint-disable-next-line prefer-const
      let { agentPrompt, skillName, effectiveSkillId, hasWorkflowStart } = await resolveAgentPromptAndSkill({
        issue, input, includeVisualProof, workspaceId: id, worktreePath, project, skillId,
      });
      // Ticket group (#661): the member tickets ride in the PROMPT too (not only the
      // ticket-context file) so every provider sees them from turn 1.
      if (groupMembers.length > 0) {
        agentPrompt += `\n\n${buildGroupPromptSection(groupMembers)}`;
      }
      timing("resolve-prompt-skill", t);

      // #169: a BLOCKING setup script that failed must not proceed silently — the
      // agent would otherwise launch into a worktree missing its dependencies and
      // fail opaquely hours later at the merge verify gate. Mark the workspace
      // "blocked" (the established "automation paused; needs recovery" status) and
      // skip the deferred agent launch below instead of just logging a warning.
      // (agentConfig/claudeProfile/agentCommand/resolvedProvider already resolved
      // above — #155 moved that resolution before setupWorktree.)
      const setupFailedBlocking = !isDirect && setupConfig.setupBlocking && latestSetup.state === "failed";

      t = Date.now();
      // #358 — timestamp the row when it is WRITTEN, not when the request began.
      //
      // `now` is captured at the top of `createWorkspace`, before the whole provisioning pipeline
      // (`git worktree add` → devcontainer → the AWAITED blocking setup script → sibling worktrees
      // → context packer), measured at 84s to 8+ minutes. Stamping `createdAt`/`statusChangedAt`
      // with it BACKDATED both to the start of provisioning, which is why an approve→start hop
      // measured from `workspaces.createdAt` came out at 104s when the agent had not launched yet,
      // and why the row looked like it had coexisted with a `Backlog` issue for 84 seconds. It never
      // did — the row and the issue transition land in ONE transaction, right here. The backdating
      // was the whole illusion, and it silently corrupted every latency number taken from it.
      const committedAt = new Date().toISOString();
      await withTransaction(database, async (tx) => {
        // #630: the marker dies with the same commit that makes the workspace real, so
        // there is no window in which both — or neither — exist.
        await finishProvisioning(id, tx);
        await insertWorkspaceRecord({
          id, issueId: input.issueId, branch, worktreePath, baseBranch, isDirect,
          baseCommitSha, requiresReview, thoroughReview, planMode, tddMode, includeVisualProof,
          skillId: effectiveSkillId, claudeProfile, agentCommand, resolvedProvider, model: agentConfig.model,
          contextPrimer, serviceState: null,
          latestSetup, latestSymlink, now: committedAt, database: tx,
          status: setupFailedBlocking ? "blocked" : "active",
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
          // `committedAt`, not `now`: backdating `statusChangedAt` to before provisioning hid the
          // delay entirely on this path, so the board could not even show how long a start took.
          await moveIssueToInProgressStrict(input.issueId, issue.projectId, committedAt, tx);
        }

        // Ticket group (#661): the membership rows and the members' In-Progress flips ride
        // the SAME transaction as the workspace row, so a rollback leaves no member half-in.
        if (groupMembers.length > 0) {
          await insertWorkspaceIssueMembers(id, groupMembers.map((m) => m.id), committedAt, tx);
          for (const member of groupMembers) {
            await moveIssueToInProgressStrict(member.id, issue.projectId, committedAt, tx);
          }
        }
      }, "workspace create db writes");
      timing("db-writes", t);

      if (setupCompletion) {
        setupCompletion
          .then((run) => updateLatestSetupRun(id, run, issue.projectId))
          .catch((err) => console.warn(`[workspaces] failed to persist setup status: ${errorMessage(err)}`));
      }

      // #976 - installed for EVERY worktree, not only TDD ones: the BOM half of the hook is
      // what stops builders writing an invisible `EF BB BF` into commit subjects, and that is
      // not a TDD concern. The TDD gate is still conditional, inside the one hook git allows.
      if (worktreePath) {
        installCommitMsgHook(worktreePath, { tddMode });
      }

      timing("total", phaseStart);

      boardEvents?.broadcast(issue.projectId, "workspace_created");

      if (setupFailedBlocking) {
        // Do NOT schedule the deferred provision/launch — an agent must never start
        // in a worktree whose blocking setup script failed. Surface it loudly instead
        // of the previous silent proceed.
        console.warn(`[workspaces] blocking setup script failed for workspace ${id} (branch ${branch}) — workspace marked blocked, agent launch skipped`);
        emitButlerSystemEvent({
          projectId: issue.projectId,
          kind: "workspace_error",
          workspaceId: id,
          text: `Setup script failed for workspace ${id} (branch ${branch}, exit ${latestSetup.exitCode ?? "?"}) — workspace blocked, agent was not launched: ${(latestSetup.stderrTail || latestSetup.stdoutTail || "").slice(0, 200)}`,
        });
      } else {
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
          installTimeoutMs: siblingInstallTimeoutMs,
          issue: { issueNumber: issue.issueNumber, title: issue.title, description: issue.description, projectId: issue.projectId },
          contextPrimer,
          groupTickets: groupMembers,
          timing,
        });
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
        status: setupFailedBlocking ? "blocked" : "active",
        provider: resolvedProvider,
        latestSetup,
        latestSymlink,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      // #630: a create that fails CLEANLY has rolled its worktrees back below, so its marker
      // must go too — a surviving row is reserved for the case the marker exists for: a
      // process that died mid-create and never ran either exit path.
      if (provisioningMarked) await finishProvisioning(id, database).catch(() => {});
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
    } finally {
      // #673: release exactly the claim this call took, on every exit path. #736: identified
      // by TOKEN, so a create that hung past the TTL and was taken over releases nothing
      // rather than freeing its successor's directory mid-provision.
      releaseBranchForCreate(createClaim);
    }
  }

  // #547-adjacent: the read-only dry-run lives in workspace-launch-preview.service.ts. It was
  // the natural half to lift when this file crossed the 1000-line god-module ceiling — the
  // create path is the side-effecting orchestration, the preview is the pure projection of the
  // same decisions. The four collaborators it needs are injected rather than re-imported, so
  // the preview keeps answering with the SAME logic the launch runs; a preview that re-derives
  // its own answer is a preview that can lie about the launch.
  const { computeLaunchPreview } = createLaunchPreviewService({
    database,
    gitService,
    resolveIssueAndProject,
    buildAgentConfig,
  });

  return {
    createWorkspace,
    computeLaunchPreview,
  };
}
