/**
 * The Delivery chip's LIVE merge state (pure): what is merging now, what waits, what just
 * finished. The chip used to read only config ("Iterate · train 1"); this is the half that
 * changes minute to minute, built from `DeliveryStatusResponse.mergeActivity`.
 *
 * Precedence, most urgent first: a live train, a train that just went red or was abandoned,
 * branches waiting, a train that just landed, idle.
 */
import type { DeliveryStatusResponse, MergeActivitySummary, MergeActivityTrain } from "@agentic-kanban/shared/types";

/** How long a finished train leads the chip label. The panel shows it for the server's whole window. */
export const LAST_TRAIN_CHIP_MS = 30 * 60 * 1000;

export interface MergeActivityChipState {
  /** `Merging train-05 · 4 tickets · 12m`. */
  label: string;
  /** `Merging 4 · 12m` — the phone toolbar form. */
  compactLabel: string;
  /** A red train, a bisect in progress, or a red base holding the queue. */
  warning: boolean;
}

/** `train/2026-09-27-05` → `train-05`; any other label (older `q<ms>` rows) as is, capped. */
export function shortTrainLabel(label: string): string {
  const m = /^train\/\d{4}-\d{2}-\d{2}-(\d+)$/.exec(label);
  if (m) return `train-${m[1]}`;
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

/** `<1m`, `12m`, `1h 05m`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, "0")}m`;
}

export function sinceMs(iso: string | null | undefined, nowMs: number): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : Number.NaN;
}

function tickets(n: number): string {
  return `${n} ticket${n === 1 ? "" : "s"}`;
}

/** `Merging` / `Bisecting` / `Assembling` / `Landing` — what a live train is doing. */
export function liveTrainVerb(train: MergeActivityTrain): string {
  if (train.state === "assembling") return "Assembling";
  if (train.state === "landing") return "Landing";
  return train.bisecting ? "Bisecting" : "Merging";
}

/** `landed 3 tickets` / `red` / `abandoned` — a finished train's outcome. */
export function finishedOutcome(train: MergeActivityTrain): string {
  if (train.state === "landed") return `landed ${tickets(train.landedCount ?? train.members.length)}`;
  return train.state;
}

function isRecent(train: MergeActivityTrain | null, nowMs: number): train is MergeActivityTrain {
  return train !== null && sinceMs(train.finishedAt, nowMs) <= LAST_TRAIN_CHIP_MS;
}

export function buildMergeActivityChip(
  activity: MergeActivitySummary,
  redBase: DeliveryStatusResponse["redBase"] | undefined,
  trainWindowMaxSize: number,
  nowMs: number,
): MergeActivityChipState {
  const { current, lastFinished, waiting } = activity;
  if (current) {
    const verb = liveTrainVerb(current);
    const elapsed = formatElapsed(sinceMs(current.startedAt, nowMs));
    return {
      label: `${verb} ${shortTrainLabel(current.label)} · ${tickets(current.members.length)} · ${elapsed}`,
      compactLabel: `${verb} ${current.members.length} · ${elapsed}`,
      warning: current.bisecting,
    };
  }
  const recent = isRecent(lastFinished, nowMs) ? lastFinished : null;
  if (recent && recent.state !== "landed") {
    return {
      label: `Last: ${shortTrainLabel(recent.label)} ${finishedOutcome(recent)}`,
      compactLabel: `${shortTrainLabel(recent.label)} ${recent.state}`,
      warning: true,
    };
  }
  if (waiting.length > 0) {
    const held = redBase?.holdingWindow === true;
    const why = held ? "held: red base" : trainWindowMaxSize > 1 ? "waiting for window" : "waiting";
    return { label: `${waiting.length} ready · ${why}`, compactLabel: `${waiting.length} ready`, warning: held };
  }
  if (recent) {
    return {
      label: `Last: ${shortTrainLabel(recent.label)} ${finishedOutcome(recent)}`,
      compactLabel: `${shortTrainLabel(recent.label)} landed`,
      warning: false,
    };
  }
  return { label: "Queue idle", compactLabel: "Idle", warning: false };
}

/** The tooltip's merge lines: the live train, the waiting count, the last finished train. */
export function describeMergeActivity(activity: MergeActivitySummary, nowMs: number): string[] {
  const lines: string[] = [];
  const { current, lastFinished, waiting } = activity;
  if (current) {
    const who = current.members.map((m) => (m.issueNumber != null ? `#${m.issueNumber}` : m.workspaceId.slice(0, 8))).join(" ");
    lines.push(`Merging now: ${current.label} ${liveTrainVerb(current).toLowerCase()}, ${formatElapsed(sinceMs(current.startedAt, nowMs))} (${who})`);
  } else {
    lines.push("Merging now: no train running");
  }
  lines.push(`Ready and waiting: ${waiting.length}`);
  if (lastFinished) {
    const ago = formatElapsed(sinceMs(lastFinished.finishedAt, nowMs));
    const why = lastFinished.failureSummary ? ` - ${lastFinished.failureSummary}` : "";
    lines.push(`Last train: ${lastFinished.label} ${finishedOutcome(lastFinished)}, ${ago} ago${why}`);
  }
  return lines;
}
