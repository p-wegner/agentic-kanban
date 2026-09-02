/**
 * ROW QUALITY: is a ledger row a valid observation, or something that only looks like one?
 *
 * Three pure classifiers, extracted from `test-impact-outcome.service.ts` (#998 follow-up) when
 * #997's reasoning pushed that file past the 1000-line god-module ceiling. This is the gate's own
 * prescription rather than a shuffle to get under a number, and it is the right seam
 * independently: these are the only functions in that module with no I/O, no tool spawn and no
 * knowledge of the ledger's location — they answer one question about a row's CONTENT.
 *
 * They exist because the corpus #954 needs is only as good as its worst row, and the three ways a
 * row can be worthless are each invisible on their own:
 *
 *  - the change set was never computed, so `missed: 0` is true for free (#963);
 *  - the run's selection covers only one half of a union (#967);
 *  - the failing suites were named and then lost to package attribution (#997).
 *
 * Each returns a REASON STRING rather than a boolean, because the caller writes it into the row's
 * source tag and its own log line — a row that is excluded from a metric must be able to say why,
 * or the exclusion is just a quieter version of the defect.
 *
 * Re-exported from the service facade so existing importers are unaffected.
 */
import type { GateRanScope } from "../test-impact-outcome.service.js";

/**
 * Did this row LOSE the names of the suites that failed (#997)?
 *
 * `repoRelativeSuitePath` returns null for a failed suite with no package label, and the caller
 * drops it — correctly, because the same relative path (`src/__tests__/x.test.ts`) exists under
 * every package, so an unattributed name would be wrong rather than merely missing, and a name
 * that can never match `select`'s vocabulary reports a 100% miss rate.
 *
 * What was wrong until #997 is that the drop left NO TRACE. A failing row with `failed: []` meant
 * one of three unrelated things and the ledger could not tell them apart:
 *
 *  1. the verify chain failed OUTSIDE the tests (typecheck, arch, install, smoke) — honest;
 *  2. the runner named a failure but no file (a compile error, a crashed worker) — honest;
 *  3. suites WERE named and every one was dropped for want of a package label — a lost
 *     measurement, recorded as a clean observation.
 *
 * Measured on this board's own corpus 2026-09-02: all 9 failing rows carried `failed: []`, so
 * `missed` was structurally always empty and the miss rate — the entire safety argument for the
 * `impact` gate tier (#954) — was unfalsifiable. Case 3 being indistinguishable from 1 and 2 is
 * why nine consecutive runs produced nothing and nobody noticed.
 *
 * Tagging (rather than dropping the row, or recording the unattributable name) is the same choice
 * {@link emptyChangeSetReason} makes and for the same reason: a dropped row is indistinguishable
 * from "the gate never ran", while a tagged one is filterable and visible. With case 3 tagged, an
 * UNtagged failing row with an empty `failed` set now positively means cases 1-2.
 */
export function unattributedFailureReason(input: { parsed: number; attributed: number }): string | null {
  const dropped = input.parsed - input.attributed;
  if (dropped <= 0) return null;
  return (
    `${dropped} of ${input.parsed} failing suite(s) could not be attributed to a package, so their names were `
    + "dropped — this row's `failed` set is incomplete and its `missed` set cannot be trusted"
  );
}

/**
 * Is this row a valid observation of the SELECTION, or of the always-run baseline (#963)?
 *
 * Returns a reason string when the row is suspect, `null` when it is fine. A gate always runs on a
 * branch that has commits against its base, so an empty change set there is not "a diff that
 * happened to touch nothing" — it means the change set was never computed, and every such row
 * reports `missed: 0` for free. Those rows are what would accumulate into a confidently wrong 0%
 * miss rate.
 *
 * The row is still RECORDED, tagged with a source suffix rather than dropped: a dropped row is
 * indistinguishable from "the gate never ran", while a tagged one is filterable and visible. What
 * it must not do is sit in the corpus looking like a normal observation.
 */
/*
 * A measured note about the rows this tag did NOT catch, so nobody re-diagnoses it (#997).
 *
 * This board's corpus holds 7 rows with an empty change set and a PLAIN `ci` source. They are not
 * evidence of a recorder path that still omits the base: they are all dated
 * 2026-08-30T21:01Z .. 2026-08-31T19:42Z, `a62efaca4b` ("pass the base branch to select/record",
 * #963) landed 2026-08-31 18:20 +0200, and every one of the 20 rows after that last timestamp
 * carries a real change set. The tagging below has simply never had to fire in production because
 * the condition stopped occurring.
 *
 * Those 7 rows are deliberately NOT retro-tagged. The ledger is an append-only record of what was
 * observed, and rewriting it so the history looks better is the opposite of what it is for; a
 * consumer that wants to exclude them can key on the date boundary above. Recorded here rather
 * than only in the ticket because this is the function a reader lands on when they ask why an old
 * row is untagged.
 */
export function emptyChangeSetReason(input: { changed: string[]; baseBranch: string | null | undefined }): string | null {
  if (input.changed.length > 0) return null;
  if (!input.baseBranch) return "no base branch was available, so the change set could not be computed";
  return `the change set against ${input.baseBranch} came back empty`;
}

/**
 * Is this row's `selected` set actually the selector named in `ran`? (#967)
 *
 * Returns a reason string when it is not, `null` when it is. Same discipline as
 * `emptyChangeSetReason`: the row is still recorded, tagged rather than dropped.
 *
 * **The concrete failure this prevents.** A `impact+related` run executes the UNION, but the
 * `selected` list on the row comes from this module's own `select --json` call, which cannot pass
 * `--union` — `vitest related`'s picks come out of vitest's per-package module graph, walked by the
 * runner in the worktree (the same limit `GateImpactSelection.unionUnmeasured` exists for). So
 * `selected` is the impact half only, while `ran` claims the combined selector.
 *
 * `impact.mjs record` then computes `missed = failed.filter((f) => !selected.includes(f))` as a
 * plain string comparison. A suite the ranking did NOT pick but `related` DID — exactly the suites
 * the union was added to recover — runs, and if it fails it lands in `failed` and not in
 * `selected`, so it is scored as a MISS by the very selector that caught it. The corpus that is
 * meant to judge whether the union is worth shipping would be fed evidence against it, generated by
 * the union working.
 *
 * Tagging keeps the row visible and filterable (`stats`' `bySource` breakdown) instead of letting
 * it read as an ordinary observation of the combined selector.
 */
export function unmeasuredUnionReason(input: { ran: GateRanScope }): string | null {
  if (input.ran !== "impact+related") return null;
  return (
    "the run unioned `vitest related`'s picks into the selection, but this row's `selected` list is " +
    "the impact half only — the board cannot walk vitest's module graph — so a failure the related " +
    "half caught would be scored as a miss by the selector that caught it"
  );
}
