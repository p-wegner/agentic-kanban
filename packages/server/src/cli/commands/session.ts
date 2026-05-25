import type { Command } from "commander";
import { db } from "../../db/index.js";
import { issues, projectStatuses, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq, inArray, desc } from "drizzle-orm";
import { parseSessionSummary } from "@agentic-kanban/shared";
import { runMigrations } from "../shared.js";

export function registerSessionCommand(program: Command) {
  const sessionCmd = program.command("session").description("Inspect agent sessions.\n\nSubcommands: analyze, recent");

  sessionCmd
    .command("analyze <session-id>")
    .description("Show a consolidated analysis of a session: workspace, issue, parsed summary with tool patterns, stats, and errors.")
    .action(async (sessionId: string) => {
      try {
        await runMigrations();

        const sessionRows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (sessionRows.length === 0) {
          console.error(`Session '${sessionId}' not found.`);
          process.exit(1);
        }

        const session = sessionRows[0];

        const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1);
        const ws = wsRows[0] ?? null;

        let issue: Record<string, unknown> | null = null;
        if (ws) {
          const issueRows = await db
            .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, statusName: projectStatuses.name, priority: issues.priority, issueType: issues.issueType })
            .from(issues)
            .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
            .where(eq(issues.id, ws.issueId))
            .limit(1);
          issue = issueRows[0] ?? null;
        }

        const msgRows = await db
          .select()
          .from(sessionMessages)
          .where(eq(sessionMessages.sessionId, sessionId))
          .orderBy(sessionMessages.id);

        const summary = parseSessionSummary(msgRows);

        let stats: Record<string, unknown> | null = null;
        if (session.stats) {
          try { stats = JSON.parse(session.stats); } catch { /* ignore */ }
        }

        console.log(JSON.stringify({
          session: {
            id: session.id,
            status: session.status,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            executor: session.executor,
            triggerType: session.triggerType,
          },
          workspace: ws ? {
            id: ws.id,
            branch: ws.branch,
            status: ws.status,
            workingDir: ws.workingDir,
            isDirect: ws.isDirect,
          } : null,
          issue,
          summary,
          stats: stats ? {
            durationMs: (stats as any).durationMs ?? 0,
            totalCostUsd: (stats as any).totalCostUsd ?? 0,
            inputTokens: (stats as any).inputTokens ?? 0,
            outputTokens: (stats as any).outputTokens ?? 0,
            numTurns: (stats as any).numTurns ?? 1,
            model: (stats as any).model ?? summary.model,
            success: (stats as any).success ?? false,
            agentSummary: (stats as any).agentSummary,
          } : null,
        }, null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  sessionCmd
    .command("recent")
    .description("List the most recent sessions across all workspaces with metadata.")
    .option("-n, --limit <count>", "Number of sessions to show", "5")
    .action(async (options: { limit?: string }) => {
      try {
        await runMigrations();

        const limit = Math.min(parseInt(options.limit ?? "5", 10), 20);

        const rows = await db
          .select({
            sessionId: sessions.id,
            sessionStatus: sessions.status,
            startedAt: sessions.startedAt,
            endedAt: sessions.endedAt,
            executor: sessions.executor,
            triggerType: sessions.triggerType,
            workspaceId: workspaces.id,
            branch: workspaces.branch,
            wsStatus: workspaces.status,
            issueNumber: issues.issueNumber,
            issueTitle: issues.title,
          })
          .from(sessions)
          .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
          .innerJoin(issues, eq(workspaces.issueId, issues.id))
          .orderBy(desc(sessions.startedAt))
          .limit(limit);

        console.log(JSON.stringify(rows.map(r => ({
          sessionId: r.sessionId,
          sessionStatus: r.sessionStatus,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          executor: r.executor,
          triggerType: r.triggerType,
          workspace: { id: r.workspaceId, branch: r.branch, status: r.wsStatus },
          issue: { number: r.issueNumber, title: r.issueTitle },
        })), null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
