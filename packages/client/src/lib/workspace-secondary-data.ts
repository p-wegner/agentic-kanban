import type { ServiceStackState, WorkspaceResponse } from "@agentic-kanban/shared";

/**
 * Pure orchestration for the WorkspacePanel's secondary per-workspace fetches.
 *
 * After loading the workspace list, the panel hydrates three independent
 * per-workspace maps (latest commit, GitHub handoff draft, plan content). That
 * logic lived inline in `fetchWorkspaces`, which was the board's single hottest
 * function by cyclomatic complexity (CC 44 / churn 357) — the three
 * `filter().map(async … try/catch)` blocks plus the auto-select ternary. Pulling
 * them out here makes each block independently testable and collapses the
 * component method to thin wiring.
 *
 * Each helper resolves to a record keyed by workspace id; a per-workspace fetch
 * failure yields `null` for that id (never rejects the whole batch).
 */

/** Minimal view of `apiFetch` so these helpers are testable with a fake fetch. */
export type ApiFetch = <T>(path: string) => Promise<T>;

/** Record keyed by workspace id. */
type ById<T> = Record<string, T>;

/** Resolve one workspace's value to `null` on any error, recording it under its id. */
async function collectById<T>(
  workspaces: WorkspaceResponse[],
  predicate: (ws: WorkspaceResponse) => boolean,
  load: (ws: WorkspaceResponse) => Promise<T>,
): Promise<ById<T | null>> {
  const out: ById<T | null> = {};
  await Promise.all(
    workspaces.filter(predicate).map(async (ws) => {
      try {
        out[ws.id] = await load(ws);
      } catch {
        out[ws.id] = null;
      }
    }),
  );
  return out;
}

/** Latest commit (sha + message) per workspace that has a worktree. */
export function fetchLatestCommits(
  workspaces: WorkspaceResponse[],
  apiFetch: ApiFetch,
): Promise<ById<{ sha: string; message: string } | null>> {
  return collectById(
    workspaces,
    (ws) => Boolean(ws.workingDir),
    async (ws) => {
      const result = await apiFetch<{ sha: string | null; message: string | null }>(
        `/api/workspaces/${ws.id}/latest-commit`,
      );
      return result.sha && result.message ? { sha: result.sha, message: result.message } : null;
    },
  );
}

/** GitHub handoff draft content per closed (merged) workspace. */
export function fetchGithubDrafts(
  workspaces: WorkspaceResponse[],
  apiFetch: ApiFetch,
): Promise<ById<string | null>> {
  return collectById(
    workspaces,
    (ws) => ws.status === "closed",
    async (ws) =>
      (await apiFetch<{ content: string | null }>(`/api/workspaces/${ws.id}/github-handoff-draft`)).content,
  );
}

/**
 * Docker service-stack state per workspace. The issue-workspaces list DTO does
 * not carry `serviceState` (only GET /api/workspaces/:id maps it — see
 * workspace-details-projection.ts), so hydrate it from the details endpoint.
 * Workspaces whose list row already carries the field are skipped, so this
 * batch disappears automatically if the list endpoint ever includes it.
 */
export function fetchServiceStates(
  workspaces: WorkspaceResponse[],
  apiFetch: ApiFetch,
): Promise<ById<ServiceStackState | null>> {
  return collectById(
    workspaces,
    (ws) => ws.serviceState === undefined,
    async (ws) =>
      (await apiFetch<{ serviceState?: ServiceStackState | null }>(`/api/workspaces/${ws.id}`)).serviceState ?? null,
  );
}

/** Plan markdown per workspace awaiting plan approval (has a pending plan path + worktree). */
export function fetchPlanContents(
  workspaces: WorkspaceResponse[],
  apiFetch: ApiFetch,
): Promise<ById<string | null>> {
  return collectById(
    workspaces,
    (ws) => Boolean(ws.pendingPlanPath && ws.workingDir),
    async (ws) => (await apiFetch<{ content: string | null }>(`/api/workspaces/${ws.id}/plan`)).content,
  );
}

/**
 * Which workspace to auto-select after a load, or `undefined` to leave the current
 * selection untouched. Selects `autoSelectId` when given, else the sole workspace
 * when there is exactly one — but never overrides an existing selection.
 */
export function pickInitialWorkspaceId(
  workspaces: WorkspaceResponse[],
  selectedWorkspace: string | null,
  autoSelectId: string | undefined,
): string | undefined {
  if (workspaces.length === 0 || selectedWorkspace) return undefined;
  return autoSelectId ?? (workspaces.length === 1 ? workspaces[0].id : undefined);
}
