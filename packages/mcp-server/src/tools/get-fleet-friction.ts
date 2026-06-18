import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, gte } from "drizzle-orm";
import type { SessionFrictionStats } from "@agentic-kanban/shared";
import { db, schema } from "../db.js";
import { resolveActiveProjectId } from "../db-utils.js";

/**
 * Fleet-level friction snapshot over a recent time window — the data backbone
 * for compounding-engineering analysis ("which tools fail, what do agents
 * repeat, which skills are inefficient"). Reads the persisted `friction` block
 * from `sessions.stats` (populated at session exit / via
 * `pnpm cli -- session backfill-friction`).
 */
export function registerGetFleetFriction(server: McpServer) {
  server.tool(
    "get_fleet_friction",
    "Aggregate agent-session friction (failed tool calls, repeated commands, error counts) across all sessions in a recent time window. Use to find systemic, compounding improvements (skills/hooks/helper scripts). Reads persisted friction stats; run `session backfill-friction` first if coverage is low.",
    {
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
      hours: z.number().optional().describe("Look-back window in hours (default: 48)"),
    },
    async ({ projectId, hours }) => {
      const windowHours = hours && hours > 0 ? hours : 48;

      const rpid = await resolveActiveProjectId(db, schema, projectId);
      if (!rpid.ok) return rpid.error;
      const pid = rpid.projectId;

      const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

      const rows = await db
        .select({
          stats: schema.sessions.stats,
          exitCode: schema.sessions.exitCode,
          skillName: schema.sessions.skillName,
          wsSkillName: schema.agentSkills.name,
        })
        .from(schema.sessions)
        .innerJoin(schema.workspaces, eq(schema.sessions.workspaceId, schema.workspaces.id))
        .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
        .leftJoin(schema.agentSkills, eq(schema.workspaces.skillId, schema.agentSkills.id))
        .where(and(eq(schema.issues.projectId, pid), gte(schema.sessions.startedAt, sinceIso)));

      const byTool = new Map<string, { calls: number; failed: number }>();
      const repeated = new Map<string, { count: number; sessions: number }>();
      let totalToolCalls = 0;
      let failedToolCalls = 0;
      let errorTotal = 0;
      let sessionsWithFriction = 0;

      for (const r of rows) {
        if (!r.stats) continue;
        let parsed: { friction?: SessionFrictionStats };
        try { parsed = JSON.parse(r.stats); } catch { continue; }
        const f = parsed.friction;
        if (!f) continue;
        sessionsWithFriction++;
        totalToolCalls += f.totalToolCalls;
        failedToolCalls += f.failedToolCalls;
        errorTotal += f.errorCount;
        for (const t of f.tools ?? []) {
          const e = byTool.get(t.tool) ?? { calls: 0, failed: 0 };
          e.calls += t.count;
          e.failed += t.failedCount;
          byTool.set(t.tool, e);
        }
        for (const rc of f.repeatedCommands ?? []) {
          const e = repeated.get(rc.command) ?? { count: 0, sessions: 0 };
          e.count += rc.count;
          e.sessions += 1;
          repeated.set(rc.command, e);
        }
      }

      const result = {
        projectId: pid,
        windowHours,
        sessionsInWindow: rows.length,
        sessionsWithFriction,
        coverage: rows.length > 0 ? Math.round((100 * sessionsWithFriction) / rows.length) / 100 : 0,
        totalToolCalls,
        failedToolCalls,
        failPct: totalToolCalls > 0 ? Math.round((100 * failedToolCalls) / totalToolCalls) : 0,
        errorTotal,
        byTool: [...byTool.entries()]
          .map(([tool, { calls, failed }]) => ({ tool, calls, failed, failPct: calls > 0 ? Math.round((100 * failed) / calls) : 0 }))
          .sort((a, b) => b.failed - a.failed || b.calls - a.calls)
          .slice(0, 20),
        topRepeatedCommands: [...repeated.entries()]
          .map(([command, { count, sessions }]) => ({ command, count, sessions }))
          .sort((a, b) => b.count - a.count || b.sessions - a.sessions)
          .slice(0, 15),
      };

      const hint = sessionsWithFriction === 0
        ? "\n\nNo friction stats found in this window. Run `pnpm cli -- session backfill-friction --hours " + windowHours + "` to populate from stored transcripts."
        : "";

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) + hint }] };
    },
  );
}
