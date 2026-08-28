/**
 * The red-debt subset rule (#915) — the pure decision half of "a known-red suite no longer
 * blocks a `fast` train; a NEW red suite still does".
 *
 * Today the merge gate's verdict is binary: any non-zero verify exit withholds the merge,
 * and `describeRedBaseAttribution` only PREFIXES the failure message with "this may not be
 * your fault" — it never changes the outcome. This module is what lets a `fast`/`sprint`
 * posture actually act on that attribution: if every suite the gate just reported failing
 * is ALREADY a ledgered debt entry, the train may land PASS-WITH-DEBT; any suite outside the
 * ledger is new red and still blocks.
 *
 * Pure and client-safe (no node builtins, no schema import) so the same decision can be
 * previewed in the UI — same shape as `profile-allowlist.ts`'s pure-policy kind.
 */

/** The two postures this rule is defined for. `strict`/`standard` never soften a verdict. */
export type RedDebtGatePosture = "fast" | "sprint";

export interface RedDebtLedgerSuite {
  suite: string;
  tag: "flaky" | "real";
}

export interface RedDebtGateInput {
  /** Suites the just-run verify reported as failed. Empty = nothing failed, nothing to decide. */
  failedSuites: string[];
  /** The project's currently OPEN ledger entries. */
  ledger: RedDebtLedgerSuite[];
  posture: RedDebtGatePosture;
}

export type RedDebtGateVerdict =
  | { outcome: "no-failures" }
  /** Every failing suite is already ledgered — the train may land, carrying the debt it named. */
  | { outcome: "pass-with-debt"; carriedDebt: string[]; message: string }
  /** At least one failing suite is NOT ledgered. `fast` rejects outright; `sprint` ledgers the
   *  new suite(s) (a debt ticket is filed via the refill path) and still passes, carrying both
   *  the pre-existing and the newly-opened debt. */
  | { outcome: "rejected"; newRed: string[]; message: string }
  | { outcome: "pass-with-new-debt"; newRed: string[]; carriedDebt: string[]; message: string };

/**
 * Decide the gate verdict for a set of failing suites under the subset rule.
 *
 * `fast`: PASS-WITH-DEBT only when `failedSuites ⊆ ledger`. Any suite outside the ledger
 * rejects the whole gate — a fast train is not the place to absorb new attribution risk.
 *
 * `sprint`: the same subset check softens the outcome instead of rejecting — new red is
 * ledgered (the caller is expected to open a debt entry + file a pay-down ticket for it) and
 * the merge still passes, carrying BOTH the pre-existing and the newly-opened debt. This is
 * the "rejected (`fast`) or ledgered + debt ticket filed via the refill path (`sprint`)" split
 * from the ticket.
 *
 * The message always names the debt it carried (or the new red it refused), per the ticket's
 * acceptance criterion — never a bare "passed"/"failed" that hides which suites were involved.
 */
export function resolveRedDebtGateVerdict(input: RedDebtGateInput): RedDebtGateVerdict {
  const { failedSuites, ledger, posture } = input;
  if (failedSuites.length === 0) return { outcome: "no-failures" };

  const ledgered = new Set(ledger.map((e) => e.suite));
  const carriedDebt = failedSuites.filter((s) => ledgered.has(s));
  const newRed = failedSuites.filter((s) => !ledgered.has(s));

  if (newRed.length === 0) {
    return {
      outcome: "pass-with-debt",
      carriedDebt,
      message: `PASS-WITH-DEBT — every failing suite is known red debt: ${carriedDebt.join(", ")}`,
    };
  }

  if (posture === "fast") {
    return {
      outcome: "rejected",
      newRed,
      message: carriedDebt.length > 0
        ? `REJECTED — new red suite(s) not in the debt ledger: ${newRed.join(", ")} `
          + `(${carriedDebt.length} other failing suite(s) already ledgered: ${carriedDebt.join(", ")})`
        : `REJECTED — new red suite(s) not in the debt ledger: ${newRed.join(", ")}`,
    };
  }

  // sprint: ledger the new red and pass anyway, carrying it.
  return {
    outcome: "pass-with-new-debt",
    newRed,
    carriedDebt,
    message: `PASS-WITH-DEBT (sprint) — ledgered new red suite(s): ${newRed.join(", ")}`
      + (carriedDebt.length > 0 ? `; also carrying known debt: ${carriedDebt.join(", ")}` : ""),
  };
}

/** True when every entry of `failedSuites` is present in `ledgeredSuites`. */
export function isRedSetSubsetOfLedger(failedSuites: readonly string[], ledgeredSuites: readonly string[]): boolean {
  const ledgered = new Set(ledgeredSuites);
  return failedSuites.every((s) => ledgered.has(s));
}
