/**
 * `select --json` payload parsing, moved to its own module (#1261 follow-up) when the whole-set
 * budget re-cut pushed `test-impact-outcome.service.ts` past the 1000-line god-module ceiling —
 * the same seam #998 (`row-quality.ts`) and #1098 (`record-args.ts`) used. Re-exported from the
 * service facade so existing importers are unaffected.
 */
import { capSelectionToBudget, type BudgetCapEntry } from "./budget-cap.js";

/**
 * The `select --json` payload, narrowed to what a ledger row needs.
 *
 * Deliberately tolerant: this parses the output of a TOOL that lives outside this package (the
 * skill is materialized into worktrees and updated independently), so an unexpected shape must
 * degrade to "no measurement" rather than throw inside the merge path.
 */
interface SelectPayload {
  tier?: unknown;
  selected?: unknown;
  changed?: unknown;
  belowFloor?: unknown;
  dropped?: unknown;
  estMs?: unknown;
  stale?: unknown;
  signalCounts?: unknown;
}

export interface ParsedSelection {
  tier: string;
  selected: string[];
  changed: string[];
  /**
   * How many candidate suites the selection ranked out BELOW the score floor (#956).
   *
   * This is the number the `impact` gate tier's honesty depends on — it is the size of the tail
   * the tier is betting against — so it is parsed here rather than left to a second reader.
   * Absent (an older tool) reads as 0; the payload has carried it since the skill's 2026-08-30
   * build, and a wrong-low 0 is visible beside `selectedCount` rather than silently distorting a
   * rate the way a missing `changed` would.
   */
  belowFloorCount: number;
  /**
   * How many suites the BUDGET dropped (#966) — they cleared the score floor but did not fit in
   * the allotted time. `impact.mjs` reports these in its own `dropped` array, separately from
   * `belowFloor`, and the two must stay separate here: they name different knobs, and a reader
   * who cannot tell them apart cannot tell whether to raise the budget or lower the floor.
   * Absent (no budget, or an older tool) reads as 0.
   */
  budgetDroppedCount: number;
  /**
   * The tool's own measured estimate of what the selection kept, in ms — the figure the budget
   * is compared against. Undefined when the payload carried none.
   */
  estMs?: number;
  /**
   * Was the impact map stale when the selection was computed? The skill widens to the package
   * tier and prints `[inventory STALE]` in that case, so a stale selection is a DIFFERENT
   * artifact from a fresh one and the gate message must not report them identically. Absent reads
   * as `false` — the honest default is "the tool did not say", and the `selectionTier` printed
   * beside it is what would show the widening.
   */
  stale: boolean;
  /**
   * How many kept entries came from `--union` rather than from the impact ranking (#967) —
   * `signalCounts.external`, the code `impact.mjs` tags every external entry with.
   *
   * Undefined when no union was passed. Read off `signalCounts` rather than counted from
   * `selected[].signals` so a payload shape change on the tool side degrades to "unknown" instead
   * of to a wrong-low number: the tool computes this count once, and re-deriving it here is a
   * second place for the two to disagree.
   */
  externalCount?: number;
}

/**
 * Pull the `{test, score, durationMs, signals}` shape `capSelectionToBudget` needs out of one
 * `selected[]` entry, tolerating the string-only shape an older tool (or a malformed payload)
 * might still produce. A string entry (or one missing `score`/`durationMs`/`signals`) carries no
 * evidence for the cap to rank it by, so it degrades to "unranked, priced at the default" rather
 * than being dropped — the cap must never lose a suite the tool actually selected.
 */
function toBudgetCapEntry(entry: unknown): BudgetCapEntry | null {
  if (typeof entry === "string") return entry.length > 0 ? { test: entry } : null;
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { test?: unknown; score?: unknown; durationMs?: unknown; signals?: unknown };
  if (typeof e.test !== "string" || e.test.length === 0) return null;
  return {
    test: e.test,
    ...(typeof e.score === "number" && Number.isFinite(e.score) ? { score: e.score } : {}),
    ...(typeof e.durationMs === "number" && Number.isFinite(e.durationMs) ? { durationMs: e.durationMs } : {}),
    ...(Array.isArray(e.signals) ? { signals: e.signals.filter((s): s is string => typeof s === "string") } : {}),
  };
}

/**
 * `select --json` output -> `ParsedSelection`, applying the SAME whole-set budget re-cut
 * `scripts/test-mine.mjs`'s runner applies (#1261) — see `budget-cap.ts`'s header for why the
 * tool's own `--budget` cut is not enough on its own.
 *
 * `budgetMs` is optional: the ledger's own `select` call (`recordGateOutcome`) did not pass
 * `--budget` at all before #1261, so a caller with no budget gets the tool's `selected` array
 * verbatim — unchanged behaviour for every unbudgeted project.
 */
export function parseSelection(stdout: string, budgetMs?: number | null): ParsedSelection | null {
  let payload: SelectPayload;
  try {
    payload = JSON.parse(stdout) as SelectPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.selected)) return null;
  const selectedEntries = payload.selected
    .map(toBudgetCapEntry)
    .filter((e): e is BudgetCapEntry => e !== null);
  // #1261 — re-cut over the WHOLE set before anything downstream counts it, so the message and the
  // ledger price exactly what `capJsonSelectionToBudget` in `scripts/test-mine.mjs` kept, not the
  // tool's own greedy-fill cut (which the ticket's #1260 finding showed can keep MORE suites than
  // the runner actually executes under the same budget).
  const capped = budgetMs != null ? capSelectionToBudget(selectedEntries, budgetMs) : null;
  const selected = (capped?.kept ?? selectedEntries).map((e) => e.test);
  const budgetDroppedByCap = capped?.cut.length ?? 0;
  // `changed` is what makes the row auditable (#963): a selection computed from an EMPTY change
  // set is the always-run baseline wearing the selection's name, and nothing else in the row says
  // so. Absent (an older tool) reads as an empty array, which the guard below treats the same way
  // as an observed-empty one — conservative, since neither can be shown to have seen the diff.
  const changed = Array.isArray(payload.changed)
    ? payload.changed.filter((file): file is string => typeof file === "string" && file.length > 0)
    : [];
  // #967 — `signalCounts.external` exists only when `--union` contributed something. Absent means
  // "no union entered this selection", which is a real answer and must stay distinguishable from
  // "a union entered and added zero": the latter is reported as 0 by the tool.
  const signalCounts =
    payload.signalCounts && typeof payload.signalCounts === "object"
      ? (payload.signalCounts as Record<string, unknown>)
      : null;
  const external = signalCounts?.external;
  // #1261 — the tool's OWN `dropped` count (its greedy-fill cut) is superseded by the whole-set
  // re-cut whenever one applies: reporting both would leave a reader unable to tell which number
  // the runner's budget clause actually means. Without a budget, `dropped` stays the tool's own
  // (always 0 when unbudgeted).
  const budgetDroppedCount = capped
    ? budgetDroppedByCap
    : Array.isArray(payload.dropped)
      ? payload.dropped.length
      : 0;
  const estMs = capped
    ? capped.keptMs
    : typeof payload.estMs === "number" && Number.isFinite(payload.estMs)
      ? payload.estMs
      : undefined;
  return {
    tier: typeof payload.tier === "string" ? payload.tier : "unknown",
    selected,
    changed,
    belowFloorCount: Array.isArray(payload.belowFloor) ? payload.belowFloor.length : 0,
    budgetDroppedCount,
    ...(estMs !== undefined ? { estMs } : {}),
    stale: payload.stale === true,
    ...(typeof external === "number" && Number.isFinite(external) ? { externalCount: external } : {}),
  };
}
