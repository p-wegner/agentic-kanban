/**
 * The queue-pressure signal, assembled (#1246, decision 020 part 5): reads the ready-for-merge
 * queue depth from the DB, the gate-run ledger (#1234, `.test-impact/outcomes.jsonl`) off
 * the main checkout, then hands both to the pure `computeQueuePressure`. Never throws — an
 * unreadable ledger degrades to zero arrivals/gate-runs rather than failing the whole delivery
 * read model, the same fail-open rule `readImpactMissRate` already follows.
 *
 * **Arrivals are NOT gate runs.** An "arrival" is a branch becoming ready-for-merge (entering
 * the queue); a "gate run" is the pre-merge gate executing. Using the gate ledger for both (as
 * an earlier version of this function did) makes `arrivalsPerHour` and `gateRunsPerHour`
 * structurally identical — every gate-ledger row would count as one of each — which defeats
 * the whole point of the comparison ("are arrivals outrunning gate throughput?" can never be
 * true if the two are always equal). Arrivals are read off the SAME queue-member rows that
 * feed `queueDepth`/`oldestWaitingMs`, using `readySince` as the arrival timestamp; gate runs
 * stay sourced from the ledger.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeQueuePressure, type QueuePressureLedgerRow, type QueuePressureSummary } from "../lib/queue-pressure.js";
import { getQueuePressureMemberRows } from "../repositories/merge-queue.repository.js";
import { isGateRow, isSuspectGateRow, parseJsonlRows, type LedgerRow } from "./test-impact-misses.js";
import { OUTCOMES_RELATIVE_PATH } from "./test-impact-outcome.service.js";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";

function readLedgerRows(repoPath: string | null | undefined): LedgerRow[] {
  if (!repoPath) return [];
  try {
    const outcomesPath = resolve(repoPath, OUTCOMES_RELATIVE_PATH);
    if (!existsSync(outcomesPath)) return [];
    return parseJsonlRows<LedgerRow>(readFileSync(outcomesPath, "utf8"));
  } catch {
    return [];
  }
}

export type QueuePressureMemberRow = Awaited<ReturnType<typeof getQueuePressureMemberRows>>[number];

/** The ready-for-merge queue rows; never throws (an unreadable queue reads as empty). */
export function readQueuePressureMembers(projectId: string, database: Database = db): Promise<QueuePressureMemberRow[]> {
  return getQueuePressureMemberRows(projectId, database).catch(() => []);
}

export async function getQueuePressure(
  projectId: string,
  repoPath: string | null | undefined,
  database: Database = db,
  nowMs: number = Date.now(),
  /** Already-read queue rows (the delivery read model reuses them for its waiting list); read here when absent. */
  preloadedMembers?: QueuePressureMemberRow[],
): Promise<QueuePressureSummary> {
  const members = preloadedMembers ?? await readQueuePressureMembers(projectId, database);
  const arrivalRows: QueuePressureLedgerRow[] = members.map((m) => ({ at: m.readySince, isGateRun: false }));
  const gateRows: QueuePressureLedgerRow[] = readLedgerRows(repoPath)
    .filter((row) => isGateRow(row) && !isSuspectGateRow(row) && typeof row.at === "string")
    .map((row) => ({ at: row.at as string, isGateRun: true }));
  return computeQueuePressure({ members, ledgerRows: [...arrivalRows, ...gateRows], nowMs });
}
