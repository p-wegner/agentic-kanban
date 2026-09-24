import type { GateTierInfo } from "./pre-merge-gate-tier.js";

/**
 * `scripts/test-mine.mjs`'s own `[gate:step]` self-report for its `tests` step, when it says the
 * RUN fell back off the impact selector (#1170).
 *
 * The gate builds `tierInfo.selector === "impact"` from the ENV VAR the gate asked the runner to
 * honour — a REQUEST, resolved before the verify script ever starts. `resolveGateImpactTierFields`
 * separately probes `select --json` in a standalone spawn to describe what the selection WOULD
 * pick, and #1039 already covers the case where that probe finds no tool on disk at all.
 *
 * Neither of those two calls is the actual run. The runner has its OWN spawn of the selector CLI
 * (`runImpactSelector` in `scripts/test-mine.mjs`), inside the real verify script, and it can fail
 * for reasons the two probes above never see — a transient ENOENT on the spawn, a non-zero exit, an
 * empty selection — falling through to `vitest related` while logging only a `console.warn` buried
 * in the verify output. When that happens the tool IS on disk (so `impactSelectorAbsent` stays
 * unset) and the message-side probe can independently succeed (so `impactSelection` is non-null) —
 * so nothing upstream of this function has any reason to doubt the tier. The gate would then print
 * `tier: impact-selected` for a run that actually executed under `vitest related`, which is exactly
 * the silent degradation CLAUDE.md forbids: "an unresolvable selection is supposed to print a loud
 * `selection UNKNOWN`... because silence reads as nothing was dropped."
 *
 * The runner's own `[gate:step] name=tests ... scope=...` line is the one place that carries the
 * TRUTH of what ran, because it is emitted from inside the same process that made the spawn. This
 * reads it back off `tierInfo.stepTimings` (already parsed by `parseVerifyStepTimings`) and compares
 * it against the claimed selector.
 */
/**
 * A selector spawn that never started, as `scripts/test-mine.mjs` reports it (#1231).
 */
export interface ImpactSelectorSpawnFailure {
  /** The spawn errno (`ENOENT`, `EACCES`, `ENAMETOOLONG`, ...), or `UNKNOWN`. */
  code: string;
  /** The resolved selector CLI path the runner tried to start. */
  path: string;
  /** The cwd the spawn was attempted in. */
  cwd: string;
}

/**
 * The runner's `selector FAILED TO SPAWN (<code>: <path>, cwd <cwd>` line (#1231) — the contract
 * with `formatImpactSelectorSpawnFailure` in `scripts/test-mine.mjs`. `<path>` is cut at `, cwd `
 * and `<cwd>` at the next `,` or `)`, so neither may contain that sequence; a Windows path does
 * not. Total: no line, or a malformed one, yields `undefined` and the gate message says only what
 * #1170's fallback detection already says.
 */
const SELECTOR_SPAWN_FAILURE_RE = /selector FAILED TO SPAWN \(([A-Z0-9_]+|UNKNOWN): (.+?), cwd ([^,)]+)/;

export function parseImpactSelectorSpawnFailure(
  output: string | undefined | null,
): ImpactSelectorSpawnFailure | undefined {
  if (!output) return undefined;
  const m = SELECTOR_SPAWN_FAILURE_RE.exec(output);
  if (!m) return undefined;
  return { code: m[1], path: m[2].trim(), cwd: m[3].trim() };
}

export function impactRunnerFellBack(tierInfo: GateTierInfo): boolean {
  if (tierInfo.selector !== "impact" || tierInfo.guardsOnly) return false;
  const testsStep = (tierInfo.stepTimings ?? []).find((step) => step.name === "tests");
  if (!testsStep?.scope) return false;
  // The two scopes an impact-selected `tests` step reports for itself — see `stepScope` in
  // `scripts/test-mine.mjs`. Anything else (`file-scoped`, `package-scoped`, `full`,
  // `flake-retry`) means the runner never reached (or abandoned) the impact branch.
  return testsStep.scope !== "impact-selected" && testsStep.scope !== "impact+related";
}

/**
 * The `impact`-tier gate message fragment: what the test-impact selection kept, dropped, and
 * whether its map was fresh — plus the guard-suite cost clause and the stale-map remedy string.
 *
 * Split out of `pre-merge-gate-tier.ts` when #1046 pushed that file past the god-module ceiling.
 * It is a cohesive unit on its own terms — one selection's facts, rendered as message text — and
 * the tier module re-exports its surface so no caller has to know it moved.
 */

/**
 * What the test-impact selection actually kept and dropped, for the gate message (#956).
 *
 * The `impact` tier's whole risk is in the tail it drops, so the message may not stop at naming
 * the tier: the repo's rule is that a level may only weaken verification VISIBLY, and "impact
 * tier, 12 suites" hides both HOW MANY suites were ranked out below the floor and whether the map
 * that ranked them was even current. A selection made from a STALE map is a materially different,
 * weaker claim than one made from a fresh map — the skill itself widens to the package tier and
 * prints `[inventory STALE]` in that case — and the two must not read the same.
 *
 * Every field is optional-by-absence at the type level only in the sense that the whole object is;
 * when the gate could not resolve a selection at all it carries `null` and the message SAYS the
 * selection facts are unknown rather than omitting the subject.
 */
export interface GateImpactSelection {
  /** How many test files the selection kept — the suites that actually ran (plus guards). */
  selectedCount: number;
  /** How many were ranked out BELOW the score floor. This is the tail the tier is betting on. */
  belowFloorCount: number;
  /**
   * Was the impact map stale when the selection was computed?
   *
   * #1018 moved the map out of git without changing what this word means. "Fresh" is, and always
   * was, a statement about the map's OWN recorded `commit:` stamp: `impact.mjs check`/`select`
   * count `<stamp>..HEAD` and look for test files added since, and neither reads the index. What
   * changed is only WHICH copy is being described — the snapshot the board materialized into this
   * worktree, which is exactly the map the run used, rather than one inherited by branching.
   */
  stale: boolean;
  /** The selection tier the skill itself reported (`impact` | `package` | `all`). */
  selectionTier?: string;
  /** How many changed files the selection saw — 0 means it never saw the diff (#963). */
  changedCount?: number;
  /**
   * The budget the selection was made under, as the operator spelled it (#966), or undefined
   * when no budget applied. Named in the message because a budget is a SECOND, independent
   * narrowing on top of the score floor: `dropped 37 below the score floor` says nothing about
   * how many more the clock dropped, and an operator reading a passing gate has to be able to
   * tell "the tail scored too low" from "we ran out of the 60 seconds you allotted".
   */
  budget?: string;
  /**
   * How many suites the BUDGET dropped (i.e. cleared the score floor but did not fit in the
   * time). Distinct from `belowFloorCount` on purpose — collapsing them would hide which knob
   * to turn.
   */
  budgetDroppedCount?: number;
  /**
   * The selection's own measured estimate of what it kept, in ms — the number the budget is
   * compared against. Undefined when the tool did not report one.
   */
  estMs?: number;
  /**
   * How many of the kept suites came from the OTHER selector rather than from the impact score
   * (#967) — `signalCounts.external` in `select --json`, i.e. entries `--union` contributed that
   * the impact ranking had not already picked.
   *
   * This is the provenance the ticket requires the message to state: `impact 143 + related added
   * 12` is a materially different claim from `impact 155`, because the 12 carry no impact evidence
   * at all — they are there because a second, differently-blind selector asked for them. Undefined
   * when no union was passed (there is nothing to attribute); 0 when one was and the impact
   * ranking had already picked every one of its suites, which is a real and worth-saying result.
   */
  externalCount?: number;
  /**
   * The run UNIONED a second selector in, but this DESCRIPTION could not reproduce that half
   * (#967).
   *
   * Why the case exists at all. The gate's message is built from a second `select --json` call
   * (`resolveGateSelection`), which is what keeps message and ledger from disagreeing about what the
   * selection was. That call can pass everything the run passes — base, floor, budget — except one:
   * the `--union` list, which is `vitest related`'s suite set for the changed files, derived by the
   * RUNNER by booting a vitest instance per package. Reproducing it here would mean doing that
   * inside the merge path, for a message.
   *
   * So the description covers the impact half exactly and the related half not at all. The numbers
   * it reports are therefore a LOWER BOUND on what ran, and this flag is what makes the message say
   * so. The alternative — printing `kept 143` for a run that executed 155 — is a level weakening
   * verification invisibly in the one direction that flatters it, which is the failure this whole
   * tier's messaging exists to prevent.
   */
  unionUnmeasured?: boolean;
}

/**
 * What a reader of a STALE gate message is supposed to DO (#1046).
 *
 * `map STALE` alone was a fact with no verb: the selection had already widened to the package tier
 * — the slow path — and the only signal was one word in a message nobody reads at that moment, so
 * the gate silently got slower for a reason that looks like nothing changed. The word stays (tests
 * and operators both match on it) and now carries the consequence and the remedy.
 *
 * The remedy names the MAIN CHECKOUT deliberately: rebuilding from a worktree writes a
 * worktree-local map that helps nobody and breaks the single-writer property the whole artifact
 * rests on. ASCII only, for the same reason the selector clause above is — this string travels
 * through merge comments, PowerShell hosts and log files on Windows.
 */
export const IMPACT_MAP_STALE_REMEDY =
  "a stale map WIDENS the selection to the package tier, so this run was slower and broader than the tier claims; "
  + "rebuild it on the project's MAIN CHECKOUT with `node .claude/skills/test-impact/tools/impact.mjs build "
  + "--durations docs/tests/durations.json` (never from a worktree), or wait for the test-impact-map sweep";

/**
 * The impact selection's facts as a message fragment (#956), or null when there is nothing to say.
 *
 * Extracted from `buildGateTierMessage` rather than inlined because it is the part with a real
 * decision in it — an unresolved selection must produce a LOUDER string than a resolved one, which
 * is the opposite of the usual "omit when absent" shape used for the optional fields around it.
 */
export function buildImpactSelectionNote(tierInfo: GateTierInfo): string | null {
  if (tierInfo.selector !== "impact" || tierInfo.guardsOnly) return null;
  // #1170 — the runner's OWN self-report of what it ran outranks everything else this function
  // knows: the tool being on disk and a standalone probe succeeding both describe a WOULD-run, not
  // the run that produced this verdict. See `impactRunnerFellBack` for why the two upstream checks
  // (#1039's `impactSelectorAbsent`, `impactSelection`'s own null case) both miss this.
  if (impactRunnerFellBack(tierInfo)) {
    const ranScope = (tierInfo.stepTimings ?? []).find((step) => step.name === "tests")?.scope;
    // #1231 — WHY it fell back, when the runner said. A spawn failure is not the same finding as
    // #1039's ABSENT: the tool was there (or the runner would not have had a path to try), and
    // the thing to look at is the errno, the node binary or the cwd — not skill provisioning.
    const spawn = tierInfo.impactSelectorSpawnFailure;
    if (spawn) {
      return (
        `selection UNKNOWN — selector FAILED TO SPAWN (${spawn.code}: ${spawn.path}, cwd ${spawn.cwd}; ` +
        `the runner fell back to \`vitest related\`, tests ran scope=${ranScope} — the tier below is what was ` +
        "REQUESTED, not what ran; the verify log's `[test:mine] impact selector failed to start` line names the node binary)"
      );
    }
    return (
      `selection UNKNOWN — RUNNER FELL BACK (the verify script reported tests ran ` +
      `scope=${ranScope}, not impact-selected; check the verify log for ` +
      "\"impact selector failed to start\" or \"exited N\" -- the tier below is what was REQUESTED, not what ran)"
    );
  }
  const selection = tierInfo.impactSelection;
  if (!selection) {
    // Silence here would read as "nothing was dropped". The tier narrowed the run by an amount
    // nobody can state, which is strictly worse than a stated number and must say so.
    //
    // #1039 — and WHY it could not be resolved, when the reason is that the selector itself was
    // not in the worktree. That is not a tool hiccup: it means the plugin skill never reached
    // this checkout, so the runner either fell back to `vitest related` (a different tier wearing
    // this one's name) or picked up a machine-local copy under $HOME that the board did not
    // provision. Either way the operator has to be told in the gate message, not in a
    // `console.warn` that scrolled past in the runner's stdout.
    if (tierInfo.impactSelectorAbsent) {
      return (
        `selection UNKNOWN — selector ABSENT (${tierInfo.impactSelectorAbsent} is not in the worktree; ` +
        "the runner fell back to `vitest related` or to a machine-local copy under $HOME, neither of " +
        "which the board provisioned — check that the test-impact plugin's skill is materialized, #1039)"
      );
    }
    return "selection UNKNOWN (could not be resolved — what it dropped is unmeasured)";
  }
  // `map stale` is not a footnote: the skill widens to the package tier and prints
  // `[inventory STALE]` when the map is behind, so the selection is a different, weaker artifact.
  // "map fresh" is stated too — an absent word would leave a reader unable to tell a fresh
  // selection from an older gate message that predates this field.
  //
  // #966 — the BUDGET and what it cost come FIRST when one applies. A tier that weakens
  // verification must say what it ran, and under a budget the headline fact is no longer the
  // score floor but the clock: `budget 60s, est 58s` is the claim, and `dropped N over budget`
  // is the tail that claim bought. Both drop counts are printed, never summed — they name
  // different knobs (`test_impact_budget` vs `KANBAN_TEST_MIN_SCORE`).
  const budgetNote = selection.budget
    ? `budget ${selection.budget}` +
      (selection.estMs !== undefined ? `, est ${Math.round(selection.estMs / 1000)}s` : "") +
      (selection.budgetDroppedCount ? `, dropped ${selection.budgetDroppedCount} over budget` : "") +
      ", "
    : "";
  // #967 — the PROVENANCE of the kept set, when two selectors contributed. `selection kept 155`
  // hides that 12 of them carry no impact evidence and are present only because `vitest related`
  // asked for them; an operator judging whether to trust the selector needs the split, and #954's
  // corpus is judging the COMBINED selector, so the message has to name what "combined" meant here.
  //
  // `unionUnmeasured` is the third case and the one that must never be silent: the run unioned a
  // second selector in, but this description could not reproduce that half (see the field's doc),
  // so every number here is a LOWER BOUND. Printing them bare would understate what ran — which is
  // the flattering direction, and therefore the one that has to be labelled.
  //
  // #1043 — the selection's own COST rides on this clause whenever the tool reported one, and NOT
  // only under a budget as it did before. The whole point of the split is that a reader can weigh
  // the two halves against each other; `selection kept 1 suite(s)` beside `+176 guard suites
  // (~543s est)` still leaves the cheap half unpriced. Omitted when the budget clause above
  // already printed the same `est` figure, rather than saying it twice.
  const cost =
    selection.estMs !== undefined && !budgetNote ? `/~${Math.round(selection.estMs / 1000)}s est` : "";
  const kept =
    selection.externalCount !== undefined
      ? `selection kept ${selection.selectedCount} suite(s)${cost} (impact ${selection.selectedCount - selection.externalCount} + related added ${selection.externalCount})`
      : selection.unionUnmeasured
        ? `selection kept ${selection.selectedCount} impact suite(s)${cost} PLUS the \`vitest related\` scope (unioned at run time, not counted here — these figures are a lower bound)`
        : `selection kept ${selection.selectedCount} suite(s)${cost}`;
  return (
    `${budgetNote}${kept}, dropped ${selection.belowFloorCount} below the score floor` +
    (selection.selectionTier ? `, selection tier ${selection.selectionTier}` : "") +
    (selection.stale ? `, map STALE — ${IMPACT_MAP_STALE_REMEDY}` : ", map fresh")
  );
}

/**
 * The guard half's COST, as a parenthesised suffix on the guard-suite count (#1043).
 *
 * `""` when no duration report was readable — an absent estimate is honest, an invented one is
 * not, and this clause exists precisely because a number that quietly means something other than
 * it says is worse than no number. `est` is stated on the figure it applies to: these are summed
 * per-file measurements from `docs/tests/durations.json`, not a stopwatch on this run.
 */
export function buildGuardCostNote(tierInfo: GateTierInfo): string {
  if (tierInfo.guardEstMs === undefined) return "";
  const assumed = tierInfo.guardAssumedCount
    ? `, ${tierInfo.guardAssumedCount} unmeasured`
    : "";
  return ` (~${Math.round(tierInfo.guardEstMs / 1000)}s est${assumed})`;
}
