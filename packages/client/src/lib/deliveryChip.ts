/**
 * The header Delivery chip's view model (#1155/#1156) — pure, so the label and tooltip the
 * chip renders are a table of cheap cases rather than logic buried in the component.
 *
 * One glance answers "how fast does this project move, and how much does it batch": the
 * risk-posture level plus the effective merge-train size, both taken verbatim from
 * `GET /api/projects/:id/delivery` (the server-resolved struct) — nothing here re-derives
 * what a posture level implies, the way the old client-side `resolveRiskPosture` had to.
 */
import type { DeliveryStatusResponse, RiskPostureLevel } from "@agentic-kanban/shared/types";
import { buildMergeActivityChip, describeMergeActivity } from "./deliveryMergeActivity.js";

/** The dot for a red train, a bisect in progress, or a red base holding the queue — distinct from any posture dot by its ring. */
export const MERGE_WARNING_DOT = "bg-red-500 ring-2 ring-red-300 dark:ring-red-700";

export const RISK_POSTURE_DOT: Record<RiskPostureLevel, string> = {
  strict: "bg-blue-500",
  standard: "bg-gray-400 dark:bg-gray-500",
  iterate: "bg-emerald-500",
  fast: "bg-amber-500",
  sprint: "bg-red-500",
  flow: "bg-violet-500",
};

export const RISK_POSTURE_LABELS: Record<RiskPostureLevel, string> = {
  strict: "Strict",
  standard: "Standard",
  iterate: "Iterate",
  fast: "Fast",
  sprint: "Sprint",
  flow: "Flow",
};

export interface DeliveryChipView {
  dotClass: string;
  /**
   * Live merge state first, posture second: `Merging train-05 · 4 tickets · 12m · Iterate`.
   * An older server without `mergeActivity` gets the config-only `Iterate · train 1 (no batching)`.
   */
  label: string;
  /** What fits a phone toolbar: the live state alone (`Merging 4 · 12m`), else `Iterate · 1`. */
  compactLabel: string;
  /** Multi-line tooltip: the behaviour matrix this posture level implies. */
  title: string;
}

/** `train 1` — plain, unbatched; `train N` for N > 1. */
function trainSegment(trainMaxSize: number): string {
  return trainMaxSize <= 1 ? "train 1 (no batching)" : `train ${trainMaxSize}`;
}

export function buildDeliveryChipView(status: DeliveryStatusResponse, nowMs: number = Date.now()): DeliveryChipView {
  const { posture } = status;
  const trainLabel = trainSegment(status.trainWindowMaxSize);
  const sourceNote = status.trainSizeFromOverride ? " (project override)" : "";

  const live = status.mergeActivity
    ? buildMergeActivityChip(status.mergeActivity, status.redBase, status.trainWindowMaxSize, nowMs)
    : null;

  const titleLines = [
    ...(status.mergeActivity ? [...describeMergeActivity(status.mergeActivity, nowMs), ""] : []),
    `Risk posture: ${RISK_POSTURE_LABELS[posture.level]} (source: ${posture.source})`,
    posture.summary,
    "",
    `Gate tier: ${posture.gateTier}`,
    `Review: ${posture.reviewMode}`,
    `Red base policy: ${posture.redBasePolicy}`,
    `Merges / cycle: ${posture.mergesPerCycle}`,
    `Merge train: max ${status.trainWindowMaxSize}, wait ${formatMs(status.trainWindowMaxWaitMs)}${sourceNote}`,
    status.baseSweep.reason,
    describeRedBase(status.redBase),
  ];
  if (status.queuePressure) titleLines.push(describeQueuePressure(status.queuePressure));
  if (status.flush) titleLines.push(describeFlush(status.flush));
  titleLines.push("", "Click for the Delivery controls.");

  if (live) {
    return {
      dotClass: live.warning ? MERGE_WARNING_DOT : RISK_POSTURE_DOT[posture.level],
      label: `${live.label} · ${RISK_POSTURE_LABELS[posture.level]}`,
      compactLabel: live.compactLabel,
      title: titleLines.join("\n"),
    };
  }
  return {
    dotClass: RISK_POSTURE_DOT[posture.level],
    label: `${RISK_POSTURE_LABELS[posture.level]} · ${trainLabel}`,
    compactLabel: `${RISK_POSTURE_LABELS[posture.level]} · ${status.trainWindowMaxSize}`,
    title: titleLines.join("\n"),
  };
}

/**
 * One line for the red-base state (#1233): the latest sweep verdict, whether it is holding the
 * train window right now, and how many heal tickets are open — so "why is nothing merging?"
 * and "is the red being worked on?" are both answerable from the chip.
 */
export function describeRedBase(redBase: DeliveryStatusResponse["redBase"] | undefined): string {
  if (!redBase) return "Red base: not reported";
  const verdict = redBase.latestOutcome
    ? `latest sweep ${redBase.latestOutcome}${redBase.latestSha ? ` at ${redBase.latestSha.slice(0, 8)}` : ""}`
    : "never swept";
  const hold = redBase.holdingWindow
    ? "HOLDING the train window"
    : redBase.latestOutcome === "red"
      ? `not holding the window (policy '${redBase.policy}')`
      : "not holding the window";
  const heal = redBase.openHealTickets > 0
    ? `, ${redBase.openHealTickets} open heal ticket${redBase.openHealTickets === 1 ? "" : "s"}`
    : "";
  return `Red base: ${verdict}, ${hold}${heal}`;
}

/** `Queue pressure: 7 waiting, oldest 48 min, 3.2 arrivals/h vs 1.1 gates/h` — #1246. */
export function describeQueuePressure(pressure: DeliveryStatusResponse["queuePressure"] | undefined): string {
  if (!pressure) return "Queue pressure: not reported";
  const oldest = pressure.oldestWaitingMs === null ? "n/a" : formatMs(pressure.oldestWaitingMs);
  return `Queue pressure: ${pressure.queueDepth} waiting, oldest ${oldest}, ${pressure.arrivalsPerHour.toFixed(1)} arrivals/h vs ${pressure.gateRunsPerHour.toFixed(1)} gates/h`;
}

/**
 * The flush badge (#1246, decision 020 part 3): state plus open heal ticket count, so the
 * operator's three questions — did a flush happen, is its red healed, is the healed state
 * back on master — are answerable from the chip alone. `null` when the project never flushed.
 */
export function describeFlush(flush: DeliveryStatusResponse["flush"] | undefined | null): string {
  if (!flush) return "Flush: none";
  const heal = flush.openHealTickets.length > 0
    ? `, ${flush.openHealTickets.length} open heal ticket${flush.openHealTickets.length === 1 ? "" : "s"}`
    : "";
  return `Flush: ${flush.id} ${flush.state}${heal}`;
}

export interface FlushBadgeView {
  label: string;
  /** True once a red flush has stayed red past one cadence — the "loud" state (decision 020 part 3). */
  urgent: boolean;
}

/** The delivery chip's `flush` badge — state + open heal count, or absent when never flushed. */
export function buildFlushBadge(flush: DeliveryStatusResponse["flush"] | undefined | null): FlushBadgeView | null {
  if (!flush) return null;
  const heal = flush.openHealTickets.length > 0 ? ` (${flush.openHealTickets.length})` : "";
  return {
    label: `flush ${flush.state}${heal}`,
    urgent: flush.state === "red",
  };
}

function formatMs(ms: number): string {
  if (ms <= 0) return "0 (never batches for time)";
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)} h`;
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** Train-size stepper bounds, for the #1156 editor panel. */
export const TRAIN_SIZE_MIN = 1;
export const TRAIN_SIZE_MAX = 20;

export function clampStep(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
