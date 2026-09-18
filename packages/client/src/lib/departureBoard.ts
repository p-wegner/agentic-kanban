/**
 * Pure view-model for the "departure board" (#1187) — the platform view that replaces the
 * one-line merge-train summary bar. Consumes `GET /api/merge-queue/window?projectId=` (added by
 * #1186, "Persist and expose the merge-train batching window") plus the existing
 * `GET /api/merge-queue/trains?projectId=` history this panel already reads via
 * `mergeTrainSummary.ts`.
 *
 * The window DTO is `MergeTrainWindowDto` (`@agentic-kanban/shared`), #1186's actual wire
 * contract: `pending[].issueTitle` (nullable), `config.maxSize`/`config.maxWaitMs`,
 * `lastVerdict.reason`, and `liveTrainId` — a bare id, not a rich train object. This module
 * resolves that id against the `MergeTrainRowDto[]` history the panel already fetches, so the
 * "live train" shown here always agrees with the same row the history strip and cancel button
 * act on.
 */

import type {
  MergeTrainRowDto,
  MergeTrainState,
  MergeTrainWindowDto,
  MergeTrainWindowHoldReason,
} from "@agentic-kanban/shared";

export type { MergeTrainRowDto, MergeTrainState };

/** One held ticket, waiting for its train to depart. */
export interface DepartureBoardPendingMember {
  workspaceId: string;
  issueNumber: number;
  title: string;
  /** ISO timestamp of when this member became ready (joined the window). */
  readySince: string;
}

export type DepartureBoardHoldReason = MergeTrainWindowHoldReason;

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

/** The actual `GET /api/merge-queue/window?projectId=` response shape (#1186, landed on master). */
export type DepartureBoardWindowDto = MergeTrainWindowDto;

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

function parseGateRunsFromRow(row: MergeTrainRowDto): number {
  if (!row.gateEvidence) return 0;
  try {
    const parsed = JSON.parse(row.gateEvidence) as { gateRuns?: number };
    return typeof parsed.gateRuns === "number" ? parsed.gateRuns : 0;
  } catch {
    return 0;
  }
}

/** Resolves `window.liveTrainId` against the fetched train history into a display-ready shape. */
function resolveLiveTrain(liveTrainId: string | null, trains: MergeTrainRowDto[]): DepartureBoardLiveTrain | null {
  if (!liveTrainId) return null;
  const row = trains.find((t) => t.id === liveTrainId);
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    state: row.state,
    memberCount: parseMemberIds(row).length,
    gateRuns: parseGateRunsFromRow(row),
    startedAt: row.startedAt,
  };
}

/**
 * Derives the departure-board row for one project window. `nowMs` is injectable (per the root
 * CLAUDE.md time-injection convention) so the countdown is testable without real timers.
 * `trains` is the same history list the panel already fetches, used only to resolve
 * `window.liveTrainId` into a displayable train.
 */
export function buildDepartureBoardRow(
  window: DepartureBoardWindowDto,
  nowMs: number = Date.now(),
  trains: MergeTrainRowDto[] = [],
): DepartureBoardRow {
  const boarding: BoardingCar[] = window.pending.map((member) => ({
    workspaceId: member.workspaceId,
    issueNumber: member.issueNumber ?? 0,
    title: member.issueTitle ?? "(unknown ticket)",
    readySince: member.readySince ?? window.firstSeenAt,
  }));

  const { maxSize, maxWaitMs } = window.config;
  const atMaxSize = maxSize > 0 && boarding.length >= maxSize;

  // `firstSeenAt` only marks a real max-wait clock when something is actually boarding — a
  // control-only hold record (or the empty/idle window) carries a `firstSeenAt` that means
  // nothing, and computing a countdown from it would show a bogus trigger.
  let msUntilWait: number | null = null;
  if (boarding.length > 0 && maxWaitMs > 0) {
    const deadline = new Date(window.firstSeenAt).getTime() + maxWaitMs;
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

  const holdReason: DepartureBoardHoldReason | null = window.lastVerdict.release ? null : window.lastVerdict.reason;
  const liveTrain = resolveLiveTrain(window.liveTrainId, trains);

  return {
    projectId: window.projectId,
    boarding,
    holdReason: boarding.length > 0 ? holdReason : null,
    liveTrain,
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
  if (reason === "live_train" && liveTrain) {
    return `a train is live (${liveTrain.label}, ${liveTrain.state}, since ${liveTrain.startedAt})`;
  }
  if (reason === "gate_busy") return "gate_busy grace";
  if (reason === "accumulating") return "accumulating";
  if (reason === "held") return "held by operator";
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
