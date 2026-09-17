import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { MERGE_TRAIN_STATES } from "@agentic-kanban/shared";
import { boardApi, boardErrorText, mcpJson, mcpText, mcpUnreachable } from "../board-call.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity } from "../db-utils.js";

/**
 * MCP surface for merge trains (#1195) — the batching/gating mechanism release trains use to
 * land several workspaces as one gate run. Everything about a train's lifecycle used to be
 * UI-only (the `MergeQueuePanel`) or REST-only (the #1153 cancel endpoint): no MCP tool, no
 * CLI command, so the Sentinel and the Conductor could only learn about a stranded or red
 * train by reading server logs.
 *
 * `list_merge_trains`/`get_merge_train` read the persisted rows directly (same shape as
 * `list_drives`/`get_drive`) since that data is already scoped to one project/train and needs
 * no cross-cutting authority. `cancel_merge_train`/`release_train_window` DELEGATE to the
 * existing REST routes (`POST /api/merge-queue/trains/:id/cancel`,
 * `POST /api/merge-queue/window/release`) rather than re-implementing their state checks and
 * board-event broadcasts, the same reasoning `merge_workspace` documents for its own delegation.
 */
export function registerListMergeTrains(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "list_merge_trains",
    "List merge trains for a project (newest first): persisted release-train rows covering in-flight (assembling/gating/landing) and terminal (landed/red/abandoned) history. Optionally filter by state.",
    {
      projectId: z.string().describe("The project ID"),
      state: z.enum(MERGE_TRAIN_STATES).optional().describe("Filter by train state"),
    },
    async ({ projectId, state }) => {
      const rows = await db.select().from(schema.mergeTrains)
        .where(eq(schema.mergeTrains.projectId, projectId))
        .orderBy(desc(schema.mergeTrains.startedAt));
      const filtered = state ? rows.filter((r) => r.state === state) : rows;
      return mcpJson(filtered);
    },
  );
}

export function registerGetMergeTrain(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "get_merge_train",
    "Get a single merge train by ID: the row plus its parsed gate evidence (landed/dropped/unresolved members, gate-run counts, mergeSha) and the full bisect-tree attempt list (#1189, one entry per assemble/gate/land cycle) in the order attempts finished.",
    {
      id: z.string().describe("The merge train ID"),
    },
    async ({ id }) => {
      const rows = await db.select().from(schema.mergeTrains).where(eq(schema.mergeTrains.id, id)).limit(1);
      const r = requireEntity(rows, id, "Merge train");
      if (!r.ok) return r.error;
      const row = r.value;

      let gateEvidence: unknown = null;
      try {
        gateEvidence = row.gateEvidence ? JSON.parse(row.gateEvidence) : null;
      } catch {
        gateEvidence = null;
      }
      let bisectResult: unknown = null;
      try {
        bisectResult = row.bisectResult ? JSON.parse(row.bisectResult) : null;
      } catch {
        bisectResult = null;
      }

      return mcpJson({
        ...row,
        gateEvidence,
        bisectResult,
        attempts: (gateEvidence as { attempts?: unknown[] } | null)?.attempts ?? [],
      });
    },
  );
}

export function registerCancelMergeTrain(server: McpServer, _deps: ToolDeps = prodDeps) {
  server.tool(
    "cancel_merge_train",
    "Cancel a merge train (#1153): the only remedy an operator had for a stranded train besides a full server restart. Marks the row abandoned with a reason. Fails with 409 when the train is already terminal (landed/red/abandoned). Delegates to the board server's cancel route so the state check and board-event broadcast run exactly once.",
    {
      id: z.string().describe("The merge train ID to cancel"),
    },
    async ({ id }) => {
      try {
        const { ok, statusText, data } = await boardApi(
          `/api/merge-queue/trains/${encodeURIComponent(id)}/cancel`,
          { method: "POST" },
        );
        if (!ok) return mcpText(`Cancel not completed: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}

export function registerReleaseTrainWindow(server: McpServer, _deps: ToolDeps = prodDeps) {
  server.tool(
    "release_train_window",
    "Operator 'depart now' for a project's merge-train batching window (#1186): requests an immediate release of the pending set as one train, regardless of size, wait, or a busy gate (a live hold still wins until it expires). Fails with 409 when the project has no open window. Delegates to the board server's window-release route.",
    {
      projectId: z.string().describe("The project ID"),
    },
    async ({ projectId }) => {
      try {
        const { ok, statusText, data } = await boardApi("/api/merge-queue/window/release", {
          method: "POST",
          body: JSON.stringify({ projectId }),
        });
        if (!ok) return mcpText(`Release not completed: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}
