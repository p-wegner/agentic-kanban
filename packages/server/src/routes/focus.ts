import { eq, inArray } from "drizzle-orm";
import {
  issueDependencies,
  issues,
  projectStatuses,
  workflowNodes,
} from "@agentic-kanban/shared/schema";
import { isTerminalStatusView } from "@agentic-kanban/shared";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";

/**
 * Focus — "What should I work on next?".
 *
 * Pure server-side aggregation (no LLM, like the Digest/Insights routes) that
 * ranks open issues by *actionability*. Two signals drive the score:
 *
 *   1. Readiness — an issue is "ready" only when none of its blockers
 *      (depends_on / blocked_by) are still open. Blocked issues are listed
 *      separately so you can see what's gating them.
 *   2. Unblock leverage — how many *other* open issues this one transitively
 *      unblocks. A small ticket that frees up ten others is high-leverage.
 *
 * Those combine with priority and (inverse) estimate into a single 0-100
 * focusScore, surfacing the highest-impact work you can actually start now.
 *
 * Reads only existing tables (issues, project_statuses, issue_dependencies) —
 * no new table, no migration. Modelled on `digest.ts`.
 */

/** Statuses considered "open" / not-yet-done — candidates for focus ranking. */
/** A blocker in one of these statuses no longer gates its dependents. */
/** Statuses that mean work is already underway — excluded from "ready to start". */
const IN_FLIGHT_STATUS_NAMES = new Set(["In Progress", "In Review", "AI Reviewed"]);

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 30,
  urgent: 30,
  high: 22,
  medium: 12,
  low: 5,
};

/** Inverse estimate weight — smaller tickets are cheaper wins, so they score higher. */
const ESTIMATE_WEIGHT: Record<string, number> = {
  xs: 12,
  s: 10,
  m: 6,
  l: 3,
  xl: 1,
};

const DEP_TYPES_THAT_BLOCK = new Set(["depends_on", "blocked_by"]);

interface FocusIssue {
  issueId: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  priority: string;
  issueType: string;
  estimate: string | null;
  /** IDs of still-open issues directly blocking this one. */
  blockedBy: Array<{ issueId: string; issueNumber: number | null; title: string }>;
  /** Count of still-open issues this one transitively unblocks. */
  unblocks: number;
  focusScore: number;
  /** Short human-readable reasons explaining the score (for the UI). */
  reasons: string[];
}

interface FocusData {
  now: string;
  /** Ready-to-start issues, highest focusScore first. */
  ready: FocusIssue[];
  /** Open issues with at least one unresolved blocker, highest leverage first. */
  blocked: FocusIssue[];
  headline: {
    openCount: number;
    readyCount: number;
    blockedCount: number;
    inFlightCount: number;
    topScore: number;
  };
}

export function createFocusRoute(database: Database = db) {
  const router = createRouter();

  // `now` is accepted for parity with the digest route and deterministic tests;
  // the focus ranking itself is point-in-time, not windowed.
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);

    const nowParam = c.req.query("now");
    const now = nowParam ? new Date(nowParam) : new Date();

    const statusRows = await database
      .select({ id: projectStatuses.id, name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId));
    const statusName = new Map(statusRows.map((s) => [s.id, s.name]));

    const issueRows = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        statusId: issues.statusId,
        statusName: projectStatuses.name,
        currentNodeId: issues.currentNodeId,
        currentNodeType: workflowNodes.nodeType,
        priority: issues.priority,
        issueType: issues.issueType,
        estimate: issues.estimate,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
      .where(eq(issues.projectId, projectId));

    const issueMeta = new Map(issueRows.map((r) => [r.id, r]));
    const isDone = (id: string) => {
      const meta = issueMeta.get(id);
      return meta ? isTerminalStatusView(meta) : false;
    };

    // Build the blocking graph: blockerId -> set of issues it blocks.
    // A dependency row {issueId, dependsOnId, type=depends_on|blocked_by} means
    // `issueId` is blocked by `dependsOnId`.
    const issueIds = issueRows.map((r) => r.id);
    const blockersOf = new Map<string, Set<string>>(); // issue -> its blockers
    const blocks = new Map<string, Set<string>>(); // blocker -> issues it blocks

    if (issueIds.length > 0) {
      const deps = await database
        .select({
          issueId: issueDependencies.issueId,
          dependsOnId: issueDependencies.dependsOnId,
          type: issueDependencies.type,
        })
        .from(issueDependencies)
        .where(inArray(issueDependencies.issueId, issueIds));

      for (const dep of deps) {
        if (!DEP_TYPES_THAT_BLOCK.has(dep.type)) continue;
        if (!issueMeta.has(dep.issueId) || !issueMeta.has(dep.dependsOnId)) continue;
        if (!blockersOf.has(dep.issueId)) blockersOf.set(dep.issueId, new Set());
        blockersOf.get(dep.issueId)!.add(dep.dependsOnId);
        if (!blocks.has(dep.dependsOnId)) blocks.set(dep.dependsOnId, new Set());
        blocks.get(dep.dependsOnId)!.add(dep.issueId);
      }
    }

    // Transitive unblock count: how many distinct still-open issues become
    // reachable downstream from `start` via the blocks-graph. Cycle-safe via a
    // visited set.
    function transitiveUnblocks(start: string): number {
      const seen = new Set<string>();
      const stack = [...(blocks.get(start) ?? [])];
      while (stack.length > 0) {
        const next = stack.pop()!;
        if (seen.has(next) || next === start) continue;
        seen.add(next);
        for (const further of blocks.get(next) ?? []) {
          if (!seen.has(further)) stack.push(further);
        }
      }
      // Only count downstream issues that are still open — unblocking a done
      // issue is worthless.
      let count = 0;
      for (const id of seen) if (!isDone(id)) count += 1;
      return count;
    }

    const ready: FocusIssue[] = [];
    const blocked: FocusIssue[] = [];
    let inFlightCount = 0;
    let openCount = 0;

    for (const row of issueRows) {
      const name = row.statusName ?? statusName.get(row.statusId) ?? "Unknown";
      if (isTerminalStatusView(row)) continue;
      openCount += 1;
      if (IN_FLIGHT_STATUS_NAMES.has(name)) {
        inFlightCount += 1;
        continue; // already being worked — not a "what's next" candidate
      }

      const openBlockers = [...(blockersOf.get(row.id) ?? [])].filter((b) => !isDone(b));
      const unblocks = transitiveUnblocks(row.id);

      const priorityScore = PRIORITY_WEIGHT[row.priority] ?? 12;
      const estimateScore = row.estimate ? ESTIMATE_WEIGHT[row.estimate.toLowerCase()] ?? 4 : 4;
      // Leverage saturates so one mega-blocker doesn't swamp everything.
      const leverageScore = Math.min(unblocks, 6) * 8;
      const rawScore = priorityScore + estimateScore + leverageScore;
      // Ready issues use the full score; blocked issues are heavily penalised
      // (they can't be started) but still ranked among themselves.
      const focusScore = Math.min(100, Math.round(rawScore));

      const reasons: string[] = [];
      if (priorityScore >= 22) reasons.push(`${row.priority} priority`);
      if (unblocks > 0) reasons.push(`unblocks ${unblocks} issue${unblocks === 1 ? "" : "s"}`);
      if (row.estimate && (row.estimate.toLowerCase() === "xs" || row.estimate.toLowerCase() === "s")) {
        reasons.push("quick win");
      }

      const entry: FocusIssue = {
        issueId: row.id,
        issueNumber: row.issueNumber,
        title: row.title,
        statusName: name,
        priority: row.priority,
        issueType: row.issueType,
        estimate: row.estimate,
        blockedBy: openBlockers.map((b) => {
          const m = issueMeta.get(b)!;
          return { issueId: m.id, issueNumber: m.issueNumber, title: m.title };
        }),
        unblocks,
        focusScore,
        reasons,
      };

      if (openBlockers.length === 0) ready.push(entry);
      else blocked.push(entry);
    }

    // Highest focus first; tie-break by leverage then issue number for stable order.
    const byScore = (a: FocusIssue, b: FocusIssue) =>
      b.focusScore - a.focusScore ||
      b.unblocks - a.unblocks ||
      (a.issueNumber ?? 0) - (b.issueNumber ?? 0);
    ready.sort(byScore);
    // Blocked issues ranked by leverage — the most-impactful gated work first.
    blocked.sort((a, b) => b.unblocks - a.unblocks || b.focusScore - a.focusScore);

    const response: FocusData = {
      now: now.toISOString(),
      ready,
      blocked,
      headline: {
        openCount,
        readyCount: ready.length,
        blockedCount: blocked.length,
        inFlightCount,
        topScore: ready[0]?.focusScore ?? 0,
      },
    };

    return c.json(response);
  });

  return router;
}
