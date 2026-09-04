/**
 * The HARNESS BUDGET (#1021) — how much of the board's concurrency may go into the
 * machinery that builds the product rather than the product itself.
 *
 * Measured in the proposal `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md`
 * §3.E: 158 of 261 non-merge commits since 2026-08-25 (61 %) were harness work — the
 * gate, the impact map, guards, ratchets, typecheck, hooks, the merge path. The budget
 * a healthy board is supposed to spend there is a fifth to a quarter. Nothing anywhere
 * expressed that as a rule, so the only way to notice the drift was to grep the log
 * once, by hand, after the fact.
 *
 * This module is the pure half of the rule: the tag's spelling, the default share, the
 * arithmetic that turns a share into a slot count, and the keyword heuristic an enhancer
 * can use to propose the tag. Everything that touches the database or the monitor cycle
 * lives in the server (`repositories/harness-tag.repository.ts`,
 * `startup/monitor-harness-budget.ts`), so this stays importable from the client.
 */

/** The ticket tag the monitor reads. Set by hand, or proposed by an enhancer. */
export const HARNESS_TAG = "harness";

/**
 * Default share of the effective WIP that may run harness tickets: 1 builder of 3.
 *
 * 34 rather than 33 so that `floor(3 * share / 100)` is exactly 1 — the acceptance
 * criterion is stated in builders ("at most one of three"), not in percent, and a
 * rounding that silently yielded 0 would stop harness work entirely.
 */
export const DEFAULT_HARNESS_SHARE_PCT = 34;

export const MIN_HARNESS_SHARE_PCT = 1;
export const MAX_HARNESS_SHARE_PCT = 100;

/**
 * How many concurrent builders this project may spend on `harness` tickets.
 *
 * Floor of 1: a share small enough to round to zero would mean "never start harness
 * work", which is a different rule (that is what the `no-auto-start` tag is for) and
 * would wedge any board whose backlog is temporarily all harness. 100 % returns the
 * whole WIP, i.e. the budget never bites — the documented way to restore the behaviour
 * this rule replaced.
 */
export function harnessSlots(wipLimit: number, sharePct: number): number {
  if (!Number.isFinite(wipLimit) || wipLimit <= 0) return 0;
  const share = clampHarnessSharePct(sharePct);
  if (share >= MAX_HARNESS_SHARE_PCT) return Math.floor(wipLimit);
  return Math.max(1, Math.floor((wipLimit * share) / 100));
}

export function clampHarnessSharePct(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_HARNESS_SHARE_PCT;
  return Math.max(MIN_HARNESS_SHARE_PCT, Math.min(MAX_HARNESS_SHARE_PCT, Math.round(parsed)));
}

/**
 * Words that mark a ticket as work on the machinery rather than on the product. Taken
 * from the proposal's own enumeration of what the 61 % consisted of, so the classifier
 * measures the same thing the budget is meant to cap.
 */
export const HARNESS_KEYWORDS = [
  "harness",
  "pre-merge gate",
  "merge gate",
  "gate tier",
  "ratchet",
  "guard suite",
  "always-run",
  "impact map",
  "test-impact",
  "test selection",
  "typecheck",
  "god-module",
  "depcruise",
  "dependency-cruiser",
  "pre-commit hook",
  "pretooluse",
  "posttooluse",
  "hook script",
  "merge path",
  "merge reconciler",
  "monitor cycle",
  "auto-start",
  "flaky test",
  "ci pipeline",
  "lint rule",
] as const;

/**
 * A HEURISTIC, deliberately: it proposes the tag, it does not own it. The tag on the
 * ticket is the truth the monitor reads, so a human (or an enhancer's reviewer) can
 * always overrule this by adding or removing it. Returning true on a product ticket
 * costs one deferred cycle; returning false on a harness ticket costs nothing but the
 * budget's accuracy — so the list is kept specific rather than broad ("test" alone
 * would match most of the product backlog).
 */
export function looksLikeHarnessTicket(...parts: Array<string | null | undefined>): boolean {
  const text = parts.filter((p): p is string => typeof p === "string").join(" ").toLowerCase();
  if (!text.trim()) return false;
  return HARNESS_KEYWORDS.some((keyword) => text.includes(keyword));
}

/**
 * The share, as a percentage, that harness tickets took of a set of completed tickets.
 * Returns null for an empty set rather than 0 — "no tickets landed this week" and
 * "no harness tickets landed this week" are different answers, and rendering the first
 * as `0 %` would read as a budget being respected when nothing was measured at all.
 */
export function harnessSharePct(total: number, harness: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round((harness / total) * 100);
}
