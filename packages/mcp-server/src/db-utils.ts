import { eq } from "drizzle-orm";
import type { ToolDb } from "./tools/deps.js";
import type * as schemaModule from "@agentic-kanban/shared/schema";
import { findOpenUnmergedWorkspace } from "@agentic-kanban/shared/lib/issue-status-orchestration";
import { nextIssueNumber as sharedNextIssueNumber } from "@agentic-kanban/shared/lib/issue-number";

// The per-session .out transcript reader is shared with the server (single source
// of truth in @agentic-kanban/shared/lib/session-files), not a hand-synced fork.
// Re-exported so the existing MCP tool imports (`from "../db-utils.js"`) are
// unchanged; the bounded readSessionStdoutFileTail is also available there.
export { readSessionStdoutFile } from "@agentic-kanban/shared/lib/session-files";

export type McpResponse = { content: Array<{ type: "text"; text: string }> };
export { isIssueNumberUniqueConstraintError } from "@agentic-kanban/shared/lib/issue-number";

/** Standardized MCP error response factory. */
/**
 * The MCP content envelope. Every tool response is this shape (#617).
 *
 * Eight tools had a private `const text = (v) => ({content:[{type:"text",text:v}]})`
 * clone. They could not simply use `mcpError`, because they use the same wrapper for
 * SUCCESS payloads too (`text(JSON.stringify(result))`) — routing those through a
 * function named `mcpError` would have misnamed every success path. So the general
 * wrapper is named for what it is, and `mcpError` is a thin alias that documents intent
 * at the call site.
 */
export function mcpText(value: string): McpResponse {
  return { content: [{ type: "text" as const, text: value }] };
}

/** A JSON payload as MCP text content — the `text(JSON.stringify(x, null, 2))` idiom. */
export function mcpJson(value: unknown): McpResponse {
  return mcpText(JSON.stringify(value, null, 2));
}

export function mcpError(message: string): McpResponse {
  return mcpText(message);
}

/**
 * Content for a value that may be either a ready string or a structure to serialise.
 * `plugin-gates` and `plugin-onboarding` each had this dispatch privately (#617) — the
 * only clones that were not a plain wrapper, which is why they needed their own helper
 * rather than `mcpText`.
 */
export function mcpContent(value: unknown): McpResponse {
  return typeof value === "string" ? mcpText(value) : mcpJson(value);
}

/** Machine-readable MCP error response for tools that agents branch on. */
export function mcpStructuredError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): McpResponse {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: { code, message, ...details } }, null, 2),
    }],
  };
}

export function workspaceNotFoundError(workspaceId: string): McpResponse {
  return mcpStructuredError("WORKSPACE_NOT_FOUND", "Workspace not found", { workspaceId });
}

export function workspaceClosedError(workspaceId: string): McpResponse {
  return mcpStructuredError("WORKSPACE_CLOSED", "Workspace is closed", { workspaceId });
}

export function workspaceMissingWorkingDirError(workspaceId: string): McpResponse {
  return mcpStructuredError("WORKSPACE_WORKING_DIR_MISSING", "Workspace has no working directory", { workspaceId });
}

/**
 * Checks a query result array and returns either the first row (ok) or an MCP
 * error response (not ok). Eliminates the 20+ copy-pasted `if (rows.length ===
 * 0) return { content: [{ type: "text", text: "X not found" }] }` blocks.
 *
 * Usage:
 * ```ts
 * const r = requireEntity(rows, id, "Issue");
 * if (!r.ok) return r.error;
 * const issue = r.value;
 * ```
 */
export function requireEntity<T>(
  rows: T[],
  id: string,
  name: string,
): { ok: true; value: T } | { ok: false; error: McpResponse } {
  if (rows.length === 0) {
    return { ok: false, error: mcpError(`${name} ${id} not found`) };
  }
  return { ok: true, value: rows[0] };
}

/**
 * Resolves the project to operate on: the explicitly-provided id when present,
 * otherwise the `activeProjectId` preference. Returns a standardized
 * "No active project" MCP error when neither is available.
 *
 * Replaces the ~10 copy-pasted `if (!pid) { ...preferences lookup...; return "No
 * active project" }` blocks across the project-scoped tools.
 *
 * Usage:
 * ```ts
 * const r = await resolveActiveProjectId(db, schema, projectId);
 * if (!r.ok) return r.error;
 * const pid = r.projectId;
 * ```
 */
export async function resolveActiveProjectId(
  db: ToolDb,
  schema: typeof schemaModule,
  providedId?: string,
): Promise<{ ok: true; projectId: string } | { ok: false; error: McpResponse }> {
  const projectId = await resolveActiveProjectIdOrNull(db, schema, providedId);
  if (!projectId) {
    return {
      ok: false,
      error: mcpError("No active project. Run `pnpm cli -- register <path>` first."),
    };
  }
  return { ok: true, projectId };
}

/**
 * The same resolution WITHOUT the standard MCP error — for the two tools that answer a
 * missing project in their own shape (`workflow-templates` with a per-tool message,
 * `wait_workspace` with its `{result:"error"}` contract). They each re-implemented the
 * preference query, which is how a change to the preference key would have missed them (#508).
 */
export async function resolveActiveProjectIdOrNull(
  db: ToolDb,
  schema: typeof schemaModule,
  providedId?: string,
): Promise<string | null> {
  if (providedId) return providedId;
  const pref = await db
    .select({ value: schema.preferences.value })
    .from(schema.preferences)
    .where(eq(schema.preferences.key, "activeProjectId"))
    .limit(1);
  return pref[0]?.value || null;
}

/**
 * Project name for a resolved project id, or `null` when the id names no row.
 *
 * Exists so every scoped WRITE can ECHO the project it actually landed in (#335,
 * remedy R2's complement). `resolveActiveProjectId` silently falls back to the
 * global mutable `activeProjectId` preference, so an agent that forgot `projectId`
 * files into whatever project a human last clicked. Naming the project in the
 * response does not prevent that mis-filing, but it makes it VISIBLE instead of
 * silent — the caller sees `projectName` and can move the issue.
 */
export async function resolveProjectName(
  db: ToolDb,
  schema: typeof schemaModule,
  projectId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/**
 * Resolves a status column by name within a project.
 * Returns the status ID on success, or an MCP error response listing available
 * statuses on failure.
 *
 * Replaces the duplicate status-lookup blocks in create-issue, update-issue,
 * and move-issue.
 */
export async function resolveStatusByName(
  db: ToolDb,
  schema: typeof schemaModule,
  projectId: string,
  statusName: string,
): Promise<{ ok: true; statusId: string } | { ok: false; error: McpResponse }> {
  const statuses = await db
    .select()
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.projectId, projectId))
    .orderBy(schema.projectStatuses.sortOrder);
  const found = statuses.find((s) => s.name === statusName);
  if (!found) {
    return {
      ok: false,
      error: mcpError(
        `Status '${statusName}' not found. Available: ${statuses.map((s) => s.name).join(", ")}`,
      ),
    };
  }
  return { ok: true, statusId: found.id };
}

/**
 * Guard for terminal-status moves: is there an open, non-direct, unmerged
 * workspace for this issue? Direct workspaces (isDirect=true) commit straight to
 * master — no branch to merge — so they are excluded. Moving an issue to a
 * terminal status (Done/Cancelled) while such a workspace is open strands the
 * branch and causes silent merge loss (AK-535).
 *
 * The guard QUERY now lives in the shared `issue-status-orchestration` seam
 * (arch-review #974), consumed by BOTH the server issue service and these MCP
 * tools so they can no longer drift; this thin wrapper adapts the shared
 * `{ id, branch } | null` result into the `{ blocked, workspaceId, branch }`
 * shape the move_issue/update_issue call sites branch on. The `schema` param is
 * kept for call-site compatibility.
 */
export async function checkOpenUnmergedWorkspace(
  db: ToolDb,
  _schema: typeof schemaModule,
  issueId: string,
): Promise<{ blocked: boolean; workspaceId?: string; branch?: string }> {
  const openWs = await findOpenUnmergedWorkspace(db, issueId);
  if (!openWs) return { blocked: false };
  return { blocked: true, workspaceId: openWs.id, branch: openWs.branch };
}

/**
 * Returns the next available issue number for a project (max existing + 1).
 * Replaces the duplicate `max(issueNumber)` SQL in create-issue and
 * create-issues-batch.
 */
export async function nextIssueNumber(
  db: ToolDb,
  schema: typeof schemaModule,
  projectId: string,
): Promise<number> {
  return sharedNextIssueNumber(db as never, schema.issues, projectId);
}
