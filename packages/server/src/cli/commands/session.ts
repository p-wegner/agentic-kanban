import type { Command } from "commander";
import { db } from "../../db/index.js";
import { issues, projectStatuses, workspaces, sessions, sessionMessages, diffComments } from "@agentic-kanban/shared/schema";
import { eq, inArray, desc, gte, isNotNull, and } from "drizzle-orm";
import { parseSessionSummary, computeFrictionStats } from "@agentic-kanban/shared";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { getSessionMessageRows } from "../../repositories/session.repository.js";

export function registerSessionCommand(program: Command) {
  const sessionCmd = program.command("session").description("Inspect agent sessions.\n\nSubcommands: analyze, recent, backfill-friction, review-effectiveness");

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

        const msgRows = await getSessionMessageRows(sessionId);

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

  sessionCmd
    .command("backfill-friction")
    .description("Populate friction stats (tool failures, repeated commands, errors) for past sessions from their stored messages, so /api/insights friction covers history. Idempotent — skips sessions that already have friction.")
    .option("--hours <n>", "Only backfill sessions started within the last N hours", "48")
    .option("--all", "Backfill all sessions regardless of age (overrides --hours)")
    .option("--force", "Recompute friction even for sessions that already have it")
    .action(async (options: { hours?: string; all?: boolean; force?: boolean }) => {
      try {
        await runMigrations();

        const whereClause = options.all
          ? isNotNull(sessions.endedAt)
          : and(
              isNotNull(sessions.endedAt),
              gte(
                sessions.startedAt,
                new Date(Date.now() - Math.max(1, parseInt(options.hours ?? "48", 10) || 48) * 60 * 60 * 1000).toISOString(),
              ),
            );

        const candidates = await db
          .select({ id: sessions.id, stats: sessions.stats })
          .from(sessions)
          .where(whereClause);

        let scanned = 0, updated = 0, skipped = 0, empty = 0;
        for (const s of candidates) {
          scanned++;
          let stats: Record<string, unknown> = {};
          if (s.stats) {
            try { stats = JSON.parse(s.stats) as Record<string, unknown>; } catch { stats = {}; }
          }
          if (stats.friction && !options.force) { skipped++; continue; }

          const msgRows = await getSessionMessageRows(s.id);

          const summary = parseSessionSummary(msgRows);
          const friction = computeFrictionStats(summary);
          if (friction.totalToolCalls === 0 && friction.errorCount === 0 && friction.repeatedCommands.length === 0) {
            empty++;
            continue;
          }
          stats.friction = friction;
          await db.update(sessions).set({ stats: JSON.stringify(stats) }).where(eq(sessions.id, s.id));
          updated++;
        }

        console.log(JSON.stringify({ scanned, updated, skipped, empty }, null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  sessionCmd
    .command("review-effectiveness")
    .description(
      "Measure how the ticket-implementation workflow interacts with AI code review over a window.\n" +
        "Reconstructs each ticket's build->review->merge lifecycle from sessions + workspaces + diff comments.\n" +
        "Code-review agent runs are identified by triggerType 'review' or 'skill:code-review*'.",
    )
    .option("--days <n>", "Window size in days", "14")
    .option("--project <id>", "Project id (defaults to the active project)")
    .option("--json", "Emit machine-readable JSON instead of a formatted report")
    .option(
      "--deep",
      "Also load each review session's transcript and classify its self-reported verdict (approve vs changes-requested). Slower.",
    )
    .action(async (options: { days?: string; project?: string; json?: boolean; deep?: boolean }) => {
      try {
        await runMigrations();

        const days = Math.max(1, parseInt(options.days ?? "14", 10) || 14);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const projectId = options.project ?? (await getActiveProjectId());

        // All sessions in the window for this project, joined to their workspace + issue,
        // ordered chronologically so we can reconstruct each ticket's lifecycle.
        const rows = await db
          .select({
            sessionId: sessions.id,
            triggerType: sessions.triggerType,
            executor: sessions.executor,
            startedAt: sessions.startedAt,
            endedAt: sessions.endedAt,
            sessionStatus: sessions.status,
            stats: sessions.stats,
            workspaceId: workspaces.id,
            branch: workspaces.branch,
            wsStatus: workspaces.status,
            provider: workspaces.provider,
            mergedAt: workspaces.mergedAt,
            readyForMerge: workspaces.readyForMerge,
            requiresReview: workspaces.requiresReview,
            thoroughReview: workspaces.thoroughReview,
            scorecardScore: workspaces.scorecardScore,
            issueNumber: issues.issueNumber,
            issueTitle: issues.title,
            issueType: issues.issueType,
          })
          .from(sessions)
          .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
          .innerJoin(issues, eq(workspaces.issueId, issues.id))
          .where(and(eq(issues.projectId, projectId), gte(sessions.startedAt, sinceIso)))
          .orderBy(sessions.startedAt);

        // Diff comments (concrete review findings) for the involved workspaces.
        const wsIds = [...new Set(rows.map((r) => r.workspaceId))];
        const commentRows = wsIds.length
          ? await db
              .select({ workspaceId: diffComments.workspaceId, resolvedAt: diffComments.resolvedAt })
              .from(diffComments)
              .where(inArray(diffComments.workspaceId, wsIds))
          : [];

        const classify = (t: string | null): "review" | "build" | "rework" | "noise" | "other" => {
          if (!t) return "build"; // legacy initial sessions have null triggerType
          if (t === "review" || t.startsWith("skill:code-review")) return "review";
          if (t.startsWith("skill:board-monitor") || t.startsWith("skill:board-navigator")) return "noise";
          if (t === "chat" || t === "fix-and-merge" || t === "fix-conflicts" || t === "plan-reject") return "rework";
          if (t === "verify" || t === "learning" || t === "bisect" || t === "reconcile") return "other";
          return "build"; // agent, auto-start, manual, plan-implement, skill:<other>
        };

        const parseStats = (raw: string | null) => {
          if (!raw) return { cost: 0, durationMs: 0, turns: 0 };
          try {
            const s = JSON.parse(raw) as Record<string, unknown>;
            return {
              cost: typeof s.totalCostUsd === "number" ? s.totalCostUsd : 0,
              durationMs: typeof s.durationMs === "number" ? s.durationMs : 0,
              turns: typeof s.numTurns === "number" ? s.numTurns : 0,
            };
          } catch {
            return { cost: 0, durationMs: 0, turns: 0 };
          }
        };

        // Aggregate per workspace (one workspace == one attempt at a ticket).
        type WS = {
          workspaceId: string;
          issueNumber: number;
          issueTitle: string;
          issueType: string;
          branch: string;
          provider: string | null;
          wsStatus: string;
          mergedAt: string | null;
          readyForMerge: boolean;
          requiresReview: boolean;
          scorecardScore: number | null;
          builds: number;
          reviews: number;
          reworks: number;
          firstReviewAt: string | null;
          lastReviewAt: string | null;
          changeAfterReview: boolean; // a build/rework session started AFTER the first review => review bounced it back
          reviewCost: number;
          buildCost: number;
          reviewDurationMs: number;
          comments: number;
          commentsResolved: number;
          reviewSessionIds: string[];
        };
        const byWs = new Map<string, WS>();
        const commentsByWs = new Map<string, { total: number; resolved: number }>();
        for (const c of commentRows) {
          const e = commentsByWs.get(c.workspaceId) ?? { total: 0, resolved: 0 };
          e.total++;
          if (c.resolvedAt) e.resolved++;
          commentsByWs.set(c.workspaceId, e);
        }

        const triggerDist: Record<string, number> = {};

        for (const r of rows) {
          triggerDist[r.triggerType ?? "(null)"] = (triggerDist[r.triggerType ?? "(null)"] ?? 0) + 1;
          const kind = classify(r.triggerType);
          if (kind === "noise") continue;

          let ws = byWs.get(r.workspaceId);
          if (!ws) {
            const cm = commentsByWs.get(r.workspaceId) ?? { total: 0, resolved: 0 };
            ws = {
              workspaceId: r.workspaceId,
              issueNumber: r.issueNumber,
              issueTitle: r.issueTitle,
              issueType: r.issueType,
              branch: r.branch,
              provider: r.provider,
              wsStatus: r.wsStatus,
              mergedAt: r.mergedAt,
              readyForMerge: r.readyForMerge,
              requiresReview: r.requiresReview,
              scorecardScore: r.scorecardScore,
              builds: 0,
              reviews: 0,
              reworks: 0,
              firstReviewAt: null,
              lastReviewAt: null,
              changeAfterReview: false,
              reviewCost: 0,
              buildCost: 0,
              reviewDurationMs: 0,
              comments: cm.total,
              commentsResolved: cm.resolved,
              reviewSessionIds: [],
            };
            byWs.set(r.workspaceId, ws);
          }
          const st = parseStats(r.stats);
          if (kind === "review") {
            ws.reviews++;
            ws.reviewCost += st.cost;
            ws.reviewDurationMs += st.durationMs;
            ws.reviewSessionIds.push(r.sessionId);
            if (!ws.firstReviewAt) ws.firstReviewAt = r.startedAt;
            ws.lastReviewAt = r.startedAt;
          } else if (kind === "build") {
            ws.builds++;
            ws.buildCost += st.cost;
            if (ws.firstReviewAt && r.startedAt > ws.firstReviewAt) ws.changeAfterReview = true;
          } else if (kind === "rework") {
            ws.reworks++;
            ws.buildCost += st.cost;
            if (ws.firstReviewAt && r.startedAt > ws.firstReviewAt) ws.changeAfterReview = true;
          }
        }

        const all = [...byWs.values()];
        // "Implementation tickets": workspaces that actually had build/rework work in the window.
        const impl = all.filter((w) => w.builds > 0 || w.reworks > 0);
        const reviewed = all.filter((w) => w.reviews > 0);
        const mergedInWindow = all.filter((w) => w.mergedAt && w.mergedAt >= sinceIso);
        const mergedReviewed = mergedInWindow.filter((w) => w.reviews > 0);
        const mergedUnreviewed = mergedInWindow.filter((w) => w.reviews === 0);
        const reviewsLeadingToChange = reviewed.filter((w) => w.changeAfterReview);
        const reviewedWithComments = reviewed.filter((w) => w.comments > 0);

        const totalReviewRuns = all.reduce((s, w) => s + w.reviews, 0);
        const totalBuildRuns = all.reduce((s, w) => s + w.builds, 0);
        const totalReworkRuns = all.reduce((s, w) => s + w.reworks, 0);
        const totalComments = all.reduce((s, w) => s + w.comments, 0);
        const totalCommentsResolved = all.reduce((s, w) => s + w.commentsResolved, 0);
        const reviewCost = all.reduce((s, w) => s + w.reviewCost, 0);
        const buildCost = all.reduce((s, w) => s + w.buildCost, 0);

        const scores = reviewed.map((w) => w.scorecardScore).filter((s): s is number => typeof s === "number");
        const median = (xs: number[]) => {
          if (!xs.length) return null;
          const sorted = [...xs].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
        };
        const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
        const scoreBuckets = { "90-100": 0, "75-89": 0, "60-74": 0, "<60": 0 };
        for (const s of scores) {
          if (s >= 90) scoreBuckets["90-100"]++;
          else if (s >= 75) scoreBuckets["75-89"]++;
          else if (s >= 60) scoreBuckets["60-74"]++;
          else scoreBuckets["<60"]++;
        }

        // Optional deep pass: classify each review session's self-reported verdict from its transcript.
        let verdicts: { approve: number; changesRequested: number; unclear: number } | undefined;
        if (options.deep) {
          verdicts = { approve: 0, changesRequested: 0, unclear: 0 };
          const reviewSessionIds = all.flatMap((w) => w.reviewSessionIds);
          for (const sid of reviewSessionIds) {
            const msgRows = await getSessionMessageRows(sid);
            const summary = parseSessionSummary(msgRows);
            const text = (summary.agentSummary ?? "").toLowerCase();
            const approve = /ready for merge|marking .*ready|approved|no critical or major|lgtm/.test(text);
            const changes = /request changes|moving .*back to in progress|moved .*to in progress|needs fixes|requires changes|back to the agent|critical issue|major issue/.test(text);
            if (changes && !approve) verdicts.changesRequested++;
            else if (approve && !changes) verdicts.approve++;
            else if (approve && changes) verdicts.approve++; // approved despite noting issues
            else verdicts.unclear++;
          }
        }

        const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

        const report = {
          window: { days, since: sinceIso, projectId },
          totals: {
            sessionsInWindow: rows.length,
            ticketAttemptsTouched: all.length,
            implementationAttempts: impl.length,
            mergedInWindow: mergedInWindow.length,
            buildRuns: totalBuildRuns,
            reviewRuns: totalReviewRuns,
            reworkRuns: totalReworkRuns,
          },
          reviewCoverage: {
            attemptsReviewed: reviewed.length,
            pctOfImplReviewed: pct(impl.filter((w) => w.reviews > 0).length, impl.length),
            mergedReviewedBeforeLanding: mergedReviewed.length,
            pctOfMergedReviewed: pct(mergedReviewed.length, mergedInWindow.length),
            mergedWithoutReview: mergedUnreviewed.map((w) => ({ issue: w.issueNumber, title: w.issueTitle, status: w.wsStatus })),
          },
          reviewImpact: {
            reviewsThatBouncedBackToWork: reviewsLeadingToChange.length,
            pctReviewsLeadingToChange: pct(reviewsLeadingToChange.length, reviewed.length),
            avgReviewRoundsPerReviewedTicket: avg(reviewed.map((w) => w.reviews)),
            avgBuildRunsPerImplTicket: avg(impl.map((w) => w.builds + w.reworks)),
            diffCommentsRaised: totalComments,
            diffCommentsResolved: totalCommentsResolved,
            pctCommentsResolved: pct(totalCommentsResolved, totalComments),
            ticketsWithReviewComments: reviewedWithComments.length,
          },
          scorecard: {
            note: "Heuristic health score (tests/types/scope/diff-size/conflicts/docs), NOT the LLM reviewer's verdict.",
            count: scores.length,
            avg: avg(scores),
            median: median(scores),
            min: scores.length ? Math.min(...scores) : null,
            max: scores.length ? Math.max(...scores) : null,
            buckets: scoreBuckets,
            lowScoreMergedAnyway: mergedReviewed.filter((w) => typeof w.scorecardScore === "number" && w.scorecardScore < 60).map((w) => ({ issue: w.issueNumber, score: w.scorecardScore })),
          },
          cost: {
            reviewCostUsd: Math.round(reviewCost * 100) / 100,
            buildCostUsd: Math.round(buildCost * 100) / 100,
            reviewPctOfTotalCost: pct(reviewCost, reviewCost + buildCost),
          },
          providerSplit: {
            reviewsByExecutor: countBy(rows.filter((r) => classify(r.triggerType) === "review"), (r) => r.executor),
            buildsByExecutor: countBy(rows.filter((r) => classify(r.triggerType) === "build"), (r) => r.executor),
          },
          verdicts,
          triggerTypeDistribution: triggerDist,
          perTicket: impl
            .sort((a, b) => a.issueNumber - b.issueNumber)
            .map((w) => ({
              issue: w.issueNumber,
              title: w.issueTitle.slice(0, 50),
              provider: w.provider,
              builds: w.builds,
              reviews: w.reviews,
              reworks: w.reworks,
              changeAfterReview: w.changeAfterReview,
              comments: w.comments,
              scorecard: w.scorecardScore,
              merged: !!w.mergedAt,
              wsStatus: w.wsStatus,
            })),
        };

        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          process.exit(0);
        }

        // Human-readable report.
        const L: string[] = [];
        L.push(`\n=== AI Code-Review Effectiveness — last ${days}d (project ${projectId.slice(0, 8)}) ===`);
        L.push(`Sessions in window: ${rows.length}  |  ticket attempts: ${all.length}  |  with build work: ${impl.length}  |  merged in window: ${mergedInWindow.length}`);
        L.push(`Run mix: ${totalBuildRuns} build · ${totalReviewRuns} review · ${totalReworkRuns} rework`);
        L.push(`\n-- Review coverage --`);
        L.push(`  Implementation attempts reviewed:     ${impl.filter((w) => w.reviews > 0).length}/${impl.length}  (${pct(impl.filter((w) => w.reviews > 0).length, impl.length)}%)`);
        L.push(`  Merged tickets reviewed before landing: ${mergedReviewed.length}/${mergedInWindow.length}  (${pct(mergedReviewed.length, mergedInWindow.length)}%)`);
        if (mergedUnreviewed.length) {
          L.push(`  ⚠ Merged WITHOUT a review run in window: ${mergedUnreviewed.map((w) => "#" + w.issueNumber).join(", ")}`);
        }
        L.push(`\n-- Did reviews do real work? --`);
        L.push(`  Reviews that bounced a ticket back to building: ${reviewsLeadingToChange.length}/${reviewed.length}  (${pct(reviewsLeadingToChange.length, reviewed.length)}%)`);
        L.push(`  Avg review rounds / reviewed ticket:  ${report.reviewImpact.avgReviewRoundsPerReviewedTicket ?? "-"}`);
        L.push(`  Avg build runs / impl ticket:         ${report.reviewImpact.avgBuildRunsPerImplTicket ?? "-"}`);
        L.push(`  Inline review findings (diff comments): ${totalComments} raised, ${totalCommentsResolved} resolved (${pct(totalCommentsResolved, totalComments)}%) across ${reviewedWithComments.length} tickets`);
        L.push(`\n-- Scorecard (heuristic health, not the reviewer's verdict) --`);
        L.push(`  n=${scores.length}  avg=${report.scorecard.avg ?? "-"}  median=${report.scorecard.median ?? "-"}  range=${report.scorecard.min ?? "-"}..${report.scorecard.max ?? "-"}`);
        L.push(`  Buckets: 90-100=${scoreBuckets["90-100"]}  75-89=${scoreBuckets["75-89"]}  60-74=${scoreBuckets["60-74"]}  <60=${scoreBuckets["<60"]}`);
        if (report.scorecard.lowScoreMergedAnyway.length) {
          L.push(`  ⚠ Low-score (<60) merged anyway: ${report.scorecard.lowScoreMergedAnyway.map((x) => `#${x.issue}(${x.score})`).join(", ")}`);
        }
        L.push(`\n-- Cost --`);
        L.push(`  Review: $${report.cost.reviewCostUsd}  ·  Build: $${report.cost.buildCostUsd}  ·  review = ${report.cost.reviewPctOfTotalCost}% of agent spend`);
        L.push(`\n-- Provider split --`);
        L.push(`  Reviews by executor:  ${JSON.stringify(report.providerSplit.reviewsByExecutor)}`);
        L.push(`  Builds  by executor:  ${JSON.stringify(report.providerSplit.buildsByExecutor)}`);
        if (verdicts) {
          L.push(`\n-- Review self-reported verdicts (deep, heuristic text parse) --`);
          L.push(`  approve=${verdicts.approve}  changes-requested=${verdicts.changesRequested}  unclear=${verdicts.unclear}`);
        }
        L.push(`\n-- Per-ticket lifecycle --`);
        L.push(`  ${"issue".padEnd(7)}${"prov".padEnd(8)}${"bld".padEnd(4)}${"rev".padEnd(4)}${"rwk".padEnd(4)}${"chg".padEnd(4)}${"cmt".padEnd(4)}${"score".padEnd(6)}${"merged".padEnd(7)}title`);
        for (const t of report.perTicket) {
          L.push(
            `  ${("#" + t.issue).padEnd(7)}${String(t.provider ?? "?").padEnd(8)}${String(t.builds).padEnd(4)}${String(t.reviews).padEnd(4)}${String(t.reworks).padEnd(4)}${(t.changeAfterReview ? "Y" : "·").padEnd(4)}${String(t.comments).padEnd(4)}${String(t.scorecard ?? "-").padEnd(6)}${(t.merged ? "yes" : t.wsStatus).padEnd(7)}${t.title}`,
          );
        }
        L.push(`\nTrigger types seen: ${JSON.stringify(triggerDist)}`);
        L.push("");
        console.log(L.join("\n"));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it) || "(unknown)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
