/**
 * Pure view-model for the "departure board" (#1187) — the platform view that replaces the
 * one-line merge-train summary bar. Consumes `GET /api/merge-queue/window?projectId=` (added by
 * #1186, "Persist and expose the merge-train batching window") plus the existing
 * `GET /api/merge-queue/trains?projectId=` history this panel already reads via
 * `mergeTrainSummary.ts`.
 *
 * The window DTO shape mirrors #1186's own ticket description exactly (pending members with
 * issue number/title/ready-since, `maxSize`/`maxWaitMs` config, last verdict + reason, projected
 * departure time) since that ticket is the sole source of truth for the wire contract and had
 * not landed on master at the time this was written — see CONTINUE.md if the two ever disagree.
 */

import type { MergeTrainRowDto, MergeTrainState } from "@agentic-kanban/shared";

export type { MergeTrainRowDto, MergeTrainState };

/** One held ticket, waiting for its train to depart. */
export interface DepartureBoardPendingMember {
  workspaceId: string;
  issueNumber: number;
  title: string;
  /** ISO timestamp of when this member became ready (joined the window). */
  readySince: string;
}

export type DepartureBoardHoldReason = "accumulating" | "gate_busy" | "train_live";

/** A live (non-terminal) train, if one is currently assembling/gating/landing. */
export interface DepartureBoardLiveTrain {
  id: string;
  label: string;
  state: MergeTrainState;
  memberCount: number;
  gateRuns: number;
  /** ISO timestamp the train started assembling. */
  startedAt: string;
}

/** `GET /api/merge-queue/window?projectId=` response, per #1186. */
export interface DepartureBoardWindowDto {
  projectId: string;
  pending: DepartureBoardPendingMember[];
  maxSize: number;
  maxWaitMs: number;
  /** ISO timestamp of the oldest pending member, or null when nothing is waiting. */
  firstSeenAt: string | null;
  holdReason: DepartureBoardHoldReason | null;
  liveTrain: DepartureBoardLiveTrain | null;
  /** ISO timestamp of the projected departure if nothing changes, or null when not computable. */
  projectedDepartureAt: string | null;
}

export type DepartureTrigger = "max_size" | "max_wait" | null;

export interface BoardingCar {
  workspaceId: string;
  issueNumber: number;
  title: string;
  readySince: string;
}

export interface DepartureBoardRow {
  projectId: string;
  boarding: BoardingCar[];
  holdReason: DepartureBoardHoldReason | null;
  liveTrain: DepartureBoardLiveTrain | null;
  /** Which trigger fires the departure countdown — whichever of size/max_wait is sooner. */
  trigger: DepartureTrigger;
  /** Milliseconds until departure under the current trigger, or null when there is none. */
  msUntilDeparture: number | null;
  projectedDepartureAt: string | null;
  atMaxSize: boolean;
}

/**
 * Derives the departure-board row for one project window. `nowMs` is injectable (per the root
 * CLAUDE.md time-injection convention) so the countdown is testable without real timers.
 */
export function buildDepartureBoardRow(window: DepartureBoardWindowDto, nowMs: number = Date.now()): DepartureBoardRow {
  const boarding: BoardingCar[] = window.pending.map((member) => ({
    workspaceId: member.workspaceId,
    issueNumber: member.issueNumber,
    title: member.title,
    readySince: member.readySince,
  }));

  const atMaxSize = window.maxSize > 0 && boarding.length >= window.maxSize;

  let msUntilWait: number | null = null;
  if (window.firstSeenAt && window.maxWaitMs > 0) {
    const deadline = new Date(window.firstSeenAt).getTime() + window.maxWaitMs;
    msUntilWait = Math.max(0, deadline - nowMs);
  }

  let trigger: DepartureTrigger = null;
  let msUntilDeparture: number | null = null;

  if (atMaxSize) {
    trigger = "max_size";
    msUntilDeparture = 0;
  } else if (msUntilWait !== null) {
    trigger = "max_wait";
    msUntilDeparture = msUntilWait;
  }

  return {
    projectId: window.projectId,
    boarding,
    holdReason: boarding.length > 0 ? window.holdReason : null,
    liveTrain: window.liveTrain,
    trigger,
    msUntilDeparture,
    projectedDepartureAt: window.projectedDepartureAt,
    atMaxSize,
  };
}

/** Formats a millisecond countdown as e.g. "2m 14s" / "45s" / "departing". */
export function formatCountdown(ms: number | null): string {
  if (ms === null) return "—";
  if (ms <= 0) return "departing";
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

export function holdReasonLabel(reason: DepartureBoardHoldReason | null, liveTrain: DepartureBoardLiveTrain | null): string {
  if (reason === "train_live" && liveTrain) {
    return `a train is live (${liveTrain.label}, ${liveTrain.state}, since ${liveTrain.startedAt})`;
  }
  if (reason === "gate_busy") return "gate_busy grace";
  if (reason === "accumulating") return "accumulating";
  return "—";
}

const TERMINAL_TRAIN_STATES: readonly MergeTrainState[] = ["landed", "red", "abandoned"];

export interface HistoryTile {
  id: string;
  state: MergeTrainState;
  memberCount: number;
  gateRuns: number | null;
  durationMs: number | null;
}

function parseMemberIds(row: MergeTrainRowDto): string[] {
  try {
    const parsed: unknown = JSON.parse(row.memberWorkspaceIds);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parseGateRuns(row: MergeTrainRowDto): number | null {
  if (!row.gateEvidence) return null;
  try {
    const parsed = JSON.parse(row.gateEvidence) as { gateRuns?: number };
    return typeof parsed.gateRuns === "number" ? parsed.gateRuns : null;
  } catch {
    return null;
  }
}

/** Last 10 finished trains as history-strip tiles, newest first. */
export function buildHistoryStrip(rows: MergeTrainRowDto[]): HistoryTile[] {
  return [...rows]
    .filter((row) => TERMINAL_TRAIN_STATES.includes(row.state))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      state: row.state,
      memberCount: parseMemberIds(row).length,
      gateRuns: parseGateRuns(row),
      durationMs: row.finishedAt ? new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime() : null,
    }));
}
