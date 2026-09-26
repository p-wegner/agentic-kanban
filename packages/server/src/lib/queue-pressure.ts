/**
 * The queue-pressure signal (#1246, decision 020 part 5) — the measured input to a future
 * flush trigger. Pure and synchronous: the caller assembles the pending queue rows and the
 * gate-run ledger rows (`.test-impact/outcomes.jsonl`, #1234) from the DB and the filesystem;
 * this function only judges them.
 *
 * Three numbers answer "is the merge queue under pressure right now": how many branches are
 * ready and waiting, how long the oldest of them has waited, and whether arrivals are
 * outrunning gate throughput (arrivals/hour vs gate-runs/hour). None of them is a verdict —
 * the trigger (#1248) is a separate, later decision over these numbers plus a threshold.
 *
 * Server-only (`packages/server/src/lib`, not `packages/shared/src/lib`): the only consumer
 * is the server's delivery/tracker/CLI read models; `QueuePressureSummary` itself is the wire
 * type and stays in `shared/types/api/monitor.ts` where the client can import it type-only.
 */
import type { QueuePressureSummary } from "@agentic-kanban/shared/types";

export type { QueuePressureSummary };

export interface QueuePressureMember {
  /** ISO timestamp this branch became ready-for-merge / entered the queue. */
  readySince: string;
}

export interface QueuePressureLedgerRow {
  /** ISO timestamp of the event — an arrival (ready-for-merge) or a completed gate run. */
  at: string;
  /** `true` for a completed gate run (#1234 ledger); `false` for an arrival (a branch
   *  becoming ready-for-merge). A row counts toward exactly one of `arrivalsPerHour` /
   *  `gateRunsPerHour` — never both, and never neither. */
  isGateRun: boolean;
}

export interface QueuePressureInput {
  /** Ready-for-merge branches currently waiting (the queue depth). */
  members: readonly QueuePressureMember[];
  /** Arrival + gate-run rows (#1234) to compute arrivals/hour and gates/hour from. */
  ledgerRows: readonly QueuePressureLedgerRow[];
  /** Epoch ms "now" — injected so this stays clock-independent. */
  nowMs: number;
  /** The trailing window, in ms, over which arrivals/gate-runs are rated. Default 1 hour. */
  windowMs?: number;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

function withinWindow(iso: string, nowMs: number, windowMs: number): boolean {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return ms <= nowMs && nowMs - ms <= windowMs;
}

/** Pure: the pressure summary over a queue snapshot and a ledger window. */
export function computeQueuePressure(input: QueuePressureInput): QueuePressureSummary {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const { nowMs } = input;

  const oldestWaitingMs = input.members.reduce<number | null>((oldest, member) => {
    const readyMs = Date.parse(member.readySince);
    if (!Number.isFinite(readyMs)) return oldest;
    const ageMs = nowMs - readyMs;
    if (ageMs < 0) return oldest;
    return oldest === null || ageMs > oldest ? ageMs : oldest;
  }, null);

  const windowRows = input.ledgerRows.filter((row) => withinWindow(row.at, nowMs, windowMs));
  const arrivals = windowRows.filter((row) => !row.isGateRun).length;
  const gateRuns = windowRows.filter((row) => row.isGateRun).length;
  const hours = windowMs / (60 * 60 * 1000);

  return {
    queueDepth: input.members.length,
    oldestWaitingMs,
    arrivalsPerHour: hours > 0 ? arrivals / hours : 0,
    gateRunsPerHour: hours > 0 ? gateRuns / hours : 0,
    windowMs,
  };
}

/** `queue 7 waiting, oldest 48 min, 3.2 arrivals/h vs 1.1 gates/h` — the tracker/CLI one-liner. */
export function formatQueuePressure(summary: QueuePressureSummary): string {
  const oldest = summary.oldestWaitingMs === null ? "n/a" : formatMinutes(summary.oldestWaitingMs);
  return `queue ${summary.queueDepth} waiting, oldest ${oldest}, ${summary.arrivalsPerHour.toFixed(1)} arrivals/h vs ${summary.gateRunsPerHour.toFixed(1)} gates/h`;
}

function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}
