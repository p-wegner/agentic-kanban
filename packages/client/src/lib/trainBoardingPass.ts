/**
 * Card-facing "boarding pass" chip for a workspace aboard a release train (#1188).
 *
 * A ticket sitting in a gating train looked identical to one nobody had touched — the evidence
 * lived only in `merge_trains.gate_evidence`. The server attaches a small structural fact set to
 * `MainWorkspaceInfo.trainBoardingPass` (label, car position of N, phase, elapsed since boarding,
 * and — once terminal — the outcome), declared once as `TrainBoardingPassDto` in
 * `shared/src/types/api/merge-train.ts` (per `wire-dto-single-declaration.test.ts`, a wire DTO is
 * declared ONCE); this module is the pure projection into chip text, kept in `client/src/lib/`
 * per this package's `lib/<feature>.ts` convention so it is testable without a component.
 */
import type { TrainBoardingPassDto, TrainBoardingPassOutcomeDto } from "@agentic-kanban/shared";

export type TrainBoardingPassSource = TrainBoardingPassDto;
export type TrainBoardingPassOutcome = TrainBoardingPassOutcomeDto;

export interface TrainBoardingPass {
  /** Short chip text, e.g. `Train q1a2b3 · car 2/4 · gating · 12m`. */
  label: string;
  /** Full explanation for the tooltip. */
  tooltip: string;
}

function parseMs(iso: string, fallback: number): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Compact duration for a chip: `45s`, `12m`, `3h12m`. Mirrors `formatGateDuration`'s shape. */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

function describeOutcome(outcome: TrainBoardingPassOutcome): { label: string; tooltip: string } {
  switch (outcome.kind) {
    case "landed": {
      const withOthers = outcome.withIssueNumbers.filter((n) => Number.isFinite(n));
      const label = withOthers.length > 0
        ? `landed with ${withOthers.map((n) => `#${n}`).join(" ")}`
        : "landed";
      return {
        label,
        tooltip: withOthers.length > 0
          ? `Landed as part of a train together with ${withOthers.map((n) => `#${n}`).join(", ")}.`
          : "Landed via a release train.",
      };
    }
    case "dropped":
      return { label: `dropped: ${outcome.reason}`, tooltip: `Dropped from the train: ${outcome.reason}` };
    case "bisected-out":
      return { label: "bisected out", tooltip: `Bisected out of the train: ${outcome.reason}` };
    case "unresolved":
      return {
        label: "unresolved",
        tooltip: "The train failed and this ticket's disposition was never individually attributed.",
      };
  }
}

/** Project the server's boarding-pass facts into chip text, or `null` when there is nothing to show. */
export function deriveTrainBoardingPass(
  source: TrainBoardingPassSource | null | undefined,
  nowMs: number = Date.now(),
): TrainBoardingPass | null {
  if (!source) return null;

  const carLabel = `car ${source.carPosition}/${source.memberCount}`;

  if (source.outcome) {
    const { label, tooltip } = describeOutcome(source.outcome);
    return {
      label: `Train ${source.label} · ${carLabel} · ${label}`,
      tooltip: `Train ${source.label}, ${carLabel}. ${tooltip}`,
    };
  }

  const elapsedMs = Math.max(0, nowMs - parseMs(source.boardedAt, nowMs));
  const phase = source.phase ?? "assembling";
  return {
    label: `Train ${source.label} · ${carLabel} · ${phase} · ${formatElapsed(elapsedMs)}`,
    tooltip:
      `Train ${source.label}, ${carLabel}, currently ${phase}. `
      + `Boarded ${formatElapsed(elapsedMs)} ago.`,
  };
}
