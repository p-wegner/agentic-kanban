/**
 * The Delivery chip's live merge state: what is merging right now, what just finished, and
 * what is waiting. The chip used to read only static config ("Iterate · train 1"), so a
 * gating train, its members and how long it had run were visible nowhere at a glance.
 *
 * Cheap on purpose, since `GET /api/projects/:id/delivery` is polled: one bounded read of the
 * project's newest train rows, one join resolving their member workspace ids to tickets, and
 * the ready-for-merge rows the caller already read for `queuePressure` (passed in, not re-read).
 */
import type { MergeActivitySummary, MergeActivityTicket, MergeActivityTrain } from "@agentic-kanban/shared/types";
import type { MergeTrainState } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import {
  getIssueRefsByWorkspaceIds,
  listRecentMergeTrainsForProject,
  type MergeTrainRow,
} from "../repositories/merge-train.repository.js";
import type { QueuePressureMemberRow } from "./queue-pressure.service.js";

/** How long a finished train stays in the read model. The chip itself shows it for less. */
export const MERGE_ACTIVITY_RECENT_WINDOW_MS = 3 * 60 * 60 * 1000;
/** Newest rows read per request; a live train and its predecessor are always among them. */
const RECENT_TRAIN_ROWS = 20;
const LIVE_STATES: ReadonlySet<MergeTrainState> = new Set(["assembling", "gating", "landing"]);

export async function getMergeActivity(
  projectId: string,
  waitingRows: readonly QueuePressureMemberRow[],
  database: Database = db,
  nowMs: number = Date.now(),
): Promise<MergeActivitySummary> {
  const rows = await listRecentMergeTrainsForProject(projectId, RECENT_TRAIN_ROWS, database).catch(() => []);
  const current = rows.find((row) => LIVE_STATES.has(row.state)) ?? null;
  const lastFinished = rows
    .filter((row) => !LIVE_STATES.has(row.state) && row.finishedAt && withinWindow(row.finishedAt, nowMs))
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0] ?? null;

  const memberIds = [...new Set([current, lastFinished].flatMap((row) => (row ? parseMembers(row) : [])))];
  const refs = await getIssueRefsByWorkspaceIds(memberIds, database).catch(() => new Map<string, { issueNumber: number | null; title: string | null }>());
  const ticket = (workspaceId: string): MergeActivityTicket => ({
    workspaceId,
    issueNumber: refs.get(workspaceId)?.issueNumber ?? null,
    title: refs.get(workspaceId)?.title ?? null,
  });

  const aboard = new Set(current ? parseMembers(current) : []);
  const waiting = waitingRows
    .filter((row) => !aboard.has(row.workspaceId))
    .map((row) => ({ workspaceId: row.workspaceId, issueNumber: row.issueNumber, title: row.title, readySince: row.readySince }))
    .sort((a, b) => a.readySince.localeCompare(b.readySince));

  return {
    current: current ? toTrain(current, ticket) : null,
    lastFinished: lastFinished ? toTrain(lastFinished, ticket) : null,
    waiting,
    recentWindowMs: MERGE_ACTIVITY_RECENT_WINDOW_MS,
  };
}

function withinWindow(iso: string, nowMs: number): boolean {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && nowMs - ms <= MERGE_ACTIVITY_RECENT_WINDOW_MS;
}

function parseMembers(row: MergeTrainRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.memberWorkspaceIds);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstLine(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 200) : null;
}

/** The failure line a red/abandoned train carries: the gate failure, else the last red attempt, else the reconciler's reason. */
function failureSummary(row: MergeTrainRow, evidence: Record<string, unknown>, attempts: Array<Record<string, unknown>>): string | null {
  if (row.state !== "red" && row.state !== "abandoned") return null;
  const lastFailure = [...attempts].reverse().find((a) => a.verdict !== "landed" && typeof a.failureHead === "string");
  return firstLine(evidence.gateFailure) ?? firstLine(lastFailure?.failureHead) ?? firstLine(row.reconciledReason);
}

function toTrain(row: MergeTrainRow, ticket: (workspaceId: string) => MergeActivityTicket): MergeActivityTrain {
  const evidence = parseObject(row.gateEvidence);
  const attempts = Array.isArray(evidence.attempts)
    ? (evidence.attempts as unknown[]).filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    : [];
  const landed = Array.isArray(evidence.landed) ? evidence.landed.length : null;
  return {
    label: row.label,
    state: row.state,
    bisecting: row.state === "gating" && attempts.some((a) => a.verdict === "red"),
    members: parseMembers(row).map(ticket),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    landedCount: LIVE_STATES.has(row.state) ? null : (typeof evidence.landedCount === "number" ? evidence.landedCount : landed),
    failureSummary: failureSummary(row, evidence, attempts),
  };
}
