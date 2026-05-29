import { eq, sql } from "drizzle-orm";
import type { ToolDb } from "./tools/deps.js";
import type * as schemaModule from "@agentic-kanban/shared/schema";

export type McpResponse = { content: Array<{ type: "text"; text: string }> };

/** Standardized MCP error response factory. */
export function mcpError(message: string): McpResponse {
  return { content: [{ type: "text" as const, text: message }] };
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
