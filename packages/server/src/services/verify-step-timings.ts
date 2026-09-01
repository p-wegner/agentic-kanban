/**
 * The step-timing contract between a project's `verify_script` and the merge gate (#988).
 *
 * #980 made `pnpm typecheck` self-reporting, so the typecheck half of this repo's gate prints
 * its own per-package durations into the gate LOG. What it did NOT do is make the gate's own
 * one-line verdict say where the time went: from the board's side the whole verify script is a
 * single opaque `runSetupScript` call, so `pre-merge gate passed (tier: …)` is silent about
 * whether the 3 minutes were tests, typecheck, or dependency-cruiser. The next person arguing
 * about the gate's FLOOR then has an impression instead of a number — which is exactly the
 * position #980 was filed from.
 *
 * **The contract is one line on stdout per step**, emitted by the step itself:
 *
 * ```
 * [gate:step] name=typecheck seconds=35
 * [gate:step] name=tests seconds=118 scope=impact-selected
 * ```
 *
 * `name` and `seconds` are required; `scope` is optional and is what carries the honesty rule
 * one level down. A step that ran NARROWED must say so — `tests 118s (impact-selected)` is a
 * different claim from `tests 118s`, in the same way `tier: file-scoped` is a different claim
 * from `tier: full`, and the gate message's whole purpose is that a level may only weaken
 * verification VISIBLY.
 *
 * **Every project that emits nothing falls back silently**, which is every project but this one.
 * That is deliberate rather than a gap: the alternative — the board timing the steps itself —
 * would mean parsing an arbitrary shell string into steps, and `pnpm a && pnpm b` is only the
 * easy case (`&&` inside a script, a Makefile target, a gradle task graph are all the same
 * opaque single command). A step knows its own name and its own scope; nothing outside it does.
 *
 * A parse is therefore TOTAL and never throws: unparseable output yields no steps, and the gate
 * message loses a clause rather than a merge losing its verdict.
 */

/** One step's self-report, as parsed off the verify script's stdout. */
export interface VerifyStepTiming {
  name: string;
  seconds: number;
  /** What the step narrowed itself to, when it narrowed at all (e.g. `impact-selected`). */
  scope?: string;
}

/**
 * The marker a step prints. Deliberately noisy and machine-shaped rather than a pretty log line:
 * a verify script's stdout carries thousands of lines of test output, and a prefix that could
 * plausibly appear in a test name or an assertion diff would make the parse a guess.
 */
const STEP_LINE = /^\s*\[gate:step\]\s+(.+?)\s*$/;

/** `key=value` pairs; a value may be quoted to carry spaces (`scope="3 packages"`). */
const FIELD = /(\w+)=(?:"([^"]*)"|(\S+))/g;

/**
 * Most steps a gate message will name. A verify chain is a handful of commands; this repo's is
 * three. The cap is not about memory — it is about what a FABRICATED line can do to the message.
 *
 * The marker is anchored, but "anchored" only rules out a mid-line match: a test whose own
 * output prints a literal `[gate:step] …` at column 0 (this repo has suites that echo the
 * contract, and any project's verify script may print anything) would otherwise append a step to
 * a message that is PERSISTED as the merge verdict. Capping bounds that to a few junk entries
 * instead of an unbounded wall of them, and the dedup below means a repeated injection collapses
 * rather than accumulating.
 */
const MAX_STEPS = 8;

/**
 * Parse every `[gate:step]` line out of a verify run's output.
 *
 * Order is the order the lines appeared, i.e. execution order — NOT sorted by duration the way
 * `scripts/typecheck.mjs` sorts its packages. A gate's steps are a pipeline, and reading them in
 * the order they ran is how a reader tells "typecheck came after tests" from "typecheck was
 * slower than tests"; the durations already say the latter.
 *
 * A malformed line (no `name`, no numeric `seconds`) is DROPPED rather than reported as a
 * zero-second step — a step that claims 0s reads as "free", which is the flattering direction.
 *
 * A repeated `name` is LAST-WINS, keeping the position of its first appearance. Two sources
 * produce duplicates and they want the same answer: an install retry re-runs the whole script
 * into one stdout buffer (the second run is the one whose cost the verdict describes), and a
 * suite that echoes the contract in its own output would otherwise append a phantom second
 * `tests`. Order is held at first appearance because that is the EXECUTION order the clause
 * claims to show — a re-run must not reorder the pipeline.
 */
export function parseVerifyStepTimings(output: string | undefined | null): VerifyStepTiming[] {
  if (!output) return [];
  const byName = new Map<string, VerifyStepTiming>();
  for (const rawLine of output.split(/\r?\n/)) {
    const marker = STEP_LINE.exec(rawLine);
    if (!marker) continue;
    const fields = new Map<string, string>();
    // `matchAll` on a fresh regex each time: FIELD carries /g, so a shared lastIndex across
    // lines would silently skip fields on every second line.
    for (const [, key, quoted, bare] of marker[1].matchAll(new RegExp(FIELD.source, "g"))) {
      fields.set(key, quoted ?? bare ?? "");
    }
    const name = fields.get("name");
    const seconds = Number(fields.get("seconds"));
    if (!name || !Number.isFinite(seconds) || seconds < 0) continue;
    // Past the cap, only an already-seen step may be UPDATED — a new name is dropped. So a
    // legitimate chain's install-retry re-run still overwrites its own steps however long the
    // output is, while injected junk cannot keep growing the message.
    if (!byName.has(name) && byName.size >= MAX_STEPS) continue;
    const scope = fields.get("scope");
    byName.set(name, { name, seconds: Math.round(seconds), ...(scope ? { scope } : {}) });
  }
  // Map preserves insertion order, and re-`set`ting an existing key does not move it — so this
  // is first-appearance order with last-seen values, which is exactly the rule above.
  return [...byName.values()];
}

/**
 * The gate message's step clause, or null when the script reported nothing.
 *
 * Null rather than an empty string so the caller omits the clause entirely — a bare `steps: `
 * on every non-self project's gate message would be noise that trains the reader to skip the
 * field, the same argument `queueWaitMs` makes for staying silent at 0.
 *
 * The TOTAL is stated alongside the parts, and is the sum of what was REPORTED, not the gate's
 * wall clock. Those two differ by whatever the script did between its steps (a shared install,
 * pnpm's own startup, the shell), and a total that silently absorbed the difference would make
 * the parts look like they account for the whole run when they do not. `+ N unaccounted` is what
 * the `PassReport` convention already does with the same problem, and it is the honest shape:
 * a reader can see that the named steps do not add up to the run.
 */
export function buildStepTimingNote(
  steps: VerifyStepTiming[],
  totalRunMs?: number,
  /**
   * True when a targeted flake retry produced the verdict (#894). The steps then belong to the
   * FULL run that failed — the retry reports none of its own — so the clause says which run it is
   * describing rather than letting the numbers read as the cost of the run that passed.
   */
  fromPreRetryRun = false,
): string | null {
  if (steps.length === 0) return null;
  const parts = steps.map((s) => `${s.name} ${s.seconds}s${s.scope ? ` (${s.scope})` : ""}`);
  const reported = steps.reduce((sum, s) => sum + s.seconds, 0);
  // Only when the run was actually timed AND the gap is worth a word. Sub-second rounding noise
  // is not a finding, and a "+0s unaccounted" on every gate is the same trained-to-skip noise.
  const unaccounted =
    totalRunMs !== undefined && Math.round(totalRunMs / 1000) - reported >= 1
      ? ` + ${Math.round(totalRunMs / 1000) - reported}s unaccounted`
      : "";
  const provenance = fromPreRetryRun ? ", from the run before the retry" : "";
  return `steps: ${parts.join(", ")}${unaccounted}${provenance}`;
}
