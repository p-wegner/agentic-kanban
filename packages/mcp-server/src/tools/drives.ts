import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIVE_STATUSES } from "@agentic-kanban/shared";
import { generateDriveRetro } from "@agentic-kanban/shared/lib/drive-retro";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity } from "../db-utils.js";

/**
 * MCP surface for the first-class Drive entity (#799): a Drive records an
 * autonomous epic push (target + completion contract + status) so it is
 * observable, resumable, and queryable rather than implicit in skill prose.
 */

export function registerStartDrive(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "start_drive",
    "Start a Drive: a first-class record of an autonomous epic push toward a target under a completion contract. Creates a Drive record (status='active') that survives a server restart and is queryable via list_drives/get_drive.",
    {
      projectId: z.string().describe("The project ID"),
      target: z.string().describe("What the drive is steering toward (the goal / what 'done' looks like)"),
      metaIssueId: z.string().optional().describe("The meta/epic issue ID this drive is pushing to completion (optional)"),
      completionContract: z.string().optional().describe("The explicit, checkable condition for finishing the drive (optional)"),
    },
    async ({ projectId, target, metaIssueId, completionContract }) => {
      if (!target.trim()) {
        return { content: [{ type: "text" as const, text: "Error: target is required" }] };
      }
      const projectRows = await db.select({ id: schema.projects.id })
        .from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
      const rp = requireEntity(projectRows, projectId, "Project");
      if (!rp.ok) return rp.error;

      const row = {
        id: randomUUID(),
        projectId,
        metaIssueId: metaIssueId ?? null,
        target: target.trim(),
        completionContract: completionContract ?? null,
        status: "active" as const,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      await db.insert(schema.drives).values(row);
      notifyBoard(projectId, "drive_started");

      return { content: [{ type: "text" as const, text: JSON.stringify(row, null, 2) }] };
    },
  );
}

export function registerListDrives(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "list_drives",
    "List all Drives for a project (most recently started first). A Drive records an autonomous epic push: its target, completion contract, status (active/completed/abandoned), and start/finish times.",
    {
      projectId: z.string().describe("The project ID"),
      status: z.enum(DRIVE_STATUSES).optional().describe("Filter by drive status"),
    },
    async ({ projectId, status }) => {
      const rows = await db.select().from(schema.drives)
        .where(eq(schema.drives.projectId, projectId))
        .orderBy(desc(schema.drives.startedAt));
      const filtered = status ? rows.filter((r) => r.status === status) : rows;
      return { content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }] };
    },
  );
}

export function registerGetDrive(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "get_drive",
    "Get a single Drive by ID, including its target, completion contract, status, and start/finish timestamps.",
    {
      driveId: z.string().describe("The drive ID"),
    },
    async ({ driveId }) => {
      const rows = await db.select().from(schema.drives).where(eq(schema.drives.id, driveId)).limit(1);
      const r = requireEntity(rows, driveId, "Drive");
      if (!r.ok) return r.error;
      return { content: [{ type: "text" as const, text: JSON.stringify(r.value, null, 2) }] };
    },
  );
}

export function registerFinishDrive(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "finish_drive",
    "Finish a Drive: set a terminal status ('completed' or 'abandoned') and stamp finishedAt. Use when the epic is fully merged (completed) or the drive is given up (abandoned).",
    {
      driveId: z.string().describe("The drive ID"),
      status: z.enum(["completed", "abandoned"]).optional().describe("Terminal status (default: completed)"),
    },
    async ({ driveId, status }) => {
      const rows = await db.select().from(schema.drives).where(eq(schema.drives.id, driveId)).limit(1);
      const r = requireEntity(rows, driveId, "Drive");
      if (!r.ok) return r.error;
      const finishedAt = new Date().toISOString();
      const finalStatus = status ?? "completed";
      await db.update(schema.drives)
        .set({ status: finalStatus, finishedAt })
        .where(eq(schema.drives.id, driveId));
      notifyBoard(r.value.projectId, "drive_finished");

      // #804: completing a drive auto-writes its retro from the event log. Best-effort
      // and non-fatal — a generation failure must not break finish_drive. Only on
      // "completed" (an abandoned drive has nothing to retro).
      let retroPath: string | null = null;
      if (finalStatus === "completed") {
        try {
          const retro = await generateDriveRetro({ ...r.value, status: finalStatus, finishedAt }, db);
          retroPath = retro?.path ?? null;
        } catch {
          // swallow — the drive is finished regardless of retro generation
        }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ ...r.value, status: finalStatus, finishedAt, retroPath }, null, 2) }] };
    },
  );
}
