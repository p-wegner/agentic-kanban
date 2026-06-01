import { randomUUID } from "node:crypto";
import { issues, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import { setPreference } from "../repositories/preferences.repository.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";

/** A synthetic host issue created to carry a generation workspace. */
interface HostIssue {
  projectId: string;
  statusId: string;
  issueNumber: number;
  title: string;
  description: string;
}

/** Default host-issue creator: inserts the row and returns its id (null on failure). */
async function defaultCreateHostIssue(issue: HostIssue, nowIso: string): Promise<string | null> {
  const rows = await db.insert(issues).values({
    id: randomUUID(),
    projectId: issue.projectId,
    issueNumber: issue.issueNumber,
    title: issue.title,
    description: issue.description,
    priority: "low",
    statusId: issue.statusId,
    currentNodeId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  }).returning({ id: issues.id }).catch(() => [] as { id: string }[]);
  return rows[0]?.id ?? null;
}

/** Default host-issue remover: used to clean up an orphan when the workspace launch fails. */
async function defaultDeleteHostIssue(issueId: string): Promise<void> {
  await db.delete(issues).where(eq(issues.id, issueId)).catch(() => {});
}

/**
 * Default skill invoked when the backlog runs dry and the strategy is
 * "generate_tickets". A disk-only skill (`.claude/skills/<name>/SKILL.md`),
 * launched via `skillName`. `architecture-improvement` and `ui-explorer` both
 * create kanban tickets via the `create_issue` MCP tool.
 */
const DEFAULT_BACKLOG_SKILL = "architecture-improvement";

/** Minimum gap between two backlog-refill runs (minutes) — guards against spam. */
const DEFAULT_COOLDOWN_MIN = 120;

/**
 * Scoped instructions handed to the generation agent. Encodes the ticket
 * constraints from #135: high-value local-only features, no third-party
 * integrations, no payment, no cloud dependencies.
 */
function buildGenerationPrompt(skillName: string): string {
  return [
    `The board backlog is empty. Run the \`${skillName}\` skill to discover and create`,
    "new high-value tickets for this project using the `create_issue` MCP tool.",
    "",
    "Constraints for every ticket you create:",
    "- Focus on high-value features or improvements that benefit the application directly.",
    "- NO third-party system integrations.",
    "- NO payment / billing topics.",
    "- NO cloud dependencies — the app must remain independent and local-first.",
    "- Each ticket must be self-contained and implementable without external services.",
    "",
    "Create a focused batch of tickets (roughly 3–6), each with a clear title and a",
    "description that states the value and the acceptance criteria. Then stop.",
  ].join("\n");
}

export interface BacklogEmptyDeps {
  serverPort: number;
  boardEvents: ReturnType<typeof createBoardEvents>;
  logMonitorAction: (action: MonitorActionName, workspaceId: string, issueId: string) => void;
  /** Injectable persistence for the cooldown timestamp (defaults to the real preferences repo). */
  setCooldownStamp?: (iso: string) => Promise<void>;
  /** Injectable host-issue creator (defaults to a real DB insert). Returns the new issue id or null. */
  createHostIssue?: (issue: HostIssue, nowIso: string) => Promise<string | null>;
  /** Injectable host-issue remover (defaults to a real DB delete). */
  deleteHostIssue?: (issueId: string) => Promise<void>;
}

/**
 * When the backlog is empty (0 unstarted Todo issues without an open workspace),
 * optionally trigger an agent skill that generates new tickets.
 *
 * Gated on `auto_monitor` being on and `backlog_empty_strategy === "generate_tickets"`.
 * Rate-limited via the `backlog_empty_last_run` preference and `backlog_empty_cooldown_min`.
 * Respects the same `nudge_wip_limit` as auto-start so it never piles work on a busy board.
 *
 * @param now Injectable wall-clock ISO string for deterministic tests.
 */
export async function runBacklogEmptyStrategy(
  prefMap: Map<string, string>,
  {
    serverPort,
    boardEvents,
    logMonitorAction,
    setCooldownStamp = (iso) => setPreference("backlog_empty_last_run", iso),
    createHostIssue = defaultCreateHostIssue,
    deleteHostIssue = defaultDeleteHostIssue,
  }: BacklogEmptyDeps,
  now: string = new Date().toISOString(),
): Promise<void> {
  const strategy = prefMap.get("backlog_empty_strategy") || "skip";
  if (strategy !== "generate_tickets") return;

  // Cooldown: don't refill more often than the configured interval.
  const cooldownMin = parseInt(prefMap.get("backlog_empty_cooldown_min") || String(DEFAULT_COOLDOWN_MIN), 10);
  const lastRun = prefMap.get("backlog_empty_last_run");
  if (lastRun) {
    const elapsedMs = new Date(now).getTime() - new Date(lastRun).getTime();
    if (elapsedMs < cooldownMin * 60 * 1000) {
      return;
    }
  }

  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const wipLimit = parseInt(prefMap.get("nudge_wip_limit") || "5", 10);
  const skillName = prefMap.get("backlog_empty_skill") || DEFAULT_BACKLOG_SKILL;

  const inProgressStatuses = await db.select({ id: projectStatuses.id, projectId: projectStatuses.projectId }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = 'In Progress'`);

  let triggeredAny = false;
  for (const inProgressSt of inProgressStatuses) {
    const projectId = inProgressSt.projectId;

    // Resolve the project's Todo backlog status.
    const todoStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${projectId}`).limit(1);
    if (todoStatus.length === 0) continue;

    // Count unstarted Todo issues that have no open (non-closed) workspace.
    const backlogRows = await db.select({ count: sql<number>`count(distinct ${issues.id})` }).from(issues)
      .where(sql`${issues.statusId} = ${todoStatus[0].id} AND NOT EXISTS (
        SELECT 1 FROM ${workspaces} WHERE ${workspaces.issueId} = ${issues.id} AND ${workspaces.status} != 'closed'
      )`);
    const backlogCount = Number(backlogRows[0]?.count ?? 0);
    if (backlogCount > 0) continue; // backlog not empty for this project

    // Respect the WIP limit — don't generate work on an already-busy board.
    const wipRows = await db.select({ count: sql<number>`count(distinct ${issues.id})` }).from(issues)
      .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
      .where(sql`${issues.statusId} = ${inProgressSt.id} AND ${workspaces.status} != 'closed'`);
    if (Number(wipRows[0]?.count ?? 0) >= wipLimit) continue;

    // Create a synthetic host issue to carry the generation workspace. It is placed
    // directly in "In Progress" (not Todo) so it never counts as backlog itself and
    // cannot re-trigger this strategy on the next cycle.
    const nextNumberRows = await db.select({ max: sql<number>`COALESCE(MAX(${issues.issueNumber}), 0)` }).from(issues)
      .where(eq(issues.projectId, projectId));
    const issueNumber = (Number(nextNumberRows[0]?.max ?? 0)) + 1;
    const nowIso = new Date(now).toISOString();
    const hostIssueId = await createHostIssue({
      projectId,
      statusId: inProgressSt.id,
      issueNumber,
      title: `Backlog refill — generate high-value tickets (${skillName})`,
      description: `Auto-generated by the board monitor's backlog-empty strategy. Runs the \`${skillName}\` skill to create new local-only, high-value tickets when the backlog is empty.`,
    }, nowIso);
    if (!hostIssueId) continue;

    // Launch a workspace running the configured skill with the scoped prompt.
    const branch = `chore/backlog-refill-${issueNumber}`;
    const resp = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueId: hostIssueId,
        branch,
        skillName,
        customPrompt: buildGenerationPrompt(skillName),
        skipContextPacker: true,
      }),
    }).catch(() => null);

    if (resp?.ok) {
      const wsData = await resp.json().catch(() => null) as { id?: string } | null;
      logMonitorAction("generate_tickets", wsData?.id ?? "unknown", hostIssueId);
      boardEvents.broadcast(projectId, "board_changed");
      triggeredAny = true;
      console.log(`[monitor] Backlog empty for project ${projectId} — launched "${skillName}" to generate tickets (issue #${issueNumber})`);
    } else {
      // Workspace launch failed: clean up the orphan host issue so the board stays tidy.
      await deleteHostIssue(hostIssueId);
    }
  }

  // Stamp the cooldown only when we actually triggered a refill.
  if (triggeredAny) {
    await setCooldownStamp(new Date(now).toISOString()).catch(() => {});
  }
}
