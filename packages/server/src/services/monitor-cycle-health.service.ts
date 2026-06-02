import { boardHealthEvents } from "@agentic-kanban/shared/schema";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type CycleHealthState = "healthy" | "warning" | "error";

export interface MonitorCycleSummary {
  cycleId: string;
  startedAt: string;
  endedAt: string | null;
  healthState: CycleHealthState;
  mergedCount: number;
  startedCount: number;
  refillCount: number;
  needsAttentionCount: number;
  /** True when a server restart/recovery event was logged in this cycle. */
  apiRestarted: boolean;
  /** True when a smoke check timed out or failed despite board content being present. */
  smokeCheckFailed: boolean;
  /** Issue/workspace numbers referenced in actions or observations for this cycle. */
  issueNumbers: number[];
  /** Human-readable label summarising the cycle health. */
  label: string;
}

interface RawCycleRow {
  cycleId: string;
  minCreatedAt: string;
  maxCreatedAt: string;
  eventTypes: string;
  categories: string;
  summaries: string;
  issueNumbers: string;
}

/**
 * Determine the failure state of a cycle based on its summaries.
 * API restart: a server/error event whose summary mentions "restart", "restarted", or "api restart".
 * Smoke check failure: a smoke_check/error or smoke_check/observation whose summary mentions "timed out",
 * "timeout", "failed", or "unavailable" alongside indicator that the board rendered ("content", "rendered", "board").
 */
export function classifyCycleFailures(
  summaries: string[],
  categories: string[],
  eventTypes: string[],
): { apiRestarted: boolean; smokeCheckFailed: boolean } {
  let apiRestarted = false;
  let smokeCheckFailed = false;

  for (let i = 0; i < summaries.length; i++) {
    const summary = (summaries[i] ?? "").toLowerCase();
    const category = categories[i] ?? "";
    const eventType = eventTypes[i] ?? "";

    if (category === "server" || (eventType === "error" && category === "")) {
      if (/restart|restarted|api restart|server restart/.test(summary)) {
        apiRestarted = true;
      }
    }

    if (category === "smoke_check") {
      const timedOut = /timed out|timeout|failed|unavailable|unreachable/.test(summary);
      const hadContent = /content|rendered|board|loaded|visible/.test(summary);
      if (timedOut && hadContent) {
        smokeCheckFailed = true;
      } else if (eventType === "error") {
        smokeCheckFailed = true;
      }
    }
  }

  return { apiRestarted, smokeCheckFailed };
}

/**
 * Derive an overall health state for a cycle from its event types, categories, and failures.
 */
export function deriveCycleHealthState(
  eventTypes: string[],
  apiRestarted: boolean,
  smokeCheckFailed: boolean,
  needsAttentionCount: number,
): CycleHealthState {
  if (apiRestarted || smokeCheckFailed) return "error";
  if (eventTypes.includes("error")) return "warning";
  if (needsAttentionCount > 0) return "warning";
  return "healthy";
}

/** Count category occurrences in a comma-joined string from GROUP_CONCAT. */
function countCategory(categoriesStr: string, category: string): number {
  if (!categoriesStr) return 0;
  return categoriesStr.split(",").filter((c) => c.trim() === category).length;
}

/** Count event types. */
function countEventType(eventTypesStr: string, type: string): number {
  if (!eventTypesStr) return 0;
  return eventTypesStr.split(",").filter((t) => t.trim() === type).length;
}

/** Parse issue numbers from comma-joined string (may contain nulls as empty strings). */
function parseIssueNumbers(rawStr: string): number[] {
  if (!rawStr) return [];
  const seen = new Set<number>();
  for (const part of rawStr.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Build a human-readable label from cycle stats. */
export function buildCycleLabel(summary: MonitorCycleSummary): string {
  const parts: string[] = [];
  if (summary.apiRestarted) parts.push("API restart");
  if (summary.smokeCheckFailed) parts.push("smoke check failed");
  if (summary.mergedCount > 0) parts.push(`${summary.mergedCount} merged`);
  if (summary.startedCount > 0) parts.push(`${summary.startedCount} started`);
  if (summary.refillCount > 0) parts.push(`${summary.refillCount} refilled`);
  if (summary.needsAttentionCount > 0) parts.push(`${summary.needsAttentionCount} need attention`);
  return parts.length > 0 ? parts.join(", ") : "no actions";
}

/**
 * Return summarised monitor cycles for a project, most-recent first.
 * Groups board_health_events by cycleId and computes per-cycle stats.
 */
export async function listMonitorCycles(
  projectId: string,
  opts: { limit?: number } = {},
  database: Database = db,
): Promise<MonitorCycleSummary[]> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));

  // Use a subquery to get the most-recent `limit` cycleIds first, then aggregate.
  const cycleRows = await database
    .select({
      cycleId: boardHealthEvents.cycleId,
      minCreatedAt: sql<string>`min(${boardHealthEvents.createdAt})`,
      maxCreatedAt: sql<string>`max(${boardHealthEvents.createdAt})`,
      eventTypes: sql<string>`group_concat(${boardHealthEvents.eventType})`,
      categories: sql<string>`group_concat(coalesce(${boardHealthEvents.category}, ''))`,
      summaries: sql<string>`group_concat(${boardHealthEvents.summary}, '||')`,
      issueNumbers: sql<string>`group_concat(coalesce(${boardHealthEvents.issueNumber}, ''))`,
    })
    .from(boardHealthEvents)
    .where(eq(boardHealthEvents.projectId, projectId))
    .groupBy(boardHealthEvents.cycleId)
    .orderBy(desc(sql`min(${boardHealthEvents.createdAt})`))
    .limit(limit) as RawCycleRow[];

  return cycleRows.map((row) => {
    const summaries = (row.summaries ?? "").split("||").map((s) => s.trim()).filter(Boolean);
    const categories = (row.categories ?? "").split(",").map((s) => s.trim());
    const eventTypes = (row.eventTypes ?? "").split(",").map((s) => s.trim());

    const mergedCount = countCategory(row.categories, "merge");
    const startedCount = countCategory(row.categories, "launch");
    const refillCount = countCategory(row.categories, "refill");

    // "needs attention" = observation events or error events that mention attention
    const attentionCount = summaries.filter((s) =>
      /needs attention|attention needed|stuck|no file changes/.test(s.toLowerCase()),
    ).length + countEventType(row.eventTypes, "error");

    const { apiRestarted, smokeCheckFailed } = classifyCycleFailures(summaries, categories, eventTypes);
    const healthState = deriveCycleHealthState(eventTypes, apiRestarted, smokeCheckFailed, attentionCount);
    const issueNumbers = parseIssueNumbers(row.issueNumbers);

    const partial: Omit<MonitorCycleSummary, "label"> = {
      cycleId: row.cycleId,
      startedAt: row.minCreatedAt,
      endedAt: row.maxCreatedAt !== row.minCreatedAt ? row.maxCreatedAt : null,
      healthState,
      mergedCount,
      startedCount,
      refillCount,
      needsAttentionCount: attentionCount,
      apiRestarted,
      smokeCheckFailed,
      issueNumbers,
    };

    return { ...partial, label: buildCycleLabel(partial as MonitorCycleSummary) };
  });
}
