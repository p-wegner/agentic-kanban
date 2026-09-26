/**
 * The queue-pressure signal, assembled (#1246, decision 020 part 5): reads the ready-for-merge
 * queue depth from the DB and the gate-run ledger (#1234, `.test-impact/outcomes.jsonl`) off
 * the main checkout, then hands both to the pure `computeQueuePressure`. Never throws — an
 * unreadable ledger degrades to zero arrivals/gate-runs rather than failing the whole delivery
 * read model, the same fail-open rule `readImpactMissRate` already follows.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeQueuePressure, type QueuePressureSummary } from "../lib/queue-pressure.js";
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

export async function getQueuePressure(
  projectId: string,
  repoPath: string | null | undefined,
  database: Database = db,
  nowMs: number = Date.now(),
): Promise<QueuePressureSummary> {
  const members = await getQueuePressureMemberRows(projectId, database).catch(() => []);
  const ledgerRows = readLedgerRows(repoPath)
    .filter((row) => isGateRow(row) && !isSuspectGateRow(row) && typeof row.at === "string")
    .map((row) => ({ at: row.at as string, isGateRun: true }));
  return computeQueuePressure({ members, ledgerRows, nowMs });
}
