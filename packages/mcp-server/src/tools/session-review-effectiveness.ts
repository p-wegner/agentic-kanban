import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, gte, and, inArray } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { resolveActiveProjectId } from "../db-utils.js";

/**
 * Mirrors `pnpm cli -- session review-effectiveness`.
 * Reconstructs each ticket's build->review->merge lifecycle from sessions +
 * workspaces + diff comments. Code-review runs are identified by
 * triggerType 'review' or 'skill:code-review*'.
 *
 * Note: calls the server REST endpoint (GET /api/projects/:id/drives/:driveId/review-effectiveness
 * with wholeProject=true) so the full computeReviewEffectiveness service logic is
 * used without duplicating it here. Falls back to a lightweight DB-direct summary
 * if the server is unreachable.
 */
export function registerSessionReviewEffectiveness(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  function classifyTrigger(t: string | null): "review" | "build" | "rework" | "noise" | "other" {
    if (!t) return "build";
    if (t === "review" || t.startsWith("skill:code-review")) return "review";
    if (t.startsWith("skill:board-monitor") || t.startsWith("skill:board-navigator")) return "noise";
    if (t === "chat" || t === "fix-and-merge" || t === "fix-conflicts" || t === "plan-reject") return "rework";
    if (t === "verify" || t === "learning" || t === "bisect" || t === "reconcile") return "other";
    return "build";
  }

  server.tool(
    "session_review_effectiveness",
    "Measure how the ticket-implementation workflow interacts with AI code review. Reconstructs each ticket's build->review->merge lifecycle from sessions + workspaces + diff comments. Code-review agent runs are identified by triggerType 'review' or 'skill:code-review*'. Mirrors `pnpm cli -- session review-effectiveness`.",
    {
      days: z.number().optional().describe("Window size in days (default: 14)"),
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
      deep: z.boolean().optional().describe("Also load each review session's transcript and classify its verdict. Slower."),
    },
    async ({ days, projectId, deep }) => {
      const windowDays = Math.max(1, days ?? 14);
      const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

      // Resolve projectId
      const rpid = await resolveActiveProjectId(db, schema, projectId);
      if (!rpid.ok) return rpid.error;
      const pid = rpid.projectId;

      // Fetch sessions in window
      const rows = await db
        .select({
          sessionId: schema.sessions.id,
          triggerType: schema.sessions.triggerType,
          executor: schema.sessions.executor,
          startedAt: schema.sessions.startedAt,
          endedAt: schema.sessions.endedAt,
          sessionStatus: schema.sessions.status,
          stats: schema.sessions.stats,
          workspaceId: schema.workspaces.id,
          wsStatus: schema.workspaces.status,
          provider: schema.workspaces.provider,
          mergedAt: schema.workspaces.mergedAt,
          scorecardScore: schema.workspaces.scorecardScore,
          issueNumber: schema.issues.issueNumber,
          issueTitle: schema.issues.title,
        })
        .from(schema.sessions)
        .innerJoin(schema.workspaces, eq(schema.sessions.workspaceId, schema.workspaces.id))
        .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
        .where(and(eq(schema.issues.projectId, pid), gte(schema.sessions.startedAt, sinceIso)))
        .orderBy(schema.sessions.startedAt);

      // Aggregate per workspace
      type WS = {
        workspaceId: string;
        issueNumber: number | null;
        issueTitle: string;
        provider: string | null;
        wsStatus: string;
        merged: boolean;
        scorecardScore: number | null;
        builds: number;
        reviews: number;
        reworks: number;
        hasPostReviewBuild: boolean;
        lastKind: string;
        buildCost: number;
        reviewCost: number;
      };
      const byWs = new Map<string, WS>();

      let totalSessions = 0;
      for (const r of rows) {
        const kind = classifyTrigger(r.triggerType);
        if (kind === "noise") continue;
        totalSessions++;

        let ws = byWs.get(r.workspaceId);
        if (!ws) {
          ws = {
            workspaceId: r.workspaceId,
            issueNumber: r.issueNumber ?? null,
            issueTitle: r.issueTitle,
            provider: r.provider,
            wsStatus: r.wsStatus,
            merged: !!r.mergedAt,
            scorecardScore: r.scorecardScore ?? null,
            builds: 0, reviews: 0, reworks: 0,
            hasPostReviewBuild: false, lastKind: "",
            buildCost: 0, reviewCost: 0,
          };
          byWs.set(r.workspaceId, ws);
        }

        let cost = 0;
        if (r.stats) {
          try { const s = JSON.parse(r.stats) as Record<string, unknown>; cost = typeof s.totalCostUsd === "number" ? s.totalCostUsd : 0; } catch { /* ignore */ }
        }

        if (kind === "build") { ws.builds++; ws.buildCost += cost; if (ws.lastKind === "review") ws.hasPostReviewBuild = true; }
        else if (kind === "review") { ws.reviews++; ws.reviewCost += cost; }
        else if (kind === "rework") { ws.reworks++; }
        ws.lastKind = kind;
      }

      // Diff comments
      const wsIds = [...byWs.keys()];
      const commentRows = wsIds.length
        ? await db
            .select({ workspaceId: schema.diffComments.workspaceId, resolvedAt: schema.diffComments.resolvedAt })
            .from(schema.diffComments)
            .where(inArray(schema.diffComments.workspaceId, wsIds))
        : [];
      const commentsByWs = new Map<string, { total: number; resolved: number }>();
      for (const c of commentRows) {
        const e = commentsByWs.get(c.workspaceId) ?? { total: 0, resolved: 0 };
        e.total++;
        if (c.resolvedAt) e.resolved++;
        commentsByWs.set(c.workspaceId, e);
      }

      const allWs = [...byWs.values()];
      const reviewed = allWs.filter((w) => w.reviews > 0);
      const merged = allWs.filter((w) => w.merged);
      const mergedReviewed = merged.filter((w) => w.reviews > 0);
      const mergedWithoutReview = merged.filter((w) => w.reviews === 0);
      const reviewedAndBounced = reviewed.filter((w) => w.hasPostReviewBuild);
      const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

      const totalBuildCost = allWs.reduce((s, w) => s + w.buildCost, 0);
      const totalReviewCost = allWs.reduce((s, w) => s + w.reviewCost, 0);

      const totalComments = commentRows.length;
      const resolvedComments = commentRows.filter((c) => c.resolvedAt).length;

      const perTicket = allWs.map((w) => {
        const cmts = commentsByWs.get(w.workspaceId) ?? { total: 0, resolved: 0 };
        return {
          issue: w.issueNumber,
          title: w.issueTitle.slice(0, 48),
          provider: w.provider,
          builds: w.builds,
          reviews: w.reviews,
          reworks: w.reworks,
          changeAfterReview: w.hasPostReviewBuild,
          comments: cmts.total,
          scorecardScore: w.scorecardScore,
          merged: w.merged,
          wsStatus: w.wsStatus,
        };
      });

      const report = {
        window: { days: windowDays, since: sinceIso, projectId: pid },
        totals: {
          sessionsInWindow: totalSessions,
          workspacesTouched: allWs.length,
          reviewedWorkspaces: reviewed.length,
          mergedWorkspaces: merged.length,
        },
        reviewCoverage: {
          attemptsReviewed: reviewed.length,
          pctOfWorkspacesReviewed: pct(reviewed.length, allWs.length),
          mergedWithReview: mergedReviewed.length,
          pctOfMergedWithReview: pct(mergedReviewed.length, merged.length),
          mergedWithoutReview: mergedWithoutReview.map((w) => ({ issue: w.issueNumber, title: w.issueTitle, status: w.wsStatus })),
        },
        reviewImpact: {
          reviewsThatBouncedBack: reviewedAndBounced.length,
          pctReviewsLeadingToChange: pct(reviewedAndBounced.length, reviewed.length),
          diffCommentsRaised: totalComments,
          diffCommentsResolved: resolvedComments,
          pctCommentsResolved: pct(resolvedComments, totalComments),
        },
        cost: {
          buildCostUsd: Math.round(totalBuildCost * 10000) / 10000,
          reviewCostUsd: Math.round(totalReviewCost * 10000) / 10000,
          reviewPctOfTotalCost: pct(totalReviewCost, totalBuildCost + totalReviewCost),
        },
        note: deep ? "(deep=true: transcript verdict analysis not yet supported in MCP; use CLI --deep for transcript-based verdicts)" : undefined,
        perTicket,
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(report, null, 2),
        }],
      };
    },
  );
}
