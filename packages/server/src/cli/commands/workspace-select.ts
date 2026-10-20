// Picking the workspace a CLI command acts on from an issue (#1652), and closing it over the
// board API. Pure selection + an injectable fetch so the refusal rules are unit-testable.
import type { BranchClaim } from "@agentic-kanban/shared/lib/worktree-claim";
import { buildWorkspaceApiUrl } from "./workspace-api-url.js";

/** A workspace row as the CLI picks from it: id, status and branch (the shared `BranchClaim` shape). */
export type SelectableWorkspace = BranchClaim;

/** A workspace is open until it is closed or merged. */
export function isOpenWorkspace(ws: { status: string }): boolean {
  return ws.status !== "closed" && ws.status !== "merged";
}

export type WorkspaceSelection =
  | { ok: true; workspace: SelectableWorkspace }
  | { ok: false; message: string };

/**
 * The open workspace of an issue that `workspace close --issue <n>` should act on.
 * Exactly one open workspace is selected implicitly; none or several is a refusal, unless
 * the caller named one (`explicitId`), which must belong to the issue.
 */
export function selectOpenWorkspaceForIssue(
  issueLabel: string,
  rows: SelectableWorkspace[],
  explicitId?: string,
): WorkspaceSelection {
  if (explicitId) {
    const named = rows.find((w) => w.id === explicitId);
    if (!named) return { ok: false, message: `Workspace '${explicitId}' does not belong to ${issueLabel}.` };
    return { ok: true, workspace: named };
  }
  const open = rows.filter(isOpenWorkspace);
  if (open.length === 0) return { ok: false, message: `${issueLabel} has no open workspace.` };
  if (open.length > 1) {
    const listing = open.map((w) => `  ${w.id}  [${w.status}] ${w.branch}`).join("\n");
    return {
      ok: false,
      message: `${issueLabel} has ${open.length} open workspaces; name one (workspace close <workspace-id> --issue <n>):\n${listing}`,
    };
  }
  return { ok: true, workspace: open[0] };
}

/** POST .../close. Returns an error message, or null on success. */
export async function closeWorkspaceViaApi(
  port: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(buildWorkspaceApiUrl(port, workspaceId, "close"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? res.statusText;
}

/**
 * Close every open workspace of an issue (`issue move <n> Cancelled --close-workspace`).
 * Stops at the first failure; `discarded` lists the branches closed so far.
 */
export async function closeOpenWorkspaces(
  port: string,
  rows: SelectableWorkspace[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ discarded: string[]; error: string | null }> {
  const discarded: string[] = [];
  for (const ws of rows.filter(isOpenWorkspace)) {
    const error = await closeWorkspaceViaApi(port, ws.id, fetchImpl);
    if (error) return { discarded, error: `Closing workspace '${ws.id}' (${ws.branch}) failed: ${error}` };
    discarded.push(ws.branch);
  }
  return { discarded, error: null };
}
