import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, isNotNull, gte, and } from "drizzle-orm";
import { parseSessionSummary, computeFrictionStats } from "@agentic-kanban/shared";
import { prodDeps, type ToolDeps } from "./deps.js";

/**
 * Mirrors `pnpm cli -- session backfill-friction`.
 * Populates friction stats (tool failures, repeated commands, errors) for past
 * sessions from their stored messages. Idempotent — skips sessions that already
 * have friction unless --force.
 */
export function registerBackfillFriction(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "backfill_friction",
    "Populate friction stats (tool failures, repeated commands, errors) for past sessions from their stored messages, so friction analysis covers history. Idempotent — skips sessions that already have friction data unless force=true. Mirrors `pnpm cli -- session backfill-friction`.",
    {
      hours: z.number().optional().describe("Only backfill sessions started within the last N hours (default: 48). Ignored when all=true."),
      all: z.boolean().optional().describe("Backfill all sessions regardless of age (overrides hours)"),
      force: z.boolean().optional().describe("Recompute friction even for sessions that already have it"),
    },
    async ({ hours, all, force }) => {
      const windowHours = Math.max(1, hours ?? 48);

      const whereClause = all
        ? isNotNull(schema.sessions.endedAt)
        : and(
            isNotNull(schema.sessions.endedAt),
            gte(
              schema.sessions.startedAt,
              new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString(),
            ),
          );

      const candidates = await db
        .select({ id: schema.sessions.id, stats: schema.sessions.stats })
        .from(schema.sessions)
        .where(whereClause);

      let scanned = 0, updated = 0, skipped = 0, empty = 0;

      for (const s of candidates) {
        scanned++;
        let stats: Record<string, unknown> = {};
        if (s.stats) {
          try { stats = JSON.parse(s.stats) as Record<string, unknown>; } catch { stats = {}; }
        }
        if (stats.friction && !force) { skipped++; continue; }

        const msgRows = await db
          .select({ type: schema.sessionMessages.type, data: schema.sessionMessages.data })
          .from(schema.sessionMessages)
          .where(eq(schema.sessionMessages.sessionId, s.id))
          .orderBy(schema.sessionMessages.id);

        const summary = parseSessionSummary(msgRows);
        const friction = computeFrictionStats(summary);

        if (friction.totalToolCalls === 0 && friction.errorCount === 0 && friction.repeatedCommands.length === 0) {
          empty++;
          continue;
        }

        stats.friction = friction;
        await db
          .update(schema.sessions)
          .set({ stats: JSON.stringify(stats) })
          .where(eq(schema.sessions.id, s.id));
        updated++;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ scanned, updated, skipped, empty }, null, 2),
        }],
      };
    },
  );
}
