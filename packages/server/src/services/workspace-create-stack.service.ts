/**
 * Service-stack provisioning for the workspace-CREATE flow, extracted from
 * workspace-create.service.ts (god-module ceiling).
 *
 * Owns the create-side decisions around a project's declared per-workspace Docker
 * stack: parsing the persisted servicesConfig, the SHARED-WORKTREE guard (finding 12
 * — adopt/refuse instead of cross-wiring a co-resident's `.kanban/services.env`), and
 * the non-fatal provisioning call into the compose engine
 * (workspace-services.service.ts). Runs only in the deferred launch path — never on
 * the HTTP hot path.
 */

import {
  DEFAULT_SERVICE_STACK_CONFIG,
  type ServiceStackConfig,
  type ServiceStackState,
} from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { findLiveWorkspacesSharingWorkingDir } from "../repositories/workspace-service-state.repository.js";
import { workspaceServicesService, parseStoredServiceStackState } from "./workspace-services.service.js";
import type { SiblingWorktree } from "./workspace-repos.service.js";

/** Provisioning outcome: the state to persist + whether it was ADOPTED from a co-resident. */
export interface ProvisionForLaunchResult {
  state: ServiceStackState;
  /**
   * True when the state records a CO-RESIDENT workspace's stack (shared worktree) —
   * this workspace never owns it, so the deferred convergence paths must not down it
   * on a failed persist.
   */
  adopted: boolean;
}

/**
 * Parse a project's persisted servicesConfig JSON defensively. Missing/invalid/
 * disabled all collapse to null (no stack), so the no-docker single-user workflow is
 * a true zero-behavior-change path. Merges over DEFAULT_SERVICE_STACK_CONFIG so
 * partial configs get sane defaults.
 */
export function parseServicesConfig(raw: string | null): ServiceStackConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceStackConfig> | null;
    if (!parsed || typeof parsed !== "object" || parsed.enabled !== true) return null;
    return {
      ...DEFAULT_SERVICE_STACK_CONFIG,
      ...parsed,
      enabled: true,
      composeFile: parsed.composeFile?.trim() || DEFAULT_SERVICE_STACK_CONFIG.composeFile,
    };
  } catch {
    return null;
  }
}

function errorState(message: string): ServiceStackState {
  return {
    composeProjectName: "",
    ports: {},
    envFilePath: "",
    status: "error",
    error: message.slice(0, 2000),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * SHARED-WORKTREE STACK SEMANTICS (finding 12, design: REUSE). createWorktree hands
 * a second workspace on the same branch the SAME worktree (and fork children copy
 * the parent's workingDir), so provisioning a second stack here would overwrite the
 * shared `.kanban/services.env` and cross-wire the co-resident agent onto the new
 * stack's ports. Instead:
 *  - a live co-resident with an "up" stack → ADOPT it: record the SAME compose
 *    project (state copied), bring up NO second stack, leave services.env untouched;
 *  - a SENIOR live co-resident (created before this workspace) without an adoptable
 *    stack (e.g. its provisioning is still inside the up-to-120s `up --wait`
 *    window) → REFUSE with an "error" state, never race it for the env file;
 *  - only JUNIOR co-residents (created after; they will defer to us) → provision
 *    normally.
 * Returns null = no co-resident constraint; the caller provisions its own stack.
 */
async function resolveSharedWorktreeStack(
  database: Database,
  params: { workspaceId: string; workspaceCreatedAt: string; leadingWorktreePath: string },
): Promise<ProvisionForLaunchResult | null> {
  let sharers: { id: string; serviceState: string | null; createdAt: string | null }[] = [];
  try {
    sharers = await findLiveWorkspacesSharingWorkingDir(params.leadingWorktreePath, params.workspaceId, database);
  } catch (err) {
    // Invariant 4 (single-workspace behavior unchanged) wins on a failed check: warn
    // loudly and provision normally — a genuinely-shared worktree is the rare case.
    console.warn(`[services] shared-worktree check failed for ${params.leadingWorktreePath} (provisioning proceeds): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (sharers.length === 0) return null;

  const adoptable = sharers
    .map((s) => ({ id: s.id, createdAt: s.createdAt ?? "", state: parseStoredServiceStackState(s.serviceState) }))
    .filter((s): s is { id: string; createdAt: string; state: ServiceStackState } =>
      s.state !== null && s.state.status === "up" && s.state.composeProjectName.length > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  if (adoptable.length > 0) {
    const donor = adoptable[0];
    console.log(`[services] workspace ${params.workspaceId} shares worktree ${params.leadingWorktreePath} with workspace ${donor.id} — adopting its stack ${donor.state.composeProjectName} (no second stack, services.env untouched)`);
    return { adopted: true, state: { ...donor.state, updatedAt: new Date().toISOString() } };
  }

  const senior = sharers.filter((s) =>
    (s.createdAt ?? "") < params.workspaceCreatedAt ||
    ((s.createdAt ?? "") === params.workspaceCreatedAt && s.id < params.workspaceId));
  if (senior.length > 0) {
    const message =
      `worktree is shared with live workspace ${senior[0].id}, which has no adoptable (status "up") service stack yet — ` +
      `this workspace's stack was NOT started so the shared .kanban/services.env is never overwritten (cross-wiring guard). ` +
      `Once the co-resident's stack is up its services are shared; or close/delete the co-resident workspace.`;
    console.warn(`[services] ${message}`);
    return { adopted: false, state: errorState(message) };
  }

  // Only junior sharers — they defer to this workspace; provision normally.
  return null;
}

/**
 * Bring the project's declared per-workspace Docker service stack up. Runs in the
 * DEFERRED launch path (OFF the HTTP hot path, #F3b) AFTER the workspace row exists,
 * keyed on the workspace's UNIQUE id (#F1) so its compose project name can never
 * collide with a sibling workspace on the same issue. NON-FATAL — any failure yields
 * an "error" ServiceStackState that is persisted and surfaced. Returns null when the
 * project has no (enabled) stack.
 */
export async function provisionServicesForLaunch(
  database: Database,
  params: {
    servicesConfigRaw: string | null;
    workspaceId: string;
    workspaceCreatedAt: string;
    branch: string;
    leadingWorktreePath: string;
    siblings: SiblingWorktree[];
  },
): Promise<ProvisionForLaunchResult | null> {
  const config = parseServicesConfig(params.servicesConfigRaw);
  if (!config) return null;

  // Shared-worktree guard BEFORE any provisioning side effect (finding 12).
  const shared = await resolveSharedWorktreeStack(database, params);
  if (shared) return shared;

  let composeWorktreePath = params.leadingWorktreePath;
  if (config.composeRepo) {
    const sibling = params.siblings.find((s) => s.name === config.composeRepo);
    if (!sibling) {
      // A configured-but-unresolvable composeRepo (typo, or the repo was removed from
      // the project) must FAIL LOUDLY, never fall back to the leading worktree — the
      // leading repo's docker-compose.yml can be a completely unrelated (e.g. full
      // app-deployment) stack that would be brought up per workspace by accident.
      const message =
        `servicesConfig.composeRepo '${config.composeRepo}' does not match any of the project's additional repos — the service stack was NOT started. ` +
        `Set composeRepo to one of the project's additional repo names, or leave it empty to use the leading repo's compose file.`;
      console.warn(`[services] ${message}`);
      return { adopted: false, state: errorState(message) };
    }
    composeWorktreePath = sibling.worktreePath;
  }

  try {
    const state = await workspaceServicesService.provisionWorkspaceServices({
      config,
      workspaceId: params.workspaceId,
      composeWorktreePath,
      extraEnv: { KANBAN_WORKTREE_BRANCH: params.branch },
    });
    return { adopted: false, state };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[services] provisioning threw (non-fatal) for branch ${params.branch}: ${message}`);
    // No stack came up, so an empty compose name is safe here: every teardown path
    // (parseStoredComposeProjectName) treats it as "nothing to down".
    return { adopted: false, state: errorState(message) };
  }
}
