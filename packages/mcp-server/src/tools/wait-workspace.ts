import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";

/**
 * Workspace statuses that mean the agent has finished its turn successfully.
 */
const SUCCESS_STATUSES = new Set(["idle", "ready_for_merge", "closed", "merged"]);

/**
 * Workspace statuses that represent a failure.
 */
const ERROR_STATUSES = new Set(["error", "failed"]);

function classifyStatus(status: string): "success" | "error" | "pending" {
  if (ERROR_STATUSES.has(status)) return "error";
  if (SUCCESS_STATUSES.has(status)) return "success";
  return "pending";
}

/**
 * wait_workspace — bounded-poll mirror of CLI `workspace wait <issue-number>`.
 *
 * A long-blocking WebSocket subscription is a poor fit for MCP tool calls
 * (they must return within a reasonable timeout). Instead this tool uses a
 * bounded poll: it resolves the latest workspace for the issue, then queries
 * the DB every ~2 s until the workspace reaches a terminal status or
 * `maxWaitSeconds` elapses.
 *
 * Terminal (success) statuses: idle, ready_for_merge, closed, merged.
 * Terminal (error) statuses: error, failed.
 *
 * The tool always returns — it never hangs indefinitely.
 */
export function registerWaitWorkspace(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "wait_workspace",
    "Poll until the latest workspace for an issue reaches a terminal status (idle, ready_for_merge, closed, merged, error, or failed). " +
      "Mirrors CLI `workspace wait <issue-number>` but uses a bounded DB poll instead of a WebSocket subscription " +
      "so it always returns within maxWaitSeconds. " +
      "Use this after launching a workspace to know when the agent is done. " +
      "Returns the final status and a result field ('success' | 'error' | 'timeout').",
    {
      issueNumber: z
        .number()
        .int()
        .positive()
        .describe("The kanban issue number (e.g. 42 for issue #42)"),
      projectId: z
        .string()
        .optional()
        .describe("Project ID. Defaults to the active project preference."),
      maxWaitSeconds: z
        .number()
        .int()
        .positive()
        .max(300)
        .optional()
        .describe("Maximum seconds to wait before returning with result='timeout'. Default 60, max 300."),
    },
    async ({ issueNumber, projectId, maxWaitSeconds }) => {
      const waitSec = Math.min(maxWaitSeconds ?? 60, 300);
      const pollIntervalMs = 2000;

      // 1. Resolve projectId
      let pid = projectId;
      if (!pid) {
        const pref = await db
          .select({ value: schema.preferences.value })
          .from(schema.preferences)
          .where(eq(schema.preferences.key, "activeProjectId"))
          .limit(1);
        if (pref.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { result: "error", reason: "No active project. Pass projectId or register a project first." },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        pid = pref[0].value;
      }

      // 2. Resolve issue by number
      const issueRows = await db
        .select({ id: schema.issues.id })
        .from(schema.issues)
        .where(and(eq(schema.issues.issueNumber, issueNumber), eq(schema.issues.projectId, pid)))
        .limit(1);

      if (issueRows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ result: "error", reason: `Issue #${issueNumber} not found in project ${pid}.` }, null, 2),
            },
          ],
        };
      }

      // 3. Resolve latest workspace for the issue
      const wsRows = await db
        .select({ id: schema.workspaces.id, status: schema.workspaces.status })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.issueId, issueRows[0].id))
        .orderBy(desc(schema.workspaces.updatedAt))
        .limit(1);

      if (wsRows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ result: "error", reason: `No workspace found for issue #${issueNumber}.` }, null, 2),
            },
          ],
        };
      }

      const workspaceId = wsRows[0].id;
      let currentStatus = wsRows[0].status;

      // 4. Fast-path: already terminal
      const initial = classifyStatus(currentStatus);
      if (initial !== "pending") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { result: initial, workspaceId, status: currentStatus, waited: 0 },
                null,
                2,
              ),
            },
          ],
        };
      }

      // 5. Bounded poll
      const deadline = Date.now() + waitSec * 1000;
      let elapsed = 0;

      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
        elapsed += pollIntervalMs;

        const rows = await db
          .select({ status: schema.workspaces.status })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId))
          .limit(1);

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { result: "error", reason: "Workspace no longer exists.", workspaceId },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        currentStatus = rows[0].status;
        const classification = classifyStatus(currentStatus);
        if (classification !== "pending") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { result: classification, workspaceId, status: currentStatus, waited: Math.round(elapsed / 1000) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      // Timeout
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                result: "timeout",
                workspaceId,
                status: currentStatus,
                waited: waitSec,
                message: `Workspace did not reach a terminal state within ${waitSec}s (last status: ${currentStatus}).`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
