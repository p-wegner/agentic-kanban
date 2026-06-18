import { eq, sql } from "drizzle-orm";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDb } from "./tools/deps.js";
import type * as schemaModule from "@agentic-kanban/shared/schema";

export type McpResponse = { content: Array<{ type: "text"; text: string }> };

/** Standardized MCP error response factory. */
export function mcpError(message: string): McpResponse {
  return { content: [{ type: "text" as const, text: message }] };
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
 * Read stdout content from the per-session .out file, or null when absent.
 * Mirrors the server-side readSessionStdoutFile — kept in sync manually.
 */
export function readSessionStdoutFile(sessionId: string): string | null {
  const outPath = join(tmpdir(), `kanban-session-${sessionId}.out`);
  if (!existsSync(outPath)) return null;
  try {
    const content = readFileSync(outPath, "utf-8");
    return content || null;
  } catch {
    return null;
  }
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
  if (providedId) return { ok: true, projectId: providedId };
  const pref = await db
    .select({ value: schema.preferences.value })
    .from(schema.preferences)
    .where(eq(schema.preferences.key, "activeProjectId"))
    .limit(1);
  if (pref.length === 0 || !pref[0].value) {
    return {
      ok: false,
      error: mcpError("No active project. Run `pnpm cli -- register <path>` first."),
    };
  }
  return { ok: true, projectId: pref[0].value };
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
 * Returns the next available issue number for a project (max existing + 1).
 * Replaces the duplicate `max(issueNumber)` SQL in create-issue and
 * create-issues-batch.
 */
export async function nextIssueNumber(
  db: ToolDb,
  schema: typeof schemaModule,
  projectId: string,
): Promise<number> {
  const maxResult = await db
    .select({ maxNum: sql<number | null>`max(${schema.issues.issueNumber})` })
    .from(schema.issues)
    .where(eq(schema.issues.projectId, projectId));
  return (maxResult[0]?.maxNum ?? 0) + 1;
}
