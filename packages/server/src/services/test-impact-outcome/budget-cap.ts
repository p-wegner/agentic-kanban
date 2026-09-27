/**
 * #1261 — re-cut a `select --json` selection to the budget over the WHOLE set, own tests charged
 * first, then rank order, so the gate's pass message and the test-impact ledger price the SAME
 * selection `scripts/test-mine.mjs`'s runner actually executes.
 *
 * `impact.mjs select --budget` fills its seconds GREEDILY in scan order and exempts the diff's own
 * tests (score 99 / the `self` signal) from the cut, but still counts them nowhere against the
 * rest (#1260's finding). `scripts/test-mine.mjs` re-cuts the tool's own `selected` array with
 * `capSelectionToBudget` — own tests first, then the remainder in rank order, strict prefix — and
 * that is what the runner actually spawns. Every OTHER consumer of `select --json` (this gate's
 * pass message, the `#954` outcome ledger) read the tool's raw `selected` array straight, so under
 * a budget they named a WIDER set than the runner ran.
 *
 * This is a deliberate MIRROR of `capSelectionToBudget` in `scripts/test-mine.mjs`, not a shared
 * import: that script is run by bare `node` with no build step, while `packages/server` ships only
 * `dist/` — importing a repo-root script from published server code would break every install that
 * is not this monorepo checkout (the same constraint `always-run-dirs-lockstep.test.ts` documents
 * for the marker-matching rule). The two are held in lockstep by BEHAVIOUR instead, in
 * `budget-cap-lockstep.test.ts`.
 *
 * Only ever removes suites the selector already chose; never adds one.
 */

/** The selector's own price for a suite with no measured duration (`impact.mjs`'s `CFG.defaultDurationMs`). */
export const UNMEASURED_SUITE_MS = 3000;

export interface BudgetCapEntry {
  test: string;
  score?: number;
  durationMs?: number;
  signals?: string[];
}

export interface BudgetCapResult<T extends BudgetCapEntry> {
  kept: T[];
  cut: T[];
  keptMs: number;
  cutMs: number;
  ownCount: number;
}

const isOwn = (s: BudgetCapEntry): boolean => (s.score ?? 0) >= 99 || (s.signals ?? []).includes("self");
const costOf = (s: BudgetCapEntry): number => (typeof s.durationMs === "number" ? s.durationMs : UNMEASURED_SUITE_MS);

/**
 * Cap a `select --json` selection to `budgetMs` over the WHOLE set (#1260/#1261), dropping the
 * lowest-ranked first. The diff's own tests are kept and charged FIRST; the rest is taken in rank
 * order (score, highest first) while it fits; everything after the first suite that does not fit
 * is cut, so a cheap low-ranked suite can never displace a costlier higher-ranked one.
 */
export function capSelectionToBudget<T extends BudgetCapEntry>(selected: T[], budgetMs: number): BudgetCapResult<T> {
  const own = selected.filter(isOwn);
  const ranked = selected.filter((s) => !isOwn(s)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const kept = [...own];
  let keptMs = own.reduce((n, s) => n + costOf(s), 0);
  let i = 0;
  for (; i < ranked.length; i++) {
    if (kept.length > 0 && keptMs + costOf(ranked[i]) > budgetMs) break;
    kept.push(ranked[i]);
    keptMs += costOf(ranked[i]);
  }
  const cut = ranked.slice(i);
  return { kept, cut, keptMs, cutMs: cut.reduce((n, s) => n + costOf(s), 0), ownCount: own.length };
}

/**
 * `KANBAN_TEST_BUDGET`/`test_impact_budget_<id>` as milliseconds, with the selector's own units:
 * `120s`, `90000ms`, and a bare number is ms. Null for anything else. Mirrors
 * `scripts/test-mine.mjs`'s `parseBudgetMs` exactly (see the lockstep test).
 */
export function parseBudgetMs(budget: string | null | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(String(budget ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return (m[2] || "ms").toLowerCase() === "s" ? n * 1000 : n;
}
