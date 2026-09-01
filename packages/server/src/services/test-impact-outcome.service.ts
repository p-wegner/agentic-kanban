/**
 * Record every pre-merge gate run into the test-impact outcome ledger (#954).
 *
 * WHY THIS EXISTS. The test-impact scorer's weights are all reasoned defaults, and nothing has
 * ever been recorded against them, so **the miss rate is unknown** — a miss being a failure the
 * gate found in a suite the selection would not have picked. Until that number exists, narrowing
 * the gate on the strength of the selection is a guess and `build --tune` has nothing to fit
 * against. The gate is the one place in the system that already knows BOTH halves of an
 * observation: what it ran, and what failed. This turns that into a ledger row.
 *
 * WHAT MAKES A ROW WORTH ANYTHING. Only a run whose scope is WIDER than the selection can witness
 * a miss; a run narrowed to the selection cannot, even in principle, find what the selection
 * omitted. So each row carries `ran` (what the gate actually executed) alongside `tier` (what the
 * selection would have been), and `impact.mjs stats` computes the miss rate over the witnesses
 * only. A full-suite gate run is therefore the ideal observation, and this records on EVERY gate
 * run — pass and fail, full and scoped — because a scoped row still measures selection SIZE and
 * still feeds the failure-history signal, it just does not vote on the miss rate.
 *
 * WHERE THE LEDGER LIVES (decided on #954). `.test-impact/outcomes.jsonl`, gitignored and local —
 * per machine, lost on a fresh clone, not shared with CI. On a single-machine board that is where
 * the gate runs anyway. It must be IGNORED rather than merely untracked: an untracked-but-not-
 * ignored file in the main checkout is exactly the shape that blocks every subsequent merge via
 * `getDirtyMainFiles`.
 *
 * The subtlety is WHICH repo's file. The gate runs in a WORKTREE, and the selection must be
 * computed there (that is where the branch's diff and HEAD are). But a ledger written into a
 * worktree dies with the worktree, so it could never accumulate the ~50 runs a miss rate needs.
 * So: `select` runs in the worktree, and both commands write to the MAIN checkout's ledger via
 * `impact.mjs --outcomes <abs path>`. One ledger per project, fed by every worktree's gate.
 *
 * BEST-EFFORT BY CONSTRUCTION. Nothing here may change a gate verdict. Every failure path — no
 * skill materialized, no inventory built, a non-zero exit, a spawn error, a timeout — resolves to
 * a `skipped` result with a reason and is never rethrown. A measurement apparatus that can withhold
 * a merge is worse than no measurement.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { GateImpactSelection, GateTierInfo } from "./pre-merge-gate-tier.js";

/**
 * Path of `impact.mjs` relative to a repo root, as the board materializes the skill into a
 * worktree (`.claude/skills/<name>/`) and as the plugin junctions it into a leading repo.
 */
export const IMPACT_TOOL_RELATIVE_PATH = ".claude/skills/test-impact/tools/impact.mjs";

/** The ledger, relative to the repo root that owns it. Matches `impact.mjs`'s own default. */
export const OUTCOMES_RELATIVE_PATH = ".test-impact/outcomes.jsonl";

/**
 * Wall-clock ceiling for each of the two spawns.
 *
 * `select` reads a committed inventory and a bounded slice of git history; on this repo it is a
 * sub-second query. The budget is generous rather than tight because the only thing a timeout can
 * buy is a lost measurement — but it must exist, since this runs inside the merge path and an
 * `impact.mjs` that hangs must not hold a gate open.
 */
export const IMPACT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * What the gate ACTUALLY ran, in the vocabulary the ledger's miss-rate computation understands.
 *
 * `full` is the only value that makes a row a witness — it is the claim "every suite ran, so any
 * failure here is comparable against the selection". The narrower names are deliberately NOT
 * collapsed into one "scoped": which narrowing applied is what a later reader needs in order to
 * judge how much the row proves.
 */
export type GateRanScope =
  | "full"
  | "package-scoped"
  | "file-scoped"
  | "guards-only"
  | "impact-scoped"
  /**
   * #967 — the impact selection UNIONED with `vitest related`'s picks for the same diff. Its own
   * name, not folded into `impact-scoped`: the corpus is judging the selector the setting actually
   * ships, and "impact alone" and "impact ∪ related" are different selectors with different miss
   * profiles. Collapsing them would attribute a union run's catches to the ranking.
   *
   * Still a NON-witness (it is not in the tool's `WITNESS_SCOPES`), which is correct — a union is
   * wider than the ranking but still narrower than the full suite, so it cannot see what BOTH
   * selectors omitted.
   */
  | "impact+related";

/**
 * Which scope the verify run actually had.
 *
 * Read off the SAME `GateTierInfo` the gate's own pass message is built from, so the ledger and
 * the operator-facing message can never disagree about what ran. Order matters: guards-only is
 * the narrowest and wins, then file-scoping, then package-scoping. A tier that narrowed nothing
 * is `full` — which is exactly the `buildGateTierMessage` rule that a strategy claiming to scope
 * but performing no narrowing must report "full", never a narrower name.
 *
 * **#962 — the IMPACT selector outranks every one of those, including `full`.** A run under
 * `KANBAN_TEST_SELECTOR=impact` executes the suites the impact heuristic ranked, plus the
 * always-run guards; the package/file scoping the rest of this function reads is layered on top
 * of that set, not instead of it. So a gate with `strategy: full` (no package scope, no file
 * scope) and the impact selector would fall straight through to `full` — a claim that every suite
 * was observed, on the one kind of run where a whole ranked-out tail was NOT. `impact.mjs`'s
 * `isWitness` counts only `full`/`all`, so such a row would enter the miss-rate DENOMINATOR while
 * being structurally unable to witness a miss, driving the rate toward a confident zero exactly
 * when the selector is in charge. `impact-scoped` is not in `WITNESS_SCOPES`, so those rows are
 * reported separately as non-witnesses — which is the honest reading.
 *
 * `guards-only` still wins over it, and that is not an inconsistency: `test-mine.mjs`'s
 * `KANBAN_TEST_GUARDS_ONLY` branch runs the guards and EXITS before the selector is ever
 * consulted, so a docs-only diff genuinely ran no impact selection at all.
 *
 * Absent selector reads as `related`, so every project that has not opted in records exactly as
 * it did before.
 */
export function gateRanScope(tierInfo: GateTierInfo | null | undefined): GateRanScope {
  if (!tierInfo) return "full";
  if (tierInfo.guardsOnly) return "guards-only";
  // #967 — a file scope emitted ALONGSIDE the impact selector is the union, not a rival scope: the
  // runner derives `vitest related`'s suites from it and merges them into the selection. So the row
  // names the combined selector, which is what the setting ships and therefore what the corpus must
  // judge. (Before #967 the gate dropped the file scope under this selector, so this pair could not
  // occur — an old row reading `impact-scoped` still means what it always did.)
  if (tierInfo.selector === "impact") return tierInfo.fileScoped ? "impact+related" : "impact-scoped";
  if (tierInfo.fileScoped) return "file-scoped";
  if (tierInfo.packageScoped) return "package-scoped";
  return "full";
}

export interface RecordGateOutcomeInput {
  /** The worktree the gate ran in — where the diff, HEAD and the materialized skill live. */
  workingDir: string | null;
  /**
   * The workspace's base branch, passed through to `select` (POSITIONALLY — it reads
   * `positional[0]`, not a flag) and to `record --base` (#963).
   *
   * WITHOUT IT THE LEDGER MEASURES NOTHING. `impact.mjs`'s `changedFiles(base)` only consults
   * `base...HEAD` when a base is given; its two remaining sources are `git diff HEAD` (staged +
   * unstaged) and untracked files. At GATE time the branch is fully committed and the tree is
   * clean, so both are empty and the change set is `[]` — the selection then degrades to the
   * constant `--always-run` guard set, identical for every branch. Measured: three gate rows for
   * three unrelated diffs all recorded `changed 0, selected 158, missed 0`. A `missed: 0` computed
   * against a selection that never saw the diff is trivially true, so the corpus would report a
   * confident 0% miss rate for a selector that was never consulted — the same failure direction as
   * a mislabeled `ran` scope.
   *
   * Null when the workspace has none (a direct workspace, or an unresolvable base): the selection
   * is then still recorded, but the row is FLAGGED rather than silently diluting the corpus — see
   * `emptyChangeSetReason`.
   */
  baseBranch?: string | null;
  /**
   * The project's MAIN checkout. The ledger lives here so it survives worktree deletion and
   * accumulates across every branch. When null (unknown repo path) the worktree's own ledger is
   * used, which still records but will not accumulate — reported in the reason so it is visible.
   */
  repoPath: string | null;
  /** Did the gate's verify stage pass? */
  passed: boolean;
  /** The suites that failed, as `failedSuitesForOutcome`/`parseFailedSuites` name them. */
  failedSuites: string[];
  /** The tier info the gate built — the single source of truth for what actually ran. */
  tierInfo: GateTierInfo | null;
  /** Tags the row's origin. The board's gate is `ci`: it is the automated gate, not a dev loop. */
  source?: string;
  /** Injected for tests. */
  runCommand?: RunImpactCommand;
  log?: (message: string) => void;
}

export interface RecordGateOutcomeResult {
  recorded: boolean;
  /** Why nothing was recorded, when `recorded` is false. Always set in that case. */
  reason?: string;
  /** The selection tier `select` reported (`impact` | `package` | `all`), when it ran. */
  tier?: string;
  /** How many test files the selection would have picked. */
  selectedCount?: number;
  /** How many files `select` saw as changed — 0 means the row is the always-run baseline (#963). */
  changedCount?: number;
  /** Set when the row was recorded but flagged as not a valid observation of the selection (#963). */
  suspectReason?: string;
  /** What the gate ran, as recorded. */
  ran?: GateRanScope;
}

/**
 * Just the field a ledger row needs off a failed suite.
 *
 * Structural rather than an import of `FailedSuite`, because the ledger deliberately uses only
 * `file` — the un-prefixed path — and naming that in the type is what stops a later reader from
 * "helpfully" folding `packageLabel` in, which would break the string match against `select`'s
 * repo-relative test names and turn every failure into a phantom miss.
 */
export interface FailedSuiteLike {
  /** Suite path as vitest printed it: relative to the PACKAGE dir, since that is its cwd. */
  file: string;
  /**
   * The package whose vitest run reported the failure (`server`, `client`, `shared`,
   * `mcp-server`), or null when the output gave no package context.
   *
   * REQUIRED to build a comparable name — see `repoRelativeSuitePath`. This is the field the
   * whole miss computation turns on, not an incidental one.
   */
  packageLabel?: string | null;
}

/**
 * Turn a `FailedSuite` into the SAME vocabulary `select` names tests in: a repo-relative path.
 *
 * This is the join that makes the ledger mean anything, and getting it wrong is silent. vitest
 * runs with the PACKAGE as its cwd, so it prints `src/__tests__/x.test.ts`; the inventory keys —
 * and therefore every entry in `select --json`'s `selected` — are repo-relative
 * (`packages/server/src/__tests__/x.test.ts`). `impact.mjs record` computes
 * `missed = failed.filter((f) => !selected.includes(f))`, a pure STRING comparison, so handing it
 * the package-relative form makes a failure in a suite that WAS selected read as a miss. Every
 * failing run would then report a 100% miss rate — the exact number this ledger exists to
 * measure, wrong in the direction that makes the selection look worthless.
 *
 * A suite with no `packageLabel` cannot be placed: the same relative path exists under several
 * packages, so guessing would name a real-but-different file. Such a suite is DROPPED rather than
 * recorded unattributed — a name that cannot match is indistinguishable from a genuine miss, and
 * a phantom miss is worse than a missing observation.
 */
export function repoRelativeSuitePath(suite: FailedSuiteLike): string | null {
  const file = suite.file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!suite.packageLabel) return null;
  // Already repo-relative (a root-level suite, or a runner that printed the full path).
  if (file.startsWith("packages/") || file.startsWith(".claude/")) return file;
  return `packages/${suite.packageLabel}/${file}`;
}

export type RunImpactCommand = (input: {
  cwd: string;
  args: string[];
  timeoutMs: number;
  /**
   * Written to the child's stdin, for the argv a command line cannot hold (#967).
   *
   * The union list is the only user: 536 related suites — a real fan-out, measured on a diff
   * touching `packages/server/src/db/index.ts` — comma-join to 33,735 chars, past Windows'
   * 32,767-char CreateProcess limit. Inline, the spawn fails ENAMETOOLONG and the caller's
   * fail-open path silently drops the selection AND the budget on the widest diffs. `select`
   * accepts `--union -` and reads the list from stdin, which has no such limit.
   */
  stdin?: string;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultRunCommand: RunImpactCommand = ({ cwd, args, timeoutMs, stdin }) =>
  new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // Never reject: a spawn failure is a lost measurement, not a gate outcome. The exit code
        // carries the distinction the caller needs, and `error.code` is a number only when the
        // process actually ran and exited non-zero.
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolvePromise({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    // Always closed, even with nothing to write: `select` only READS stdin for `--union -`, but a
    // child whose stdin is left open is a child that may never exit, and this runs inside the
    // merge path. An EPIPE here means the child already exited — a lost measurement the callback
    // above already reports, never a throw out of this promise.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin ?? "");
  });

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

export function parseSelection(stdout: string): ParsedSelection | null {
  let payload: SelectPayload;
  try {
    payload = JSON.parse(stdout) as SelectPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.selected)) return null;
  const selected = payload.selected
    .map((entry) => (entry && typeof entry === "object" ? (entry as { test?: unknown }).test : entry))
    .filter((test): test is string => typeof test === "string" && test.length > 0);
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
  return {
    tier: typeof payload.tier === "string" ? payload.tier : "unknown",
    selected,
    changed,
    belowFloorCount: Array.isArray(payload.belowFloor) ? payload.belowFloor.length : 0,
    budgetDroppedCount: Array.isArray(payload.dropped) ? payload.dropped.length : 0,
    ...(typeof payload.estMs === "number" && Number.isFinite(payload.estMs) ? { estMs: payload.estMs } : {}),
    stale: payload.stale === true,
    ...(typeof external === "number" && Number.isFinite(external) ? { externalCount: external } : {}),
  };
}

/**
 * The score floor the gate's verify run will actually apply (#956).
 *
 * Mirrors `scripts/test-mine.mjs`'s own parse of `KANBAN_TEST_MIN_SCORE` exactly — same default
 * (`1.0`), same numeric guard, same fall back to the default on an unparseable value — because the
 * message's selection call and the run's selection call must ask `impact.mjs` the same question.
 * A floor here that is looser than the runner's over-reports what ran and under-reports the tail;
 * a tighter one invents drops that never happened.
 */
export function resolveGateMinScore(env: Record<string, string | undefined>): string {
  const raw = (env.KANBAN_TEST_MIN_SCORE || "1.0").trim();
  return /^\d+(\.\d+)?$/.test(raw) ? raw : "1.0";
}

/**
 * Run `select --json` in a worktree and parse it, or return null (#956).
 *
 * Extracted from `recordGateOutcome` so the `impact` gate TIER can name what the selection kept
 * and dropped in its pass message using the same call the ledger already makes — one selection,
 * two consumers, so the operator-facing message and the recorded row can never disagree about
 * what the selection was.
 *
 * The base goes FIRST and POSITIONALLY. `cmdSelect` reads `positional[0]` and never consults a
 * `--base` flag; passing one there is silently ignored and `changedFiles(undefined)` falls back to
 * uncommitted work, which on the clean committed tree a gate runs against is EMPTY. That is #963's
 * defect, and reintroducing it here would make every selection this tier reports the constant
 * always-run baseline wearing the selection's name.
 *
 * **The SCORE FLOOR must match the one the run will actually use.** `impact.mjs` computes
 * `belowFloor` only when `--min-score > 0` (it defaults to `0`), and it applies the floor to
 * `selected` too. So an unfloored call reports `dropped 0 below the score floor` for EVERY run —
 * the one number this tier's honesty rests on, structurally pinned at zero — while the real run
 * (`scripts/test-mine.mjs`, floor `1.0` by default) dropped a long tail, and reports a `selected`
 * set wider than what ran. Same failure direction as recording an impact-narrowed run as `full`.
 * `resolveGateMinScore` mirrors `test-mine.mjs`'s own parse so the two cannot drift.
 *
 * Total by construction, like everything else in this module: any failure resolves to null.
 */
export async function resolveGateSelection(input: {
  workingDir: string | null;
  baseBranch?: string | null;
  minScore?: string;
  /**
   * The project's test-impact budget, as the operator spelled it (#966).
   *
   * **The SAME rule as the score floor, for the same reason.** This call exists to describe the
   * selection the run will actually make; a budget applied by the run but not by this call would
   * report a `selected` set WIDER than what ran and `dropped 0 over budget` for every gate — the
   * number whose whole purpose is to size what the clock cut, structurally pinned at zero.
   */
  budget?: string | null;
  /**
   * The OTHER selector's picks, repo-relative, when the run is unioned (#967).
   *
   * Same rule as the score floor and the budget: this call exists to DESCRIBE the selection the run
   * will make, so a union applied by the run but not by this call reports a `selected` set narrower
   * than what runs and `signalCounts.external` absent — i.e. a message that says "impact chose these
   * N" for a run where a second selector also chose some.
   *
   * The board cannot derive this list itself: `vitest related`'s picks come from vitest's own module
   * graph, which only the runner (in the worktree, per package) can walk. So the CALLER supplies it
   * when it has it, and when it does not the caller sets `unionUnmeasured` on the resulting
   * `GateImpactSelection` so the message says the union's size is unknown rather than implying none.
   */
  union?: readonly string[];
  runCommand?: RunImpactCommand;
}): Promise<ParsedSelection | null> {
  try {
    const { workingDir } = input;
    if (!workingDir) return null;
    const toolPath = join(workingDir, IMPACT_TOOL_RELATIVE_PATH);
    if (!existsSync(toolPath)) return null;
    const base = input.baseBranch?.trim() || null;
    const minScore = input.minScore ?? resolveGateMinScore(process.env);
    const budget = input.budget?.trim() || null;
    const union = (input.union ?? []).filter((entry) => entry.trim().length > 0);
    const run = input.runCommand ?? defaultRunCommand;
    const result = await run({
      cwd: workingDir,
      args: [
        toolPath,
        "select",
        ...(base ? [base] : []),
        "--json",
        "--always-run",
        "--min-score",
        minScore,
        ...(budget ? ["--budget", budget] : []),
        // #967 — externals enter AFTER the floor and BEFORE the budget cut, which is why this is a
        // tool flag and not a merge performed on the result here: unioning after the cut would run
        // more seconds than the budget promised.
        //
        // Over STDIN, not inline: a real union runs to tens of thousands of characters (see
        // `RunImpactCommand.stdin`), which no command line on Windows can carry.
        ...(union.length > 0 ? ["--union", "-"] : []),
      ],
      timeoutMs: IMPACT_COMMAND_TIMEOUT_MS,
      ...(union.length > 0 ? { stdin: `${union.join("\n")}\n` } : {}),
    });
    if (result.exitCode !== 0) return null;
    return parseSelection(result.stdout);
  } catch {
    return null;
  }
}

/**
 * The `GateImpactSelection` the gate message needs, or null (#956).
 *
 * A thin adapter over `resolveGateSelection` so the CALLER — `runPreMergeGate`, which sits on the
 * god-module gate's branch ceiling — spends no branch on the "did it resolve" question. Returns
 * `undefined` when the run is not impact-selected at all (nothing to describe), and `null` when it
 * is but the selection could not be resolved (which `buildImpactSelectionNote` renders as an
 * explicit UNKNOWN). Those two are deliberately different values, not both falsy-and-equivalent.
 */
export async function resolveGateImpactSelection(input: {
  applies: boolean;
  workingDir: string | null;
  baseBranch?: string | null;
  /** The floor the verify run will use; defaults to `resolveGateMinScore(process.env)`. */
  minScore?: string;
  /** The budget the verify run will use (#966), as the operator spelled it; null when off. */
  budget?: string | null;
  /**
   * Will the verify run UNION the edit-based scope into the selection (#967)? I.e. did the gate
   * emit `KANBAN_TEST_FILES` alongside `KANBAN_TEST_SELECTOR=impact`?
   *
   * The board cannot compute the union's CONTENTS — `vitest related`'s picks come out of vitest's
   * own per-package module graph, which only `scripts/test-mine.mjs` walks, in the worktree, at run
   * time. It can and does know that a union WILL happen, and that is the difference between a
   * message that under-reports and one that says what it does not know. So when this is true and no
   * `union` list was supplied, the selection is marked `unionUnmeasured` and the message says the
   * related half's size is unknown — never silently reporting the impact half as the whole.
   */
  unioned?: boolean;
  /** The union's contents, when a caller can supply them — see `resolveGateSelection`. */
  union?: readonly string[];
  runCommand?: RunImpactCommand;
}): Promise<GateImpactSelection | null | undefined> {
  if (!input.applies) return undefined;
  const selection = await resolveGateSelection(input);
  if (!selection) return null;
  const budget = input.budget?.trim() || null;
  const unionSupplied = (input.union ?? []).some((entry) => entry.trim().length > 0);
  return {
    selectedCount: selection.selected.length,
    belowFloorCount: selection.belowFloorCount,
    stale: selection.stale,
    selectionTier: selection.tier,
    changedCount: selection.changed.length,
    // Only when a budget actually applied: the message omits the whole budget clause otherwise,
    // rather than printing a reassuring "dropped 0 over budget" for a run that had no clock at all.
    ...(budget
      ? { budget, budgetDroppedCount: selection.budgetDroppedCount, ...(selection.estMs !== undefined ? { estMs: selection.estMs } : {}) }
      : {}),
    // #967 — three states, deliberately distinct: no union at all (both undefined), a union whose
    // size the tool reported (`externalCount`), and a union that will happen but whose size this
    // call could not measure (`unionUnmeasured`). Collapsing the third into the first is the
    // failure this flag exists to prevent.
    ...(selection.externalCount !== undefined ? { externalCount: selection.externalCount } : {}),
    ...(input.unioned && !unionSupplied ? { unionUnmeasured: true } : {}),
  };
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

/**
 * Build the argv for `impact.mjs record`.
 *
 * Pure and exported so the flag wiring — the part that silently produces a useless row when it is
 * wrong — is a table test rather than something only an end-to-end gate run would catch.
 *
 * `--selected` is omitted when the selection is empty, because `record` treats an empty selection
 * as "no selection recorded" and computes no misses from it. Passing `--selected ""` would look
 * like a selection of nothing and make every failure read as a miss.
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
}): string[] {
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
  if (input.selected.length > 0) args.push("--selected", input.selected.join(","));
  if (input.failedSuites.length > 0) args.push("--failed", input.failedSuites.join(","));
  return args;
}

/**
 * Record one gate run. Resolves to a `skipped` result rather than throwing, always.
 */
export async function recordGateOutcome(input: RecordGateOutcomeInput): Promise<RecordGateOutcomeResult> {
  const log = input.log ?? ((message: string) => console.warn(`[test-impact] ${message}`));
  const run = input.runCommand ?? defaultRunCommand;
  const source = input.source ?? "ci";
  try {
    const workingDir = input.workingDir;
    if (!workingDir) return { recorded: false, reason: "no worktree — nothing to compute a selection from" };
    const toolPath = join(workingDir, IMPACT_TOOL_RELATIVE_PATH);
    if (!existsSync(toolPath)) {
      // The overwhelmingly common case for any project that does not use this skill. Not a
      // warning-worthy event, so the caller logs nothing for it.
      return { recorded: false, reason: `no test-impact tool at ${IMPACT_TOOL_RELATIVE_PATH}` };
    }
    // The main checkout owns the ledger; fall back to the worktree only when the repo path is
    // unknown, and say so — a worktree-local ledger records but never accumulates.
    const ledgerRoot = input.repoPath ?? workingDir;
    const outcomesPath = resolve(ledgerRoot, OUTCOMES_RELATIVE_PATH);

    // #963 — the base is what makes this the branch's REAL selection rather than the constant
    // always-run set. See `RecordGateOutcomeInput.baseBranch` for the measurement it was silently
    // destroying. Omitted (not passed empty) when there is no base, so the tool keeps its own
    // uncommitted-work behaviour instead of being handed a ref it cannot resolve.
    //
    // THE TWO SUBCOMMANDS SPELL IT DIFFERENTLY, AND THAT IS NOT COSMETIC. `cmdRecord` reads
    // `flag("base")`, so it takes `--base <ref>`. `cmdSelect` reads `positional[0]` and never
    // consults a `--base` flag at all — passing one there is silently ignored, `changedFiles(undefined)`
    // falls back to the uncommitted-work sources, and the change set comes back EMPTY on the clean
    // committed tree a gate runs against. That is exactly the #963 defect this call exists to fix,
    // so the base goes FIRST, positionally. Verified against `impact.mjs` on a branch with commits:
    // `select --json --always-run --base master` → `changed: 0`, `select master --json --always-run`
    // → `changed: 9`.
    const baseBranch = input.baseBranch?.trim() || null;
    const selection = await run({
      cwd: workingDir,
      args: [toolPath, "select", ...(baseBranch ? [baseBranch] : []), "--json", "--always-run"],
      timeoutMs: IMPACT_COMMAND_TIMEOUT_MS,
    });
    if (selection.exitCode !== 0) {
      // `select` exits 2 with no inventory and 3 with an empty one — both mean "this repo has no
      // usable map yet", which is a missing prerequisite, not a gate problem.
      return {
        recorded: false,
        reason: `select exited ${selection.exitCode}: ${(selection.stderr || selection.stdout).trim().split("\n").slice(-1)[0] ?? ""}`,
      };
    }
    const parsed = parseSelection(selection.stdout);
    if (!parsed) return { recorded: false, reason: "could not parse `select --json` output" };

    const ran = gateRanScope(input.tierInfo);
    // #963 — a row whose change set is empty is not an observation of the selection; it is the
    // always-run baseline, and its `missed: 0` is true for free. Tag the SOURCE so `stats`'
    // `bySource` breakdown separates it from real rows, instead of letting it read as an ordinary
    // gate observation. The source vocabulary belongs to the producer (see `cmdRecord`), so this
    // needs no change on the tool side.
    const noChangeReason = emptyChangeSetReason({ changed: parsed.changed, baseBranch });
    // #967 — the OTHER way a row can fail to be an observation of the selector it names: a union
    // run whose `selected` list covers only the impact half. See `unmeasuredUnionReason` for the
    // miss it would otherwise manufacture. Tagged the same way, with its own suffix so `bySource`
    // can tell the two apart; the empty change set is named first because it invalidates the row
    // more completely (there is no selection to judge at all).
    const unionReason = unmeasuredUnionReason({ ran });
    const suspectReason = noChangeReason ?? unionReason;
    const sourceSuffix = `${noChangeReason ? "-nochange" : ""}${unionReason ? "-partialselection" : ""}`;
    const record = await run({
      cwd: workingDir,
      args: buildRecordArgs({
        toolPath,
        outcomesPath,
        passed: input.passed,
        selected: parsed.selected,
        failedSuites: input.failedSuites,
        tier: parsed.tier,
        ran,
        source: `${source}${sourceSuffix}`,
        baseBranch,
      }),
      timeoutMs: IMPACT_COMMAND_TIMEOUT_MS,
    });
    if (record.exitCode !== 0) {
      return { recorded: false, reason: `record exited ${record.exitCode}: ${(record.stderr || record.stdout).trim()}` };
    }
    if (!input.repoPath) {
      log(`recorded a gate outcome into the WORKTREE ledger at ${outcomesPath} — the project's repo path is unknown, so this row will be lost with the worktree`);
    }
    if (noChangeReason) {
      log(
        `recorded a gate outcome with an EMPTY change set (${noChangeReason}) — the selection it names is the ` +
          `always-run baseline, not this branch's, so the row is tagged source=${source}${sourceSuffix} and must not be ` +
          `counted toward the miss rate`,
      );
    }
    if (unionReason) {
      log(
        `recorded a UNION gate outcome whose selection covers only the impact half (${unionReason}) — the row is ` +
          `tagged source=${source}${sourceSuffix} and its \`missed\` set must not be counted toward the miss rate of ` +
          `the combined selector`,
      );
    }
    return {
      recorded: true,
      tier: parsed.tier,
      selectedCount: parsed.selected.length,
      changedCount: parsed.changed.length,
      ran,
      ...(suspectReason ? { suspectReason } : {}),
    };
  } catch (err) {
    // The whole point of this module is that it cannot affect a merge. Anything unanticipated
    // lands here.
    return { recorded: false, reason: `unexpected error: ${errorMessage(err)}` };
  }
}

/**
 * The pre-merge gate's adapter onto `recordGateOutcome`: turn one resolved verify outcome into a
 * ledger row, and report what happened.
 *
 * Lives here rather than in `pre-merge-gate.service.ts` because that file is ON the god-module
 * gate's 1000-line hard ceiling, and this is a self-contained side effect that the gate only
 * needs to call — the same reason `verify-retry-strategies.ts` and `pre-merge-gate-tier.ts` were
 * extracted out of it.
 *
 * ONE KIND OF RUN IS DELIBERATELY NOT RECORDED, because a row for it would be a lie: a **timeout
 * or no-progress kill** is inconclusive by contract (#192/#903) — the run was cut off, so it is
 * neither a pass nor evidence that the code failed, and it never observed the suites after the
 * cut. Recording it as `fail` would attribute a machine event to the diff; as `pass`, worse.
 *
 * A failure that named NO suite (a compile error, a crashed runner) DOES record — as a `fail`
 * with an empty failed set, which is the honest shape: something broke, no suite can be blamed,
 * and it contributes no miss either way.
 *
 * Suite names are REPO-RELATIVE, because that is the vocabulary `select` names tests in and
 * `record`'s miss computation is a plain string comparison against it. vitest prints them
 * package-relative (its cwd is the package), so `repoRelativeSuitePath` performs the join; a
 * suite that cannot be attributed to a package is dropped rather than recorded under a name that
 * could never match. See that function for why the alternative silently reports a 100% miss rate.
 */
export async function recordVerifyGateOutcome(args: {
  workspaceId: string;
  workingDir: string;
  repoPath: string | null;
  /** The workspace's base branch — see `RecordGateOutcomeInput.baseBranch` (#963). */
  baseBranch?: string | null;
  /**
   * Structurally the `VerifyOutcome` the gate resolved. Only `failure === null` (the verdict),
   * `failure.timedOut` (inconclusive) and `failedSuites` are read; `message` is accepted so a real
   * `VerifyFailure` satisfies this without a cast.
   */
  outcome: { failure: { timedOut?: boolean; message?: string } | null; failedSuites: FailedSuiteLike[] };
  tierInfo: GateTierInfo | null;
  runCommand?: RunImpactCommand;
  log?: (message: string) => void;
}): Promise<RecordGateOutcomeResult> {
  const { workspaceId, outcome } = args;
  const log = args.log ?? ((message: string) => console.warn(`[test-impact] ${message}`));
  if (outcome.failure?.timedOut) {
    return { recorded: false, reason: "the run timed out or was killed — inconclusive, so it is not an observation" };
  }
  const passed = outcome.failure === null;
  const result = await recordGateOutcome({
    workingDir: args.workingDir,
    repoPath: args.repoPath,
    baseBranch: args.baseBranch,
    passed,
    failedSuites: outcome.failedSuites
      .map(repoRelativeSuitePath)
      .filter((file): file is string => file !== null),
    tierInfo: args.tierInfo,
    source: "ci",
    runCommand: args.runCommand,
    log,
  });
  if (result.recorded) {
    console.log(
      `[test-impact] recorded gate outcome for workspace ${workspaceId}: ${passed ? "pass" : "fail"}, ` +
        `ran ${result.ran}, ${result.changedCount} changed file(s), selection tier ${result.tier} would have ` +
        `picked ${result.selectedCount} test file(s)`,
    );
  } else if (result.reason && !result.reason.startsWith("no test-impact tool")) {
    // A project without the skill is the overwhelmingly common case and says nothing. Anything
    // else means the measurement was ATTEMPTED and lost, which is worth exactly one line.
    log(`no outcome recorded for workspace ${workspaceId}: ${result.reason}`);
  }
  return result;
}

/** Forward-slash, no leading `./` — the form `select` names test files in. */
function normalizedSuitePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The OTHER caller of the ledger (#982) — the periodic base-branch sweep.
 *
 * Until this existed, `recordVerifyGateOutcome` had exactly ONE caller (the pre-merge gate), so
 * the corpus only ever contained rows the gate itself produced. That is circular: the gate can
 * only observe suites it chose to run, and a miss is by definition a suite it did NOT run. The
 * sweep is the one thing here that runs the FULL suite over the base, so it is the only place a
 * genuine miss can be seen at all — and it was recording nothing.
 *
 * `baseSha` MUST be the sha of the LAST GREEN sweep, not the tip being verified. `select` derives
 * its change set from `base...HEAD`, so a base equal to HEAD yields an EMPTY change set, and
 * `emptyChangeSetReason` then tags the row `-nochange` and excludes it from the miss rate — the
 * row would be filed into the corpus it exists to populate and thrown straight back out. Against
 * the last green sha the change set is "everything that merged since we last knew the base was
 * healthy", which makes the row answer the question that matters: of the suites that failed
 * tonight, how many would the selection have picked for that diff?
 *
 * With no prior green row there is no meaningful base, and the caller should record NOTHING
 * rather than dilute the corpus.
 *
 * `tierInfo` is deliberately `null`: the sweep runs the project's effective verify unscoped, so
 * `gateRanScope(null)` is `full`, which is the truth.
 */
export async function recordBaseSweepOutcome(args: {
  projectId: string;
  /** The project's MAIN checkout — the sweep's temp clone is deleted before this is called. */
  repoPath: string;
  /** Sha of the last GREEN sweep for this project. See above: never the tip just verified. */
  baseSha: string;
  passed: boolean;
  /**
   * Suite paths exactly as `failedSuitesForOutcome` produced them. Unlike the gate's
   * `FailedSuiteLike`, the sweep has no per-package attribution to hand over — see the
   * refusal below for what that costs and why it is a refusal rather than a partial row.
   */
  failedSuites: string[];
  runCommand?: RunImpactCommand;
  log?: (message: string) => void;
}): Promise<RecordGateOutcomeResult> {
  const log = args.log ?? ((message: string) => console.warn(`[test-impact] ${message}`));
  // The ledger compares suite names to `select`'s repo-relative ones as PLAIN STRINGS, and the
  // sweep parses a combined multi-package log with no package attribution — so a suite vitest
  // printed package-relative (`src/__tests__/x.test.ts`) cannot be placed here the way
  // `repoRelativeSuitePath` places a gate's.
  //
  // Dropping the unplaceable ones would understate the failed set, and an UNDERSTATED failed set
  // understates the MISS COUNT — biasing the corpus in the one direction that makes the selection
  // look better than it is, which is the failure this ledger exists to prevent. So a red sweep
  // that cannot name every failure repo-relatively records NOTHING. A green one is unaffected:
  // an empty failed set is then the truth, not a truncation.
  const unplaceable = args.failedSuites.filter((file) => !normalizedSuitePath(file).startsWith("packages/"));
  if (!args.passed && unplaceable.length > 0) {
    const reason =
      `${unplaceable.length} of ${args.failedSuites.length} failed suite(s) are package-relative and cannot be ` +
      `attributed to a package (e.g. ${unplaceable[0]}); an incomplete failed set would understate the miss rate`;
    log(`no base-sweep outcome recorded for project ${args.projectId}: ${reason}`);
    return { recorded: false, reason };
  }
  const result = await recordGateOutcome({
    workingDir: args.repoPath,
    repoPath: args.repoPath,
    baseBranch: args.baseSha,
    passed: args.passed,
    failedSuites: args.failedSuites.map(normalizedSuitePath),
    tierInfo: null,
    source: "base-sweep",
    runCommand: args.runCommand,
    log,
  });
  if (result.recorded) {
    console.log(
      `[test-impact] recorded base-sweep outcome for project ${args.projectId}: ${args.passed ? "pass" : "fail"}, ` +
        `${result.changedCount} changed file(s) since the last green base, selection tier ${result.tier} would ` +
        `have picked ${result.selectedCount} test file(s)`,
    );
  } else if (result.reason && !result.reason.startsWith("no test-impact tool")) {
    log(`no base-sweep outcome recorded for project ${args.projectId}: ${result.reason}`);
  }
  return result;
}
