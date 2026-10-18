// Flaky red-debt ledger writes, split out of pre-merge-gate.service.ts (#1605).
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { FailedSuite } from "./verify-flake-retry.js";
import { openRedDebtEntry } from "../repositories/red-debt.repository.js";



/**
 * Open a `flaky`-tagged red-debt ledger entry for every suite #894's targeted re-run just
 * cleared (#915). Recording it here means the NEXT gate can consult the ledger's subset rule
 * instead of paying for another 45-minute full re-run to rediscover the same load-induced
 * flake. Best-effort by construction: an unrecordable entry must never turn a passing gate red.
 *
 * The subset rule (#915) compares ledger suite names against `failedSuitesForOutcome`'s output
 * (`failed-suite-parse.ts`), which never carries a package prefix — it normalizes to a bare
 * forward-slash path. `FailedSuite.file` here is ALREADY in that shape (`verify-flake-retry.ts`
 * strips ANSI and backslashes the same way); `packageLabel` exists only to disambiguate
 * same-named files across packages during the retry itself and must NOT be prepended here, or a
 * suite this ledgers as `flaky` would never string-match the base-health probe's un-prefixed
 * name on the next gate run — silently defeating the exact quarantine this exists to provide.
 */
export async function recordFlakySuitesAsRedDebt(args: {
  flakySuites: FailedSuite[] | undefined;
  projectId: string;
  workingDir: string | null;
  database: Database;
}): Promise<void> {
  const { flakySuites, projectId, workingDir, database } = args;
  if (!flakySuites || flakySuites.length === 0) return;
  const sinceCommit = workingDir
    ? ((await revParse(workingDir, "HEAD").catch(() => null)) ?? "unknown")
    : "unknown";
  for (const suite of flakySuites) {
    const suiteName = suite.file;
    await openRedDebtEntry({ projectId, suite: suiteName, sinceCommit, tag: "flaky" }, database).catch((err) => {
      console.warn(`[pre-merge-gate] failed to open flaky red-debt entry for ${suiteName} (non-fatal):`, errorMessage(err));
    });
  }
}
