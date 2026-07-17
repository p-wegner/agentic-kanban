// Repository for a workspace's per-workspace Docker service-stack state
// (`workspaces.service_state`, a JSON `ServiceStackState`) and for the persisted
// per-server-instance id that scopes compose project names. Kept as its own focused
// module so the create/deferred-launch flow persists the stack state through the
// repository layer (services must not spawn drizzle directly) without growing the
// grandfathered workspace repositories past their god-module baselines.

import { randomUUID } from "node:crypto";
import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import { workspaces, preferences } from "@agentic-kanban/shared/schema";
import { TERMINAL_WORKSPACE_STATUSES } from "@agentic-kanban/shared/lib/workspace-status";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Workspace statuses that no longer OWN a service stack: their teardown already ran
 * (merge/close), so a late deferred-provision persist must NOT land on them — a
 * 0-row persist tells the caller to tear the freshly-started stack down instead
 * (finding: delete/close during the up-to-120s `up --wait` window leaked the stack).
 * Imported from shared as the SINGLE source of truth so this filter and the
 * service-stack reaper's open-row filter can never drift (#57).
 */
const TERMINAL_STATUSES: string[] = [...TERMINAL_WORKSPACE_STATUSES];

/**
 * Persist (or clear, with null) a workspace's serialized service-stack state.
 *
 * Returns the number of rows updated — 0 when the workspace row was DELETED or moved
 * to a terminal status (closed/merged) while the caller was provisioning. Uses
 * `.returning().length` rather than a driver row-count because libsql reports
 * `rowsAffected`/`changes` unreliably (see issue-service.repository.ts). Callers MUST
 * treat 0 like a persist failure: no still-open row owns the stack, so nothing else
 * will ever tear it down.
 */
export async function updateWorkspaceServiceState(
  workspaceId: string,
  serviceStateJson: string | null,
  database: Database = db,
): Promise<number> {
  const updated = await database
    .update(workspaces)
    .set({ serviceState: serviceStateJson, updatedAt: new Date().toISOString() })
    .where(and(eq(workspaces.id, workspaceId), notInArray(workspaces.status, TERMINAL_STATUSES)))
    .returning({ id: workspaces.id });
  return updated.length;
}

/**
 * Mark the stored service-stack state whose composeProjectName matches as "down"
 * (teardown ran). Keyed on the STORED compose name because the teardown engine only
 * has that in hand; names are unique per workspace so at most one row matches.
 * Without this, the workspace DTO kept reporting a downed stack as status "up" with
 * host ports that may since have been reassigned to another workspace's stack.
 */
export async function markWorkspaceServiceStateDown(
  composeProjectName: string,
  now?: string,
  database: Database = db,
): Promise<void> {
  if (!composeProjectName) return;
  const nowIso = now ?? new Date().toISOString();
  await database
    .update(workspaces)
    .set({
      serviceState: sql`json_set(${workspaces.serviceState}, '$.status', 'down', '$.updatedAt', ${nowIso})`,
      updatedAt: nowIso,
    })
    .where(
      and(
        sql`json_extract(${workspaces.serviceState}, '$.composeProjectName') = ${composeProjectName}`,
        sql`json_extract(${workspaces.serviceState}, '$.status') != 'down'`,
      ),
    );
}

/**
 * The workspace's current lifecycle status, or null when the row no longer exists.
 * Used by the deferred provision+launch chain to re-check the workspace is still
 * alive after the long provisioning window, before launching the agent.
 */
export async function getWorkspaceLifecycleStatus(
  workspaceId: string,
  database: Database = db,
): Promise<{ status: string } | null> {
  const rows = await database
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * OTHER live (non-terminal) workspaces that point at the same leading worktree
 * directory. Shared-worktree stack semantics (finding 12): createWorktree REUSES the
 * existing worktree for a second workspace on the same branch, and fork children copy
 * the parent's workingDir — so before provisioning a service stack the create flow
 * must know whether a co-resident workspace already lives (and possibly owns a stack)
 * in that directory. Exact string equality mirrors findWorkspacesByWorkingDir (both
 * sides of a share store the path from the same createWorktree/copy source).
 */
export async function findLiveWorkspacesSharingWorkingDir(
  workingDir: string,
  excludeWorkspaceId: string,
  database: Database = db,
): Promise<{ id: string; serviceState: string | null; createdAt: string | null }[]> {
  if (!workingDir) return [];
  return database
    .select({ id: workspaces.id, serviceState: workspaces.serviceState, createdAt: workspaces.createdAt })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.workingDir, workingDir),
        ne(workspaces.id, excludeWorkspaceId),
        notInArray(workspaces.status, TERMINAL_STATUSES),
      ),
    );
}

/**
 * Live (non-terminal) workspaces whose persisted ServiceStackState still CLAIMS the
 * given compose project with status "up" — i.e. the workspaces that would break if the
 * stack were downed right now. The teardown engine's last-reference guard consults
 * this so a stack shared across co-resident workspaces (worktree reuse / fork
 * children) is only downed when the LAST live sharer releases it. Rows whose state is
 * "down"/"error" hold no claim; terminal (closed/merged) rows only persist as history.
 */
export async function findLiveWorkspacesReferencingComposeProject(
  composeProjectName: string,
  database: Database = db,
): Promise<{ id: string }[]> {
  if (!composeProjectName) return [];
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        notInArray(workspaces.status, TERMINAL_STATUSES),
        sql`json_extract(${workspaces.serviceState}, '$.composeProjectName') = ${composeProjectName}`,
        sql`json_extract(${workspaces.serviceState}, '$.status') = 'up'`,
      ),
    );
}

/**
 * Every host port currently claimed by a live (non-terminal) stack whose state is "up".
 * The port allocator excludes these so a server RESTART (which clears the in-process
 * reservation registry) or a stack persisted since the last allocation never has its
 * ports re-handed to a new workspace (#51). Reads each state's `ports` map from the JSON
 * blob; a row with no/na ports contributes nothing. De-duplicated across rows.
 */
export async function getLiveStackHostPorts(database: Database = db): Promise<number[]> {
  const rows = await database
    .select({ serviceState: workspaces.serviceState })
    .from(workspaces)
    .where(
      and(
        notInArray(workspaces.status, TERMINAL_STATUSES),
        sql`json_extract(${workspaces.serviceState}, '$.status') = 'up'`,
      ),
    );
  const ports = new Set<number>();
  for (const row of rows) {
    if (!row.serviceState) continue;
    try {
      const parsed = JSON.parse(row.serviceState) as { ports?: Record<string, unknown> };
      for (const value of Object.values(parsed.ports ?? {})) {
        const port = typeof value === "number" ? value : Number(value);
        if (Number.isInteger(port) && port > 0) ports.add(port);
      }
    } catch {
      // A corrupt blob simply contributes no ports — never fail allocation over it.
    }
  }
  return [...ports];
}

/**
 * How many DISTINCT service stacks this board currently has "up" — the live count the
 * admission cap (`max_concurrent_stacks`, #56) compares against before provisioning an
 * (N+1)th. Counts DISTINCT composeProjectName so co-resident workspaces that ADOPTED
 * one shared stack (worktree reuse / fork children) count once, not per-workspace.
 * Only non-terminal rows whose state is "up" hold a real running stack.
 */
export async function countLiveStacks(database: Database = db): Promise<number> {
  const rows = await database
    .select({ composeProjectName: sql<string>`json_extract(${workspaces.serviceState}, '$.composeProjectName')` })
    .from(workspaces)
    .where(
      and(
        notInArray(workspaces.status, TERMINAL_STATUSES),
        sql`json_extract(${workspaces.serviceState}, '$.status') = 'up'`,
      ),
    );
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.composeProjectName === "string" && row.composeProjectName.length > 0) {
      names.add(row.composeProjectName);
    }
  }
  return names.size;
}

/**
 * The ids of every LIVE (non-terminal) workspace in this DB. The wide GC sweep (#53)
 * maps these to ws-tokens (`serviceStackWsToken`) to tell an in-use stack from an
 * orphan across an instance-id change — the token, not the `ak-<inst>-` prefix, is the
 * stable identity that survives a DB reset/restore or the home-fallback.
 */
export async function getNonTerminalWorkspaceIds(database: Database = db): Promise<string[]> {
  const rows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(notInArray(workspaces.status, TERMINAL_STATUSES));
  return rows.map((r) => r.id);
}

/** Preference key holding this server instance's persisted service-stack identity. */
const SERVICE_STACK_INSTANCE_ID_KEY = "service_stack_instance_id";

/** Accept only sane persisted ids; anything else is regenerated. */
const INSTANCE_ID_RE = /^[a-z0-9]{4,16}$/;

/**
 * The per-DB (i.e. per board instance) id that scopes compose project names
 * (`ak-<instanceId>-ws-<workspaceId>`). Created once and persisted in the
 * `preferences` table so it is stable across restarts. Every board instance on a
 * host shares the Docker daemon but has its OWN DB (main checkout, worktree dev
 * servers on ~/.agentic-kanban, DooD containers), so this id is what keeps one
 * instance's startup reaper from ever downing another instance's live stacks.
 */
export async function getOrCreateServiceStackInstanceId(database: Database = db): Promise<string> {
  const readRow = async (): Promise<{ value: string } | undefined> => {
    const rows = await database
      .select({ value: preferences.value })
      .from(preferences)
      .where(eq(preferences.key, SERVICE_STACK_INSTANCE_ID_KEY))
      .limit(1);
    return rows[0];
  };
  const validOf = (row: { value: string } | undefined): string | null => {
    const value = row?.value?.trim() ?? "";
    return INSTANCE_ID_RE.test(value) ? value : null;
  };

  const row = await readRow();
  const existing = validOf(row);
  if (existing) return existing;

  const fresh = randomUUID().replace(/-/g, "").slice(0, 8);
  if (!row) {
    await database
      .insert(preferences)
      .values({ key: SERVICE_STACK_INSTANCE_ID_KEY, value: fresh, updatedAt: new Date().toISOString() })
      .onConflictDoNothing();
  } else {
    // Repair an invalid persisted value IN PLACE (guarded on the old value so a
    // concurrent valid write is never clobbered) — the id must be stable across
    // calls or provisioned names would stop matching the reaper's filter.
    await database
      .update(preferences)
      .set({ value: fresh, updatedAt: new Date().toISOString() })
      .where(and(eq(preferences.key, SERVICE_STACK_INSTANCE_ID_KEY), eq(preferences.value, row.value)));
  }
  // Re-read: a concurrent creator may have won the race — the PERSISTED value is
  // authoritative (every caller must derive the same names).
  return validOf(await readRow()) ?? fresh;
}
