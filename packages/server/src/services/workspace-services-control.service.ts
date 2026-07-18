/**
 * User-initiated lifecycle controls for a workspace's per-workspace Docker service
 * stack (#92): start / stop / restart / rebuild / retry / logs, driven from the board UI.
 *
 * This is the ORCHESTRATION layer that maps a workspaceId to a concrete stack-control
 * context (project servicesConfig, stored ServiceStackState, the compose worktree) and
 * then delegates the actual compose work to the engine (workspace-services.service.ts) —
 * it never spawns docker itself. It mirrors workspace-create-stack.service.ts, which owns
 * the create-side of the same engine, and reuses its `parseServicesConfig` +
 * `provisionServicesForLaunch` so the retry path shares the create flow's admission-cap
 * and shared-worktree semantics rather than reimplementing them.
 *
 * The reuse controls (start/stop/restart/rebuild/logs) pass the STORED compose project
 * name + env file verbatim, so no host port is ever reallocated (#92 acceptance:
 * "Respect the per-workspace allocated ports — no reallocation on restart").
 */

import type { ServiceStackState } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import { getWorkspaceById, resolveProjectId } from "../repositories/workspace.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { listWorkspaceRepos } from "../repositories/repo.repository.js";
import { updateWorkspaceServiceState } from "../repositories/workspace-service-state.repository.js";
import { workspaceServicesService, parseStoredServiceStackState, type WorkspaceServicesEngine } from "./workspace-services.service.js";
import { parseServicesConfig, provisionServicesForLaunch } from "./workspace-create-stack.service.js";
import type { SiblingWorktree } from "./workspace-repos.service.js";
import { WorkspaceError } from "./workspace-internals.js";

/** Resolved context for a control op over one workspace's stack. */
interface ResolvedStackContext {
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceById>>>;
  projectId: string;
  servicesConfigRaw: string | null;
  config: NonNullable<ReturnType<typeof parseServicesConfig>>;
  /** The stored (provisioned) state, or null when the stack was never brought up. */
  state: ServiceStackState | null;
  /** Worktree holding the compose file (leading worktree, or the composeRepo sibling). */
  composeWorktreePath: string;
  siblings: SiblingWorktree[];
}

export function createWorkspaceServicesControlService(deps: {
  database: Database;
  boardEvents?: BoardEvents;
  /** Injectable for tests; defaults to the process-wide real-docker engine. */
  engine?: WorkspaceServicesEngine;
}) {
  const { database, boardEvents } = deps;
  const engine = deps.engine ?? workspaceServicesService;

  async function resolveContext(workspaceId: string): Promise<ResolvedStackContext> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (workspace.isDirect) {
      throw new WorkspaceError("Direct workspaces run in the main checkout and have no service stack", "BAD_REQUEST");
    }
    if (!workspace.workingDir) {
      throw new WorkspaceError("Workspace has no worktree — its service stack cannot be controlled", "BAD_REQUEST");
    }

    const projectId = await resolveProjectId(workspaceId, database);
    if (!projectId) throw new WorkspaceError("Project not found for workspace", "NOT_FOUND");
    const project = await getProjectById(projectId, database);
    const servicesConfigRaw = project?.servicesConfig ?? null;
    const config = parseServicesConfig(servicesConfigRaw);
    if (!config) {
      throw new WorkspaceError("This project has no service stack configured", "BAD_REQUEST");
    }

    // Sibling worktrees (multi-repo) — used both to resolve a composeRepo worktree and to
    // hand the create flow its full-peer set on a retry (re-provision).
    const repoRows = await listWorkspaceRepos(workspaceId, database).catch(() => []);
    const siblings: SiblingWorktree[] = repoRows
      .filter((r) => r.worktreePath && r.branch && r.baseBranch)
      .map((r) => ({
        path: r.path,
        name: r.name,
        worktreePath: r.worktreePath as string,
        branch: r.branch as string,
        baseBranch: r.baseBranch as string,
        baseCommitSha: r.baseCommitSha ?? null,
        composeFile: r.composeFile ?? null,
      }));

    let composeWorktreePath = workspace.workingDir;
    if (config.composeRepo) {
      const sibling = siblings.find((s) => s.name === config.composeRepo);
      if (!sibling) {
        throw new WorkspaceError(
          `servicesConfig.composeRepo '${config.composeRepo}' does not resolve to one of this workspace's repos`,
          "BAD_REQUEST",
        );
      }
      composeWorktreePath = sibling.worktreePath;
    }

    return {
      workspace,
      projectId,
      servicesConfigRaw,
      config,
      state: parseStoredServiceStackState(workspace.serviceState),
      composeWorktreePath,
      siblings,
    };
  }

  /** Persist an updated ServiceStackState and notify the board. Returns the state. */
  async function persist(ctx: ResolvedStackContext, state: ServiceStackState): Promise<ServiceStackState> {
    await updateWorkspaceServiceState(ctx.workspace.id, JSON.stringify(state), database);
    boardEvents?.broadcast(ctx.projectId, "workspace_setup");
    return state;
  }

  /** True when the stored state points at a stack that was actually brought up (has a name). */
  function isProvisioned(state: ServiceStackState | null): state is ServiceStackState {
    return !!state && state.composeProjectName.length > 0 && (state.status === "up" || state.status === "down");
  }

  function controlCtx(ctx: ResolvedStackContext, state: ServiceStackState) {
    return { state, config: ctx.config, composeWorktreePath: ctx.composeWorktreePath, workspaceId: ctx.workspace.id };
  }

  /**
   * (Re)provision the stack from scratch — the RETRY path for a deferred/errored/never-run
   * stack. Reuses the create flow's `provisionServicesForLaunch` (admission cap +
   * shared-worktree adoption) so retry behaves exactly like a fresh create would.
   */
  async function provisionAndPersist(ctx: ResolvedStackContext): Promise<ServiceStackState> {
    const result = await provisionServicesForLaunch(database, {
      servicesConfigRaw: ctx.servicesConfigRaw,
      workspaceId: ctx.workspace.id,
      workspaceCreatedAt: ctx.workspace.createdAt ?? new Date().toISOString(),
      branch: ctx.workspace.branch,
      leadingWorktreePath: ctx.workspace.workingDir as string,
      siblings: ctx.siblings,
    });
    if (!result) {
      // parseServicesConfig already succeeded in resolveContext, so a null here would be a
      // genuine surprise — surface it rather than silently no-op.
      throw new WorkspaceError("Service stack could not be provisioned for this workspace", "CONFLICT");
    }
    return persist(ctx, result.state);
  }

  /**
   * Start (or, with `recreate`, rebuild) a workspace's stack. When a provisioned stack
   * exists it is reused (ports preserved); otherwise — a deferred/errored/never-run stack —
   * it is (re)provisioned. This single method backs both the "Start" and "Retry" controls.
   */
  async function up(workspaceId: string, opts: { recreate?: boolean } = {}): Promise<ServiceStackState> {
    const ctx = await resolveContext(workspaceId);
    if (isProvisioned(ctx.state)) {
      const state = await engine.startWorkspaceServices(controlCtx(ctx, ctx.state), { forceRecreate: opts.recreate });
      return persist(ctx, state);
    }
    // Nothing usable to reuse (never provisioned, or a deferred/error state) → re-provision.
    return provisionAndPersist(ctx);
  }

  async function down(workspaceId: string): Promise<ServiceStackState> {
    const ctx = await resolveContext(workspaceId);
    if (!isProvisioned(ctx.state)) {
      throw new WorkspaceError("No running service stack to stop for this workspace", "CONFLICT");
    }
    const state = await engine.stopWorkspaceServices(controlCtx(ctx, ctx.state));
    return persist(ctx, state);
  }

  async function restart(workspaceId: string): Promise<ServiceStackState> {
    const ctx = await resolveContext(workspaceId);
    if (!isProvisioned(ctx.state)) {
      throw new WorkspaceError("No service stack to restart for this workspace", "CONFLICT");
    }
    const state = await engine.restartWorkspaceServices(controlCtx(ctx, ctx.state));
    return persist(ctx, state);
  }

  async function logs(workspaceId: string, tail: number): Promise<{ ok: boolean; logs: string }> {
    const ctx = await resolveContext(workspaceId);
    if (!ctx.state || ctx.state.composeProjectName.length === 0) {
      throw new WorkspaceError("No service stack has been provisioned for this workspace yet", "CONFLICT");
    }
    return engine.getWorkspaceServiceLogs(
      controlCtx(ctx, ctx.state),
      Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 200,
    );
  }

  return { up, down, restart, logs };
}
