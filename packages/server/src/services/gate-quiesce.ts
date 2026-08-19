/**
 * Builder quiescing during a verify gate (#581).
 *
 * Measured live: raising `verify_max_workers` 2 -> 6 (#536) cut this repo's server suite
 * from 2380s to 1564s wall — a real 34% win — and the FIRST gate that ran at 6 workers
 * while two builders were also working failed three `mergeWorkspace` cases that pass
 * everywhere else. Those are slow real-git tests; under load the merge flow never reaches
 * cleanup and an assertion that is really a timing assertion fails. The output named a
 * real test and a plausible defect ("post-merge cleanup did not run"), so it took a
 * 55-minute gate run plus two isolated re-runs to classify as a flake.
 *
 * The cheapest of the ticket's options: while a gate holds the build-concurrency
 * semaphore, the monitor does not START new builders. Nothing running is killed or
 * paused — only the decision to add MORE load is deferred, and the monitor's next cycle
 * is minutes away. A faster gate makes this MORE necessary, not less, because it
 * saturates the box harder for the time it runs.
 */
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { buildGateBusy } from "./jvm-build-semaphore.js";

const quiescePrefDef = projectPref("quiesce_builders_during_gate");

export function quiesceBuildersDuringGatePrefKey(projectId: string): string {
  return quiescePrefDef.key(projectId);
}

/** Default ON: a trustworthy gate result is worth one cycle of start latency. */
export async function quiesceBuildersEnabled(projectId: string, database: Database): Promise<boolean> {
  const raw = await getPreference(quiesceBuildersDuringGatePrefKey(projectId), database).catch(() => null);
  return raw?.trim().toLowerCase() !== "false";
}

/**
 * True when this project's builder starts should be held THIS cycle. The gate check is
 * process-local and free, so it runs first — an idle board never pays the preference read.
 */
export async function shouldQuiesceBuildersForGate(projectId: string, database: Database): Promise<boolean> {
  if (!buildGateBusy()) return false;
  return quiesceBuildersEnabled(projectId, database);
}
