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

export const RISK_POSTURE_DOT: Record<RiskPostureLevel, string> = {
  strict: "bg-blue-500",
  standard: "bg-gray-400 dark:bg-gray-500",
  iterate: "bg-emerald-500",
  fast: "bg-amber-500",
  sprint: "bg-red-500",
};

export const RISK_POSTURE_LABELS: Record<RiskPostureLevel, string> = {
  strict: "Strict",
  standard: "Standard",
  iterate: "Iterate",
  fast: "Fast",
  sprint: "Sprint",
};

export interface DeliveryChipView {
  dotClass: string;
  /** `iterate · train 1` — `train 1` reads as "no batching", which is the whole point. */
  label: string;
  /** What fits a phone toolbar: `Iterate · 1`. */
  compactLabel: string;
  /** Multi-line tooltip: the behaviour matrix this posture level implies. */
  title: string;
}

/** `train 1` — plain, unbatched; `train N` for N > 1. */
function trainSegment(trainMaxSize: number): string {
  return trainMaxSize <= 1 ? "train 1 (no batching)" : `train ${trainMaxSize}`;
}

export function buildDeliveryChipView(status: DeliveryStatusResponse): DeliveryChipView {
  const { posture } = status;
  const trainLabel = trainSegment(status.trainWindowMaxSize);
  const sourceNote = status.trainSizeFromOverride ? " (project override)" : "";

  const titleLines = [
    `Risk posture: ${RISK_POSTURE_LABELS[posture.level]} (source: ${posture.source})`,
    posture.summary,
    "",
    `Gate tier: ${posture.gateTier}`,
    `Review: ${posture.reviewMode}`,
    `Red base policy: ${posture.redBasePolicy}`,
    `Merges / cycle: ${posture.mergesPerCycle}`,
    `Merge train: max ${status.trainWindowMaxSize}, wait ${formatMs(status.trainWindowMaxWaitMs)}${sourceNote}`,
    status.baseSweep.reason,
    "",
    "Click for the Delivery controls.",
  ];

  return {
    dotClass: RISK_POSTURE_DOT[posture.level],
    label: `${RISK_POSTURE_LABELS[posture.level]} · ${trainLabel}`,
    compactLabel: `${RISK_POSTURE_LABELS[posture.level]} · ${status.trainWindowMaxSize}`,
    title: titleLines.join("\n"),
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
