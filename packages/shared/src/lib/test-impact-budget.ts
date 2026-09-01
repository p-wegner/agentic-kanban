/**
 * Per-project test-impact BUDGET — a wall-clock ceiling on the tests a gate/builder run may
 * spend, and the single switch that turns the test-impact selector on (#966).
 *
 * ## Why a budget rather than another boolean
 *
 * The whole test-impact integration was env-only opt-in (`KANBAN_TEST_SELECTOR=impact`,
 * `KANBAN_TEST_MIN_SCORE`), which means it was configured on the BOARD PROCESS rather than on
 * a project — so it could not differ per project, could not be seen in the UI, and could not be
 * changed without a restart. It also had no budget at all: the selection was floored by score
 * and then run in full, however long that took.
 *
 * Since the impact map carries MEASURED per-test durations (#955), a budget finally denominates
 * in seconds rather than in files, which is the unit an operator actually reasons in: "this
 * project's inner loop and its merge gate may spend 60s on tests". That is one number, it is
 * per project, and it is the honest way to express the trade the `impact` tier makes — you are
 * buying wall-clock by dropping a ranked tail.
 *
 * ## Semantics
 *
 * - **Absent / empty / unparseable** → OFF. Nothing is exported, and behaviour is EXACTLY
 *   today's: `vitest related` scoping for the gate, `test:mine`'s own defaults for the builder.
 *   Clearing the field must restore that byte-for-byte, which is why `resolveTestImpactBudgetEnv`
 *   returns `{}` rather than an env map with empty values.
 * - **Set** → the impact selector is implied for BOTH the merge gate and the builder loop
 *   (`KANBAN_TEST_SELECTOR=impact` + `KANBAN_TEST_BUDGET=<value>`). Setting a ceiling on a
 *   selection nobody makes would be inert, so the budget IS the "on" switch. That is deliberate
 *   and is the ticket's framing: "define the time budget and let only these tests run".
 * - **Composes with the score floor, floor first.** `impact.mjs` applies `--min-score` before
 *   `--budget`, so the budget fills the remaining time with the highest-scoring suites that
 *   still clear the floor. Both stay independently configurable (`KANBAN_TEST_MIN_SCORE`).
 *
 * ## Why the value is kept as a STRING
 *
 * `impact.mjs`'s `--budget` takes `<ms|s>` and parses it itself (`parseMs`). Normalising to a
 * number here and re-rendering it would put a second parser in the pipeline that could disagree
 * with the tool's — and the tool's is the one that decides what actually runs. So this module
 * VALIDATES the shape (so a typo is rejected at the settings boundary rather than silently
 * ignored deep in a spawn) and passes the operator's own spelling through unchanged.
 *
 * PURE and client-safe: no node builtins, so the Settings UI validates with the same function
 * the resolver uses.
 */
import { projectPref, type ProjectPref } from "./dynamic-preference-keys.js";

/**
 * The per-project budget key family (`test_impact_budget_<projectId>`).
 *
 * Exported as a ready-made family — NOT hand-built as a template string at each call site —
 * so the resolver and the Settings editor cannot disagree about the key they write and read.
 * The `verify_script_<id>` family drifted exactly that way (see
 * `project-runtime-config.service.ts`), and the client needs it too, which is why it lives in
 * `shared/lib` rather than beside the server resolver.
 */
export const testImpactBudgetPref: ProjectPref = projectPref("test_impact_budget");

/** `test_impact_budget_<projectId>`. */
export function testImpactBudgetPrefKey(projectId: string): string {
  return testImpactBudgetPref.key(projectId);
}

/**
 * A budget as `impact.mjs --budget` accepts it: a positive number, optionally suffixed `ms` or
 * `s`. A bare number is milliseconds there, so `60s` (not `60`) is what an operator almost
 * always means — the Settings field's placeholder says so.
 *
 * **`m` is deliberately NOT accepted, and that is not a nicety.** The tool's `parseMs` is
 * `/s$/.test(v) && !/ms$/.test(v) ? parseFloat(v) * 1000 : parseFloat(v)` — it knows exactly two
 * units, so `2m` falls through to `parseFloat("2m") === 2`, i.e. TWO MILLISECONDS. Accepting `m`
 * here would let the board validate a value, print `budget 2m` in the gate message, and hand the
 * tool a budget that drops every non-always-run suite — a near-empty verification reported as a
 * two-minute one. Minutes are spelled in seconds (`120s`) until `impact.mjs` grows the unit.
 */
const BUDGET_RE = /^(\d+(?:\.\d+)?)(ms|s)?$/i;

/** The parsed budget: the operator's own spelling plus its value in ms, for display/tests. */
export interface ParsedTestImpactBudget {
  /** Exactly what will be handed to `--budget` — the operator's spelling, trimmed. */
  value: string;
  /** Milliseconds, mirroring `impact.mjs`'s own `parseMs`. Never <= 0. */
  ms: number;
}

/**
 * Parse a budget preference value, or null when it is absent/off/unparseable.
 *
 * Returns null rather than throwing or defaulting: an unparseable value means "off", i.e. the
 * pre-#966 behaviour, which is the only failure direction that cannot weaken a gate. (A default
 * budget would silently NARROW the gate on a typo, which is precisely backwards.)
 *
 * Mirrors `impact.mjs`'s `parseMs` unit handling so a value this accepts is a value the tool
 * accepts — a divergence here would be silent, since `--budget` with an unparseable argument
 * simply applies no budget while the board's message claims one.
 */
export function parseTestImpactBudget(raw: string | null | undefined): ParsedTestImpactBudget | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const match = BUDGET_RE.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? "ms").toLowerCase();
  const ms = unit === "s" ? amount * 1_000 : amount;
  return { value, ms };
}

/**
 * True for a value the settings write path may accept.
 *
 * An empty value is accepted deliberately: clearing the field IS how an operator turns the budget
 * off, so rejecting it would leave no way back to the pre-#966 behaviour from the Settings UI.
 */
export function isValidTestImpactBudget(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim();
  return value.length === 0 || parseTestImpactBudget(value) !== null;
}

/** Read the project's budget straight off a prefMap. Pure — the shape every resolver here uses. */
export function resolveTestImpactBudget(
  prefMap: Map<string, string>,
  projectId: string,
): ParsedTestImpactBudget | null {
  return parseTestImpactBudget(prefMap.get(testImpactBudgetPrefKey(projectId)));
}

/**
 * The env a budgeted run exports — `{}` when the budget is off.
 *
 * TWO variables, and both are load-bearing:
 *  - `KANBAN_TEST_SELECTOR=impact` turns the selection on. Without it `KANBAN_TEST_BUDGET` would
 *    be read by nothing, because the `vitest related` path has no notion of a time budget.
 *  - `KANBAN_TEST_BUDGET` is the ceiling itself, passed through to `select --budget`.
 *
 * The base/new-file companions the GATE needs (`KANBAN_IMPACT_BASE`, `KANBAN_TEST_NEW_FILES`)
 * are deliberately NOT here: they are facts about a merge gate's diff, not about the budget, and
 * the builder loop — which has uncommitted work as its change set — must not be handed a base
 * (see `impactBase` in `scripts/test-mine.mjs` for why that would replace the developer's actual
 * change set with "everything committed since the base").
 *
 * Returning `{}` rather than a map of empty strings is what makes "clearing the setting restores
 * today's behaviour exactly" true: an empty-string `KANBAN_TEST_SELECTOR` would still be a SET
 * variable, and `test-mine.mjs` warns on an unrecognised one.
 */
export function resolveTestImpactBudgetEnv(budget: ParsedTestImpactBudget | null): Record<string, string> {
  if (!budget) return {};
  return { KANBAN_TEST_SELECTOR: "impact", KANBAN_TEST_BUDGET: budget.value };
}
