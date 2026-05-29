import { and, eq, gte, inArray } from "drizzle-orm";
import {
  issues,
  projectStatuses,
  sessions,
  workspaces,
} from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";

/**
 * Standup Digest — "What changed since you were away".
 *
 * Pure server-side aggregation (no LLM, like the Insights route) of recent board
 * activity within a time window: issues created, issues completed, issues that
 * moved status, workspaces merged, agent sessions that ran, and which issues are
 * currently blocked. Modelled on `insights.ts`.
 */

const RANGE_HOURS = {
  "24h": 24,
  "3d": 72,
  "7d": 168,
} as const;

type DigestRange = keyof typeof RANGE_HOURS;

function parseRange(value: string | undefined): DigestRange {
  if (value === "24h" || value === "3d" || value === "7d") return value;
  return "24h";
}

/** Status names treated as "completed" terminal states for the digest. */
const DONE_STATUS_NAMES = new Set(["Done", "Cancelled"]);

interface DigestIssueRef {
  issueId: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  priority: string;
  issueType: string;
  at: string;
}

interface SessionDigestEntry {
  sessionId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  startedAt: string;
  endedAt: string | null;
  success: boolean;
  durationMs: number;
  costUsd: number;
  triggerType: string | null;
}

interface DigestData {
  range: DigestRange;
  since: string;
  now: string;
  created: DigestIssueRef[];
  completed: DigestIssueRef[];
  moved: DigestIssueRef[];
  merged: Array<{
    workspaceId: string;
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
    branch: string;
    closedAt: string;
  }>;
  sessions: SessionDigestEntry[];
  blocked: DigestIssueRef[];
  headline: {
    createdCount: number;
    completedCount: number;
    mergedCount: number;
    sessionCount: number;
    sessionSuccessCount: number;
    totalCostUsd: number;
    blockedCount: number;
    activeAgents: number;
  };
}

function parseStats(raw: string | null): { success: boolean; durationMs: number; costUsd: number } {
  if (!raw) return { success: false, durationMs: 0, costUsd: 0 };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      success: parsed.success === true,
      durationMs: Number(parsed.durationMs ?? 0),
      costUsd: Number(parsed.totalCostUsd ?? 0),
    };
  } catch {
    return { success: false, durationMs: 0, costUsd: 0 };
  }
}

export function createDigestRoute(database: Database = db) {
  const router = createRouter();

  // `now` is injectable for deterministic time-window tests (nowOverride pattern).
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);

    const range = parseRange(c.req.query("range"));
    const nowParam = c.req.query("now");
    const now = nowParam ? new Date(nowParam) : new Date();
    const since = new Date(now.getTime() - RANGE_HOURS[range] * 60 * 60 * 1000);
    const sinceIso = since.toISOString();

    // Status id -> name map for the project (small table, single query).
    const statusRows = await database
      .select({ id: projectStatuses.id, name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId));
    const statusName = new Map(statusRows.map((s) => [s.id, s.name]));

    // All issues for the project — we filter by timestamp in JS so a single read
    // covers created/completed/moved/blocked without four separate queries.
    const issueRows = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        statusId: issues.statusId,
        priority: issues.priority,
        issueType: issues.issueType,
        createdAt: issues.createdAt,
        statusChangedAt: issues.statusChangedAt,
      })
      .from(issues)
      .where(eq(issues.projectId, projectId));

    const created: DigestIssueRef[] = [];
    const completed: DigestIssueRef[] = [];
    const moved: DigestIssueRef[] = [];

    for (const row of issueRows) {
      const name = statusName.get(row.statusId) ?? "Unknown";
      const ref = (at: string): DigestIssueRef => ({
        issueId: row.id,
        issueNumber: row.issueNumber,
        title: row.title,
        statusName: name,
        priority: row.priority,
        issueType: row.issueType,
        at,
      });

      if (row.createdAt >= sinceIso) created.push(ref(row.createdAt));

      const changedAt = row.statusChangedAt;
      if (changedAt && changedAt >= sinceIso) {
        if (DONE_STATUS_NAMES.has(name)) completed.push(ref(changedAt));
        // Status change that wasn't a brand-new issue in the window = a "move".
        else if (row.createdAt < sinceIso) moved.push(ref(changedAt));
      }
    }

    created.sort((a, b) => b.at.localeCompare(a.at));
    completed.sort((a, b) => b.at.localeCompare(a.at));
    moved.sort((a, b) => b.at.localeCompare(a.at));

    // Merged workspaces in the window. A merge closes the workspace, so we look
    // for closed workspaces whose closedAt falls in the window.
    const issueIds = issueRows.map((r) => r.id);
    const issueMeta = new Map(issueRows.map((r) => [r.id, r]));

    const merged: DigestData["merged"] = [];
    const sessionEntries: SessionDigestEntry[] = [];
    let activeAgents = 0;

    if (issueIds.length > 0) {
      const wsRows = await database
        .select({
          id: workspaces.id,
          issueId: workspaces.issueId,
          branch: workspaces.branch,
          status: workspaces.status,
          closedAt: workspaces.closedAt,
        })
        .from(workspaces)
        .where(inArray(workspaces.issueId, issueIds));

      for (const ws of wsRows) {
        const meta = issueMeta.get(ws.issueId);
        if (ws.closedAt && ws.closedAt >= sinceIso) {
          merged.push({
            workspaceId: ws.id,
            issueId: ws.issueId,
            issueNumber: meta?.issueNumber ?? null,
            issueTitle: meta?.title ?? "(unknown)",
            branch: ws.branch,
            closedAt: ws.closedAt,
          });
        }
      }
      merged.sort((a, b) => b.closedAt.localeCompare(a.closedAt));

      const wsIds = wsRows.map((w) => w.id);
      const wsToIssue = new Map(wsRows.map((w) => [w.id, w.issueId]));

      if (wsIds.length > 0) {
        const sessionRows = await database
          .select({
            id: sessions.id,
            workspaceId: sessions.workspaceId,
            startedAt: sessions.startedAt,
            endedAt: sessions.endedAt,
            exitCode: sessions.exitCode,
            status: sessions.status,
            stats: sessions.stats,
            triggerType: sessions.triggerType,
          })
          .from(sessions)
          .where(and(inArray(sessions.workspaceId, wsIds), gte(sessions.startedAt, sinceIso)));

        for (const s of sessionRows) {
          if (s.status === "running") activeAgents += 1;
          const parsed = parseStats(s.stats);
          const issueId = wsToIssue.get(s.workspaceId) ?? "";
          const meta = issueMeta.get(issueId);
          sessionEntries.push({
            sessionId: s.id,
            issueId,
            issueNumber: meta?.issueNumber ?? null,
            issueTitle: meta?.title ?? "(unknown)",
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            success: parsed.success || s.exitCode === "0",
            durationMs: parsed.durationMs,
            costUsd: parsed.costUsd,
            triggerType: s.triggerType,
          });
        }
        sessionEntries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      }
    }

    // Currently-blocked issues (point-in-time, not windowed) — surfaced so the
    // digest doubles as a "what needs attention" snapshot.
    const blocked: DigestIssueRef[] = await (async () => {
      if (issueIds.length === 0) return [];
      const { issueDependencies } = await import("@agentic-kanban/shared/schema");
      const deps = await database
        .select({
          issueId: issueDependencies.issueId,
          type: issueDependencies.type,
          dependsOnId: issueDependencies.dependsOnId,
        })
        .from(issueDependencies)
        .where(inArray(issueDependencies.issueId, issueIds));

      const result: DigestIssueRef[] = [];
      for (const dep of deps) {
        if (dep.type !== "blocked_by" && dep.type !== "depends_on") continue;
        const blocker = issueMeta.get(dep.dependsOnId);
        const blockerName = blocker ? statusName.get(blocker.statusId) ?? "" : "";
        // Still blocked only if the blocker isn't done/cancelled.
        if (blocker && DONE_STATUS_NAMES.has(blockerName)) continue;
        const meta = issueMeta.get(dep.issueId);
        if (!meta) continue;
        const name = statusName.get(meta.statusId) ?? "Unknown";
        if (DONE_STATUS_NAMES.has(name)) continue;
        if (result.some((r) => r.issueId === meta.id)) continue;
        result.push({
          issueId: meta.id,
          issueNumber: meta.issueNumber,
          title: meta.title,
          statusName: name,
          priority: meta.priority,
          issueType: meta.issueType,
          at: meta.statusChangedAt ?? meta.createdAt,
        });
      }
      return result;
    })();

    const sessionSuccessCount = sessionEntries.filter((s) => s.success).length;
    const totalCostUsd = sessionEntries.reduce((sum, s) => sum + s.costUsd, 0);

    const response: DigestData = {
      range,
      since: sinceIso,
      now: now.toISOString(),
      created,
      completed,
      moved,
      merged,
      sessions: sessionEntries,
      blocked,
      headline: {
        createdCount: created.length,
        completedCount: completed.length,
        mergedCount: merged.length,
        sessionCount: sessionEntries.length,
        sessionSuccessCount,
        totalCostUsd,
        blockedCount: blocked.length,
        activeAgents,
      },
    };

    return c.json(response);
  });

  return router;
}
