/**
 * Build the argv (and optional stdin) for `impact.mjs record`.
 *
 * Extracted from `test-impact-outcome.service.ts` (#1098 follow-up) when this fix pushed that
 * file past the 1000-line god-module ceiling — the same seam #998 used for `row-quality.ts`. This
 * is a self-contained concern: turning a ledger row's fields into the argv/stdin a spawn needs,
 * with no I/O of its own.
 *
 * Re-exported from the service facade so existing importers are unaffected.
 */
import type { GateRanScope } from "../test-impact-outcome.service.js";

/**
 * Windows' `CreateProcess` argv ceiling is 32,767 chars. A base sweep's `--selected` list can run
 * to hundreds of suites (#1098 — 536 related suites comma-joined to 33,735 chars, measured on a
 * diff touching `packages/server/src/db/index.ts`), which spawns `impact.mjs record` past that
 * limit and fails `ENAMETOOLONG` — silently, from the caller's point of view, since the row is
 * just lost and the only trace is a warning log. This margin below the real ceiling leaves room
 * for `process.execPath` and the rest of argv; it is a proactive check, not the exact OS number.
 */
export const RECORD_ARGV_SAFE_LIMIT = 30_000;

/** Rough argv length as the OS would see it — not exact (no quoting accounted for), conservative enough to gate on. */
export function estimatedArgvLength(args: readonly string[]): number {
  return args.reduce((total, arg) => total + arg.length + 1, 0);
}

/**
 * Does the `impact.mjs` at this path accept `--selected -` (read a newline-separated list from
 * stdin), the same convention `select --union` already uses (#967)?
 *
 * A **static text scan**, not a spawned `--help` — cheap, and the tool is a script whose usage
 * text is right there in the file `select`'s own doc comment already advertises `--union
 * <a,b|file|->` in. #1098 asks the tool's own repo (not this one) to extend `--selected` the same
 * way; until that lands, this reads false and the recorder keeps the old inline behaviour rather
 * than handing a literal `-` to a tool that would read it as one test named `-`.
 */
export function recordAcceptsSelectedViaStdin(toolSource: string): boolean {
  return /--selected\s*<a,b\|->/.test(toolSource);
}

/**
 * Build the argv (and optional stdin) for `impact.mjs record`.
 *
 * Pure and exported so the flag wiring — the part that silently produces a useless row when it is
 * wrong — is a table test rather than something only an end-to-end gate run would catch.
 *
 * **`--selected` is passed VERBATIM, including when the selection is empty.** It used to be
 * omitted, on the reasoning that `record` treated an empty selection as "no selection recorded"
 * so passing `--selected ""` would make every failure read as a miss. The tool no longer works
 * that way and the distinction is now load-bearing (verified against the skill at `3e362b6`,
 * `impact.mjs:1662`/`:1680`):
 *
 *  - flag PRESENT with zero entries -> `selectionEmpty: true`, and `missed` is computed, so a
 *    failing run whose selector picked nothing is scored as the full miss it is;
 *  - flag ABSENT -> unknown, the row witnesses nothing. Same as before.
 *
 * Which of those a row gets is the difference between measuring the selector and quietly
 * excusing it in exactly the case where it did worst.
 *
 * An empty selection is unreachable for THIS project — the recorder passes `--always-run` and
 * this repo has ~170 guard suites, so the selection is never smaller than that — and that is
 * precisely why the old reasoning survived. It is not a property of the recorder: it runs for
 * every registered project with the plugin, and a small repo with no `@gate:always-run` markers
 * legitimately selects nothing for a docs-shaped change. The first external adopter is where the
 * old behaviour would have silently stopped counting. (Raised by the test-impact session, whose
 * pushback on this was right and whose reasoning is preserved here rather than in a chat log.)
 *
 * **`--selected` moves to stdin (#1098) only when `selectedViaStdin` is true** — the caller's job,
 * via {@link recordAcceptsSelectedViaStdin}, since whether the installed tool understands it is
 * not something this pure function can know. `--failed` stays inline: it names suites that failed
 * in ONE run, which is bounded by how many tests can actually fail, not by how wide the selection
 * is — the shape that overflowed argv (#1098) is the selected list, not the failed one.
 */
export function buildRecordArgs(input: {
  toolPath: string;
  outcomesPath: string;
  passed: boolean;
  selected: string[];
  failedSuites: string[];
  tier: string;
  ran: GateRanScope;
  source: string;
  /** #963 — `record` recomputes the change set itself, so it needs the same base `select` got. */
  baseBranch?: string | null;
  /** Stream `--selected` over stdin as `-` instead of inline (#1098). See doc comment above. */
  selectedViaStdin?: boolean;
}): { args: string[]; stdin?: string } {
  const args = [
    input.toolPath,
    "record",
    "--result",
    input.passed ? "pass" : "fail",
    "--source",
    input.source,
    "--tier",
    input.tier,
    "--ran",
    input.ran,
    "--outcomes",
    input.outcomesPath,
  ];
  if (input.baseBranch) args.push("--base", input.baseBranch);
  if (input.failedSuites.length > 0) args.push("--failed", input.failedSuites.join(","));
  if (input.selectedViaStdin) {
    args.push("--selected", "-");
    return { args, stdin: `${input.selected.join("\n")}\n` };
  }
  // Verbatim, empty included — see the note above: the empty case is the one that must be said
  // out loud, not the one to skip.
  args.push("--selected", input.selected.join(","));
  return { args };
}
