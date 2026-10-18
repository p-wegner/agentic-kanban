import {
  cleanupTicketBody,
  cleanupTicketTitle,
  codeHealthLedgerPref,
  codeHealthPosturePref,
  evaluateCleanupTrigger,
  formatCodeHealthLine,
  parseLedgerState,
  planCleanupAction,
  reconcileLedger,
  resolveCodeHealthPosture,
  type CleanupAction,
  type CleanupTicketState,
  type LedgerEntry,
  type ResolvedCodeHealthPosture,
  type SoftBreach,
} from "../lib/code-health.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { CodeHealthStatus } from "@agentic-kanban/shared/types";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAllPreferences, setPreference } from "../repositories/preferences.repository.js";
import { updateIssueById } from "../repositories/issue-service.repository.js";
import { listIssuesByExternalKeyPrefix } from "../repositories/issue/heal-ticket.repository.js";
import { createIssueService, type CreateIssueInput, type CreateIssueResult } from "./issue.service.js";
import { resolveRiskPosture } from "./risk-posture.service.js";

/**
 * The code-health ledger and its cleanup ticket (#1613, decision 021).
 *
 * The gate script (`scripts/check-god-modules.mjs --report`) measures; this service RECORDS. A
 * soft breach is written to the ledger (`code_health_ledger_<id>`) and nothing else — it never
 * blocks. When the open soft breaches pass the level's trigger, ONE consolidated cleanup ticket
 * is filed; further breaches APPEND to it (re-render its body) until it starts, after which they
 * accumulate for the next one. Identity of the ticket is its `external_key`
 * (`code-health-cleanup:<projectId>`), the same carrier the heal ticket uses.
 */

const CLEANUP_KEY_PREFIX = "code-health-cleanup:";
export const cleanupTicketExternalKey = (projectId: string) => `${CLEANUP_KEY_PREFIX}${projectId}`;

/** Statuses a cleanup ticket may sit in and still absorb new breaches ("not started"). */
const NOT_STARTED_STATUSES = new Set(["backlog", "todo", "to do", "open"]);
const TERMINAL_STATUSES = new Set(["done", "closed", "cancelled", "canceled", "merged"]);

export interface RecordCodeHealthInput {
  projectId: string;
  /** The soft breaches of the CURRENT scan (the full open set, not a delta). */
  breaches: SoftBreach[];
  /** Commit sha / ticket that produced this scan; stamped on newly crossed entries. */
  ref?: string | null;
  now?: string;
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
}

export interface RecordCodeHealthResult {
  action: CleanupAction;
  ledger: LedgerEntry[];
  line: string;
  reason: string;
  issueId?: string;
  issueNumber?: number;
}

export async function resolveProjectCodeHealth(
  projectId: string,
  prefMap: Map<string, string>,
): Promise<ResolvedCodeHealthPosture> {
  const risk = resolveRiskPosture(prefMap, projectId);
  return resolveCodeHealthPosture(risk.level, prefMap.get(codeHealthPosturePref.key(projectId)));
}

async function findOpenCleanupTicket(projectId: string, database: Database): Promise<CleanupTicketState | null> {
  const rows = await listIssuesByExternalKeyPrefix(projectId, cleanupTicketExternalKey(projectId), database);
  const open = rows.filter((r) => r.externalKey === cleanupTicketExternalKey(projectId)
    && !TERMINAL_STATUSES.has((r.statusName ?? "").toLowerCase()));
  const row = open[0];
  if (!row) return null;
  return {
    issueId: row.id,
    issueNumber: row.issueNumber ?? null,
    started: !NOT_STARTED_STATUSES.has((row.statusName ?? "").toLowerCase()),
  };
}

/** Never throws into a caller's gate path: a ledger that cannot be written is logged, not fatal. */
export async function recordCodeHealth(
  input: RecordCodeHealthInput,
  database: Database = db,
): Promise<RecordCodeHealthResult> {
  const now = input.now ?? new Date().toISOString();
  const prefMap = toPrefMap(await getAllPreferences(database));
  const posture = await resolveProjectCodeHealth(input.projectId, prefMap);
  const previous = parseLedgerState(prefMap.get(codeHealthLedgerPref.key(input.projectId))).entries;
  const ledger = reconcileLedger(previous, input.breaches, { now, ref: input.ref });
  await setPreference(codeHealthLedgerPref.key(input.projectId), JSON.stringify({ entries: ledger }), database);

  const line = formatCodeHealthLine(ledger, posture.level);
  console.log(`[code-health] project ${input.projectId}: ${line}`);

  const decision = evaluateCleanupTrigger(ledger, posture.caps, Date.parse(now));
  const ticket = await findOpenCleanupTicket(input.projectId, database);
  const action = planCleanupAction(decision, ticket);
  const base = { action, ledger, line, reason: decision.reason };

  if (action === "file") {
    const createIssue = input.createIssue ?? createIssueService({ database }).createIssue;
    // An ordinary ticket (operator decision 2026-10-19): default placement, no queue jump, no
    // special scheduling; the board pulls it in like any other.
    const issue = await createIssue({
      projectId: input.projectId,
      title: cleanupTicketTitle(),
      description: cleanupTicketBody(ledger, posture.level),
      issueType: "task",
      priority: "medium",
      externalKey: cleanupTicketExternalKey(input.projectId),
    });
    return { ...base, issueId: issue.id, issueNumber: issue.issueNumber ?? undefined };
  }
  if (action === "append" && ticket) {
    await updateIssueById(ticket.issueId, { description: cleanupTicketBody(ledger, posture.level), updatedAt: now }, database);
    return { ...base, issueId: ticket.issueId, issueNumber: ticket.issueNumber ?? undefined };
  }
  return base;
}

/** The delivery-view summary: resolved posture next to the open-ledger count. Read-only. */
export function describeCodeHealth(
  posture: ResolvedCodeHealthPosture,
  prefMap: Map<string, string>,
  projectId: string,
): CodeHealthStatus {
  const entries = parseLedgerState(prefMap.get(codeHealthLedgerPref.key(projectId))).entries;
  return {
    level: posture.level,
    source: posture.source,
    caps: { lines: posture.caps.lines, branches: posture.caps.branches, declarations: posture.caps.declarations },
    cleanupTrigger: posture.caps.cleanupTrigger,
    openSoftBreaches: entries.length,
    files: new Set(entries.map((e) => e.file)).size,
    line: formatCodeHealthLine(entries, posture.level),
  };
}
