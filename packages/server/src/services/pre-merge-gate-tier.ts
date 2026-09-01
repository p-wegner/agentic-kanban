import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "../db/index.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { formatPostureNote, resolveRiskPosture, type RiskPosture } from "./risk-posture.service.js";
import { resolveEffectiveVerify } from "./stack-profile.service.js";
import { gateVerificationKey } from "./merge-gate-tree-memo.js";
import { resolveSelectorId } from "./test-impact-selector-id.js";
import {
  resolveTestImpactBudget,
  resolveTestImpactBudgetEnv,
  type ParsedTestImpactBudget,
} from "@agentic-kanban/shared/lib/test-impact-budget";

/**
 * The three verify-gate tiers (#538), replacing `verify_file_scope` plus the implicit
 * package/file scoping an operator could otherwise misalign as independent booleans:
 *  - `full`               — no scoping; every package's full suite runs (safest, slowest).
 *  - `scoped`              — package + file-level `vitest related` scoping (today's default
 *                            behavior of `verify_file_scope=true`), plus the always-run guard
 *                            suites (#278/#538) so tree-scanning invariants are never dropped.
 *  - `scoped-base-watch`   — `scoped`, PLUS a standing base-branch health signal (once one
 *                            exists) backstops the residual gap the always-run marker's static
 *                            classifier cannot see (a guard whose ambient read hides in a
 *                            helper). Falls back to `scoped` behavior until that base-health
 *                            mechanism lands — no knob may claim a proof it cannot yet make.
 *  - `impact`              — NARROWER THAN `scoped` (#956). Package scoping still applies, but
 *                            the file half is chosen by the test-impact SELECTION (a ranked
 *                            heuristic over several signals) instead of `vitest related`'s
 *                            import-graph walk, plus the `@gate:always-run` guards and every
 *                            NEW test file in the diff.
 *
 * A level may only WEAKEN verification VISIBLY: `buildGateTierMessage` always names the level
 * actually used, so a merge comment never hides which of these ran.
 *
 * **`impact` IS OPT-IN — and since #983 the `iterate` risk posture is how you opt in.** The
 * constraint this replaces read: "no risk posture yields `impact`", on the argument that #954's
 * ~50-run miss-rate corpus had to exist before the tier could be anybody's default. That was
 * the right call at #956 and it is deliberately REVERSED here, for a reason stated rather than
 * slipped in: the corpus was unreachable. `recordVerifyGateOutcome` had exactly one caller (the
 * pre-merge gate), so the only rows the ledger could ever hold came from a gate that, by
 * construction, cannot observe a suite it chose not to run. #982 added the second caller — the
 * periodic base-branch sweep, which runs the FULL suite — so a miss is now observable at all,
 * and `iterate` pairs the narrow gate with that sweep as its backstop rather than removing
 * verification.
 *
 * What has NOT changed: the selection is still a ranked GUESS. Unlike `vitest related`, whose
 * omissions are provably outside the import graph, a suite this tier drops below the score floor
 * may genuinely have been broken by the diff — which is why `iterate` is documented as trading
 * "caught before it lands" for "caught within a day, costing a rebase", and why it is wrong for
 * a repo with a real deployment. `DEFAULT_VERIFY_GATE_STRATEGY` stays `full`, and every posture
 * except `iterate` still yields a non-`impact` tier: a project reaches this tier only by an
 * operator explicitly choosing `iterate` (or setting `verify_gate_strategy_<id>` by hand).
 */
export const VERIFY_GATE_STRATEGY_VALUES = ["full", "scoped", "scoped-base-watch", "impact"] as const;
export type VerifyGateStrategy = (typeof VERIFY_GATE_STRATEGY_VALUES)[number];

/** Default until a base-health signal exists (see `scoped-base-watch` above) — #538. */
export const DEFAULT_VERIFY_GATE_STRATEGY: VerifyGateStrategy = "full";

/** Preference key for a per-project override of the verify-gate strategy tier. */
// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const verifyGateStrategyPrefDef = projectPref("verify_gate_strategy");

export function verifyGateStrategyPrefKey(projectId: string): string {
  return verifyGateStrategyPrefDef.key(projectId);
}

/**
 * The tier decision as a pure prefMap resolver (#937), routed through `resolveRiskPosture`
 * (#911, decision 017) — same shape as `resolveProjectContentionMode`.
 *
 * An explicit `verify_gate_strategy_<projectId>` still WINS when set: it is the operator's
 * deliberate finer-grained override of one field of the posture, and #911 kept that escape
 * hatch for `file_contention_<id>` for exactly the same reason. With no explicit value the
 * posture's `gateTier` decides — `standard` yields `full`, which IS
 * `DEFAULT_VERIFY_GATE_STRATEGY`, so today's behaviour is reproduced exactly.
 *
 * Returns the posture beside the tier so the caller can fold `.summary` into the gate message
 * (decision 017's visibility rule: a weaker posture may only weaken verification VISIBLY).
 */
export function resolveGateTier(
  prefMap: Map<string, string>,
  projectId: string,
): { strategy: VerifyGateStrategy; posture: RiskPosture; fromPosture: boolean } {
  const posture = resolveRiskPosture(prefMap, projectId);
  const raw = prefMap.get(verifyGateStrategyPrefKey(projectId))?.trim().toLowerCase();
  if (raw !== undefined && (VERIFY_GATE_STRATEGY_VALUES as readonly string[]).includes(raw)) {
    return { strategy: raw as VerifyGateStrategy, posture, fromPosture: false };
  }
  return { strategy: posture.gateTier, posture, fromPosture: true };
}

/**
 * DB-reading wrapper over `resolveGateTier` — the same "build a prefMap, read through it"
 * shape `resolveIssueRiskPosture` uses, so the async call sites keep their signature while
 * the DECISION lives in one pure function.
 *
 * Reads the whole (short-TTL cached) pref set rather than one key: the posture needs its own
 * project-scoped pref too, and this is the cache every monitor pass already warms.
 */
export async function resolveVerifyGateStrategy(projectId: string, database: Database): Promise<VerifyGateStrategy> {
  return (await resolveGateTierFor(projectId, database)).strategy;
}

/**
 * As `resolveVerifyGateStrategy`, but keeps the posture so a caller can surface `.summary` — and
 * the project's test-impact BUDGET (#966), read from the same prefMap this already loads.
 *
 * The budget rides along here rather than getting its own DB read because it is resolved at the
 * same instant, for the same decision, and a second read is a second chance for the two to
 * disagree about which pref generation the gate ran under.
 */
export async function resolveGateTierFor(
  projectId: string,
  database: Database,
): Promise<{
  strategy: VerifyGateStrategy;
  posture: RiskPosture;
  fromPosture: boolean;
  budget: ParsedTestImpactBudget | null;
}> {
  const prefMap = toPrefMap(await getAllPreferencesCached(database).catch(() => []));
  return { ...resolveGateTier(prefMap, projectId), budget: resolveTestImpactBudget(prefMap, projectId) };
}

/**
 * The scoping decision, as a pure function of the inputs the gate has already resolved (#643).
 *
 * Extracted because the bug was invisible inline: `full` is documented as "no scoping; every
 * package's full suite runs", but the code only disabled FILE-level scoping and set
 * `KANBAN_TEST_PACKAGES` regardless — so on the DEFAULT setting a diff still skipped whole
 * packages while the operator-facing knob said otherwise. A tier that may only weaken
 * verification VISIBLY cannot afford that gap between its name and its behaviour.
 *
 * `packagesEnv: null` means "set no scope env", which is what makes `test:mine` run everything.
 *
 * `scoped-base-watch` (#916) scopes exactly like `scoped` — the per-TRAIN gate stays narrow —
 * but is no longer a silent alias: `resolveBaseProbeDue` (below) is what makes the "backstop"
 * half of its name real, by deciding when a SEPARATE full base probe is owed. That decision is
 * orthogonal to `packagesEnv`/`fileScoped`, which is why it isn't threaded through this
 * function's return value — a caller wires the two together (scope the train gate here, then
 * separately check whether a base probe is due).
 *
 * **`impact` keeps the PACKAGE scope, and since #967 the FILE scope too.** `fileScoped` means
 * exactly "a `KANBAN_TEST_FILES` list was emitted", and under `impact` that list is now emitted as
 * well — `scripts/test-mine.mjs` derives the `vitest related` suites from it and hands them to
 * `select --union` instead of refusing the pair (#962's refusal is retired; see
 * `resolveGateFileScopeEmission` for why the rivalry became a union). The selection narrowing is
 * still reported through `selector`/`impactSelection` rather than by borrowing this flag — a flag
 * whose name meant two different narrowings is precisely how a tier weakens invisibly.
 */
export function resolveGateScoping(args: {
  strategy: VerifyGateStrategy;
  /** The scope `testPackagesEnvValue` derived from the diff, or null when it refused to scope. */
  testScope: string | null;
  /** The per-project `verify_file_scope` pref, already read. */
  fileScopePref: boolean;
  changedFileCount: number;
}): { packagesEnv: string | null; fileScoped: boolean } {
  const packagesEnv = args.strategy === "full" ? null : args.testScope;
  return {
    packagesEnv,
    // File scoping is strictly narrower than package scoping — it can never apply where the
    // gate refused to narrow packages at all, and it needs a diff it could actually read.
    fileScoped: Boolean(packagesEnv) && args.fileScopePref && args.changedFileCount > 0,
  };
}

/** Default: probe at most every 4 hours, so a project idle overnight gets refreshed coverage
 *  without a probe firing on every single train. */
export const DEFAULT_BASE_PROBE_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Default: also force a probe after this many trains have landed since the last one, so a
 *  busy project (many trains, short wall-clock gaps) still gets a periodic full-suite check
 *  rather than relying on elapsed time alone. */
export const DEFAULT_BASE_PROBE_EVERY_N_TRAINS = 10;

export interface BaseProbeDueInput {
  strategy: VerifyGateStrategy;
  /** ms since the last recorded base-branch-health probe for this project, or null if none ever ran. */
  lastProbeAgeMs: number | null;
  /** Trains landed since the last probe. */
  trainsSinceLastProbe: number;
  intervalMs?: number;
  everyNTrains?: number;
}

export interface BaseProbeDueResult {
  due: boolean;
  /** Human-readable age of the last probe, or "never" — for the gate message's "base probe <age>". */
  ageLabel: string;
}

/**
 * Is a SCHEDULED full base probe owed right now (#916)? Only meaningful under
 * `scoped-base-watch` — every other strategy either always runs the full suite (`full`) or
 * never backstops with one (`scoped`).
 *
 * Never true for the FIRST train after this mechanism exists (`lastProbeAgeMs: null`) is
 * still DUE — an unprobed base is the exact gap `scoped-base-watch` exists to close, so
 * "never checked" must not read as "recently checked".
 */
export function resolveBaseProbeDue(input: BaseProbeDueInput): BaseProbeDueResult {
  const { strategy, lastProbeAgeMs, trainsSinceLastProbe } = input;
  const intervalMs = input.intervalMs ?? DEFAULT_BASE_PROBE_INTERVAL_MS;
  const everyNTrains = input.everyNTrains ?? DEFAULT_BASE_PROBE_EVERY_N_TRAINS;

  if (strategy !== "scoped-base-watch") return { due: false, ageLabel: formatProbeAge(lastProbeAgeMs) };
  if (lastProbeAgeMs === null) return { due: true, ageLabel: "never" };

  const due = lastProbeAgeMs >= intervalMs || trainsSinceLastProbe >= everyNTrains;
  return { due, ageLabel: formatProbeAge(lastProbeAgeMs) };
}

function formatProbeAge(ms: number | null): string {
  if (ms === null) return "never";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Package `__tests__` dirs to scan for the `@gate:always-run` marker (#538), mirroring
 *  `scripts/test-mine.mjs`'s `ALWAYS_RUN_TESTS_DIR`. Best-effort: this repo checkout's own
 *  monorepo layout, so it is inert (returns 0) for a project this gate runs FOR that isn't
 *  this repo — the count only decorates the message, it never gates behavior. */
/**
 * The always-run marker and test-file rules, MIRRORED from `scripts/test-mine.mjs` (#891).
 *
 * Deliberately a copy, not an import. `packages/server` ships only `dist/` (see its `files`),
 * so importing a repo-root script would make a published install crash on load; and the script
 * itself imports only Node built-ins on purpose, so it cannot depend on this package either.
 * Two implementations is the floor the packaging allows.
 *
 * What stops them drifting is `always-run-dirs-lockstep.test.ts`, which now holds them to the
 * same RULE — feeding both the same fixtures and asserting identical classification — rather
 * than to the same TEXT by comment. Before #891 both sides used a bare `.includes()`, which
 * matched a file that merely MENTIONS the marker: they agreed only because both were wrong the
 * same way, and this counter's own guard suite was one of the two files being miscounted.
 */
const ALWAYS_RUN_MARKER_RE = /^\s*\/\/\s*@gate:always-run\b/m;

/** Mirrors `ALWAYS_RUN_TEST_FILE` in `scripts/test-mine.mjs`; held in lockstep by the same suite. */
const ALWAYS_RUN_TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export const ALWAYS_RUN_TESTS_DIRS = [
  join("packages", "shared", "__tests__"),
  join("packages", "server", "src", "__tests__"),
  join("packages", "mcp-server", "src", "__tests__"),
  // #601: the client's suites were invisible to the always-run scan, so a
  // `@gate:always-run` marker in a client guard would have been silently ignored.
  join("packages", "client", "src", "__tests__"),
];

/** How many suites currently carry the `@gate:always-run` marker, purely for the gate
 *  message's "+N guard suites" figure — never throws, never affects gate behavior. */
export function countAlwaysRunGuardSuites(repoRoot: string): number {
  let count = 0;
  // #583 — RECURSIVE, and every test extension. The old flat `readdirSync` over `.test.ts`
  // only saw a `__tests__` dir's top level, so `mcp-server/src/__tests__/tools/` (33 suites)
  // and every `.test.tsx`/`.test.mjs` were invisible: the gate under-reported the guard set
  // it claims to run while the marker ratchet, which had been fixed to recurse, stayed green.
  // A number in a gate message that quietly means something narrower than it says is worse
  // than no number, because it is the thing an operator checks instead of the suite list.
  const scan = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) scan(full);
        continue;
      }
      if (!ALWAYS_RUN_TEST_FILE.test(entry.name)) continue;
      if (ALWAYS_RUN_MARKER_RE.test(readFileSync(full, "utf8"))) count += 1;
    }
  };
  for (const dir of ALWAYS_RUN_TESTS_DIRS) {
    const abs = resolve(repoRoot, dir);
    if (!existsSync(abs)) continue;
    try {
      scan(abs);
    } catch {
      // Best-effort decoration only — never let a scan error affect the gate.
    }
  }
  return count;
}

/**
 * Which selector chose the suites the verify run executed (#962).
 *
 * `related` is today's `vitest related` scoping — the import-graph walk `KANBAN_TEST_FILES`
 * drives. `impact` is the test-impact heuristic (`KANBAN_TEST_SELECTOR=impact`, #951), which
 * NARROWS to a ranked guess rather than to a dependency closure.
 *
 * The distinction has to exist because it is the only thing that separates "every suite in scope
 * ran" from "a heuristic picked some". Without it an impact-narrowed run is recorded as `full`,
 * which asserts that every suite was observed — so any suite the selector skipped is counted as
 * having passed, and the ledger UNDER-reports misses precisely on the runs where the selector was
 * in charge. A confidently wrong LOW miss rate is what would promote the selector to default.
 */
export type GateTestSelector = "related" | "impact";

/**
 * The selector the verify run will actually use, as a pure function of the env it will see.
 *
 * The gate layers `verifyEnv` over `process.env` (`runSetupScript` applies the caller's map last),
 * so the effective value is the gate's own when it sets one and the ambient board-server env
 * otherwise. Nothing in the board sets `KANBAN_TEST_SELECTOR` today, which is exactly why this
 * must read the ambient value rather than assume: an operator who exports it for the server
 * process gets an impact-narrowed gate with no code change, and that run must not record as full.
 *
 * Mirrors `scripts/test-mine.mjs`'s own parse (trim + lowercase, `impact` the only recognized
 * value); an unrecognized value falls back there to `vitest related`, so it does here too.
 *
 * **The TIER also selects it (#956).** `verify_gate_strategy = impact` is the supported,
 * per-project way in; the ambient env var stays honoured because #962's reason for reading it has
 * not gone away (an operator who exports it for the server process gets an impact-narrowed gate
 * with no code change, and that run must not record as full). Either route yields the same
 * selector, so a gate never claims one and runs the other.
 */
export function resolveGateTestSelector(
  env: Record<string, string | undefined>,
  strategy?: VerifyGateStrategy,
  /**
   * The project's `test_impact_budget_<id>` (#966). A budget is a ceiling on a SELECTION, so
   * setting one with no selector would be inert — the budget is therefore the third route to
   * this selector, alongside the tier and the ambient env var. All three yield the same value,
   * so a gate never claims one selector and runs another.
   */
  budget?: ParsedTestImpactBudget | null,
): GateTestSelector {
  if (strategy === "impact" || budget) return "impact";
  return (env.KANBAN_TEST_SELECTOR ?? "").trim().toLowerCase() === "impact" ? "impact" : "related";
}

/**
 * Resolve the selector AND whether the gate may still emit its `KANBAN_TEST_FILES` scope (#962),
 * which since #967 is **also the union decision**.
 *
 * **#962 dropped the file scope under the impact selector; #967 keeps it.** The two were rival
 * answers to "which suites", and `test-mine.mjs` refused the pair rather than silently discarding
 * the file list — so the gate resolved the conflict itself, in the selector's favour. That was the
 * right call for a rivalry, and the wrong one now: the selectors' MISSES are different in kind.
 * `vitest related` is blind to runtime reach (spawned processes, fixtures, migrations) but its
 * omissions are provably outside the import graph; the impact heuristic sees that reach through
 * co-change/coverage/failure history but is a ranked bet under a floor and a budget. Dropping the
 * file scope gave up `related`'s cheap safety on every impact run for nothing.
 *
 * So the file scope is now emitted ALONGSIDE the selector, and `test-mine.mjs` derives the related
 * suites and hands them to `impact.mjs select --union` — where they enter after the score floor
 * (another selector's evidence is not subject to OUR floor) and before the budget cut (or "only
 * these seconds" would be a lie). The budget therefore still holds over the union, which is the
 * property the setting sells.
 *
 * `emitFileScope` is consequently just `fileScoped` today. It stays a named field rather than being
 * collapsed away: it is what `GateTierInfo.fileScoped` records, and the whole point of #962 was
 * that "what the scoping decision wanted" and "what reached the runner" are different questions.
 *
 * Returns the operator-facing `note` alongside the decision — the union case must be as visible as
 * the dropped case was — and the caller then has one `if` and no ternary. That is not cosmetic:
 * `runPreMergeGate` sits ON the god-module gate's 25-branch ceiling (grandfathered at 37), where
 * every branch a decision costs at the call site is one the function cannot spend on the merge
 * logic it exists for. `note` is null exactly when there is nothing to say (no file scoping at all).
 */
export function resolveGateFileScopeEmission(args: {
  env: Record<string, string | undefined>;
  /** What `resolveGateScoping` decided, before the selector is taken into account. */
  fileScoped: boolean;
  changedFileCount: number;
  /** The resolved tier — `impact` selects the selector on its own (#956). */
  strategy?: VerifyGateStrategy;
  /** The project's test-impact budget — a THIRD route to the selector (#966). */
  budget?: ParsedTestImpactBudget | null;
}): { selector: GateTestSelector; emitFileScope: boolean; unioned: boolean; note: string | null } {
  const selector = resolveGateTestSelector(args.env, args.strategy, args.budget);
  const emitFileScope = args.fileScoped;
  // #967 — a run is UNIONED when both selectors contributed. That is the fact the message, the
  // tier name and the ledger row all key off, so it is resolved once here rather than re-derived
  // as `selector === "impact" && fileScoped` at each of the three sites.
  const unioned = emitFileScope && selector === "impact";
  // Which of the three routes chose the selector, so the log line names the knob an operator would
  // actually have to change. The BUDGET is named first when both apply: it is the setting an
  // operator most likely just changed, and it is the one visible in Settings.
  const via = args.budget
    ? `test_impact_budget=${args.budget.value}`
    : args.strategy === "impact"
      ? "verify_gate_strategy=impact"
      : "KANBAN_TEST_SELECTOR=impact";
  const note = !args.fileScoped
    ? null
    : unioned
      ? `${via}, and the ${args.changedFileCount}-file scope is UNIONED into the impact selection rather than replaced (#967) — related-derived suites are exempt from the score floor but counted against the budget; this run is recorded as impact+related, not full`
      : `file-scoping verify tests to ${args.changedFileCount} changed file(s)`;
  return { selector, emitFileScope, unioned, note };
}

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
  /** Was the impact map stale when the selection was computed? */
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

/** Matches the test-file extensions `scripts/test-mine.mjs` actually runs. */
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;

/**
 * The env the `impact` tier hands the verify runner — and it is three variables, not one (#956).
 *
 * - `KANBAN_TEST_SELECTOR=impact` turns the selection on.
 * - `KANBAN_IMPACT_BASE` is what makes it a selection AT ALL. A gate runs on a clean,
 *   fully-committed tree, so with no base `impact.mjs` computes an EMPTY change set and silently
 *   degrades to the constant always-run set — identical for every branch — while still calling
 *   itself a selection. That is the #963 defect in a new place.
 * - `KANBAN_TEST_NEW_FILES` names the test files the diff TOUCHES. The motivating case is an ADDED
 *   suite: it is absent from the committed impact map, so it has no coverage, failure or runtime
 *   history — the very signals the score is built from — and can be ranked out below the floor by
 *   its own newness, letting the branch that introduced it merge without ever running it. Added vs
 *   MODIFIED is deliberately not distinguished: the answer is the same for both (run it), and the
 *   diff-status plumbing to tell them apart would buy nothing.
 *
 * Empty for every other tier, INCLUDING one whose selector came from the ambient
 * `KANBAN_TEST_SELECTOR` rather than from the tier: there the operator owns the configuration and
 * the gate does not second-guess it by injecting a base they did not ask for.
 *
 * Pure, and here rather than inline at the call site, because `runPreMergeGate` sits ON the
 * god-module gate's 25-branch ceiling (grandfathered at 37) — three conditionals spent on env
 * assembly are three the function cannot spend on the merge logic it exists for. Being pure also
 * makes the wiring a table test instead of something only a live gate run would catch, which is
 * the same reason `resolveGateFileScopeEmission` and `resolveGateScoping` live here.
 *
 * `fileExists` is injected so that test is possible without a worktree on disk.
 */
export function resolveImpactSelectorEnv(args: {
  strategy: VerifyGateStrategy;
  baseBranch: string | null | undefined;
  changedFiles: readonly string[];
  /** Whether a changed path still exists — a DELETED test must not be named. Handing vitest a
   *  missing path fails the package with a bare `No test files found`, turning a WIDENING into a
   *  red gate. */
  fileExists: (relativePath: string) => boolean;
  /**
   * The project's `test_impact_budget_<id>` (#966). A budget IMPLIES the selector, so this
   * function now has two entry conditions rather than one — and the budget adds a FOURTH
   * variable, `KANBAN_TEST_BUDGET`, which `scripts/test-mine.mjs` passes to `select --budget`.
   *
   * A budget with a non-`impact` tier is the ordinary case, not an edge one: the Settings field
   * is the intended way in, and no project's tier defaults to `impact`. So the base/new-file
   * companions have to be emitted for a budgeted run too — they are what make the selection see
   * the diff at all (#963), and they are just as load-bearing when the budget chose the selector
   * as when the tier did.
   */
  budget?: ParsedTestImpactBudget | null;
}): Record<string, string> {
  if (args.strategy !== "impact" && !args.budget) return {};
  const newTestFiles = args.changedFiles.filter((file) => TEST_FILE_RE.test(file) && args.fileExists(file));
  return {
    KANBAN_TEST_SELECTOR: "impact",
    ...resolveTestImpactBudgetEnv(args.budget ?? null),
    ...(args.baseBranch ? { KANBAN_IMPACT_BASE: args.baseBranch } : {}),
    ...(newTestFiles.length > 0 ? { KANBAN_TEST_NEW_FILES: newTestFiles.join(",") } : {}),
  };
}

/**
 * Assemble the env the verify script runs under — the ONE place the scoping vocabularies are
 * combined (#956).
 *
 * There are three ways this gate narrows the test half, and they still do not compose freely:
 * `KANBAN_TEST_GUARDS_ONLY` (docs-only, exits before anything else is consulted),
 * `KANBAN_TEST_SELECTOR=impact` + its base/new-file companions, and
 * `KANBAN_TEST_PACKAGES` (+ `KANBAN_TEST_FILES`). **The last two now COMPOSE (#967)**: the runner
 * derives `vitest related`'s suites from the file list and unions them into the selection, so
 * emitting both is the intended pairing rather than the exit-2 refusal #962 had to route around.
 * Guards-only still excludes everything else — it exits before the selector is ever consulted, so
 * naming a selection there would describe one that cannot happen.
 *
 * Pure, and here beside `resolveGateScoping` / `resolveGateFileScopeEmission` / the impact env,
 * so the whole decision is testable as a table and `runPreMergeGate` — which sits ON the
 * god-module gate's branch and line ceilings — spends nothing on it.
 *
 * The impact env is folded into the non-guards arms only: a docs-only diff never reaches the
 * selector, so naming it there would describe a selection that cannot happen.
 */
export function buildVerifyEnv(args: {
  /** Isolation/capacity env every run gets regardless of tier. */
  isolationEnv: Record<string, string>;
  guardsOnly: boolean;
  /** `resolveImpactSelectorEnv`'s output — `{}` for every non-impact tier. */
  impactEnv: Record<string, string>;
  /** `resolveGateScoping`'s `packagesEnv`; null means "set no package scope". */
  packagesEnv: string | null;
  /** `resolveGateFileScopeEmission`'s `emitFileScope`. */
  emitFileScope: boolean;
  changedFiles: readonly string[];
}): Record<string, string> {
  if (args.guardsOnly) return { ...args.isolationEnv, KANBAN_TEST_GUARDS_ONLY: "1" };
  const base = { ...args.isolationEnv, ...args.impactEnv };
  if (!args.packagesEnv) return base;
  return {
    ...base,
    KANBAN_TEST_PACKAGES: args.packagesEnv,
    ...(args.emitFileScope ? { KANBAN_TEST_FILES: args.changedFiles.join(",") } : {}),
  };
}

export interface GateTierInfo {
  strategy: VerifyGateStrategy;
  /**
   * The selection facts behind an `impact`-selector run (#956), or null when the gate ran under
   * that selector but could not resolve them (no skill, no inventory, an unparseable payload).
   *
   * Undefined for every non-impact run, where there is no selection to describe.
   */
  impactSelection?: GateImpactSelection | null;
  /**
   * Which selector chose the suites (#962). Optional for back-compat with a caller that never
   * resolved one; `gateRanScope` treats an absent value as `related`, which reproduces the
   * pre-#962 recording exactly for every project that does not opt in.
   */
  selector?: GateTestSelector;
  /** Whether `KANBAN_TEST_PACKAGES` was set at all — false for an unreadable diff, a
   *  global-config change, or a path owned by no package, in which case EVERY package's full
   *  suite ran regardless of `strategy`. Distinct from `fileScoped`: package-scoping without
   *  file-scoping is a real, narrower tier that must not be reported as "full". */
  packageScoped: boolean;
  fileScoped: boolean;
  /** The diff was docs-only, so the verify script ran ONLY the `@gate:always-run` guard
   *  suites (`KANBAN_TEST_GUARDS_ONLY`). Narrower than every other tier, and reported as its
   *  own name because the previous behavior — skipping verification entirely — read as a bare
   *  "skipped" and hid that the markdown-reading guards never ran. */
  guardsOnly?: boolean;
  changedFileCount: number;
  guardSuiteCount: number;
  maxWorkers: number;
  /**
   * Was `maxWorkers` DERIVED from live capacity (#909), or pinned (env override, or a
   * capacity-read failure that fell back to the pref/shipped default)? Undefined for a caller
   * that never resolved capacity at all (kept optional for back-compat with any pre-#909 test
   * fixture that constructs a `GateTierInfo` by hand).
   */
  maxWorkersDerived?: boolean;
  /** Free RAM (GB) observed when `maxWorkers` was derived; null when not derived or unread. */
  hostFreeGb?: number | null;
  /**
   * Were new builder starts held for the duration of this gate (#581)? An operator reading
   * a merge comment has to be able to tell a result produced on a quiet box from one
   * produced while builders were competing for the same cores — the second kind is where
   * the `mergeWorkspace` load flakes came from, and it named a real test with a plausible
   * defect, so nothing about the failure itself said "contention".
   */
  buildersQuiesced?: boolean;
  /**
   * How long this gate spent QUEUED behind another heavyweight verification before it could
   * start (#949). Same rule as `buildersQuiesced`: the conditions a verdict was produced under
   * are part of the verdict. Two gates on one box were observed at 20 min and >45 min wall with
   * nothing anywhere distinguishing "slow" from "waited most of that time", which is what made
   * the contention invisible in the first place.
   *
   * 0 (or undefined, for a caller that never took a slot) means it started immediately, and the
   * message then says nothing rather than reporting a reassuring "queued 0s".
   */
  queueWaitMs?: number;
  /**
   * Set when this gate ran WITHOUT the cross-process machine verify lock (#957) — either it
   * waited out its role's bound behind a holder it could not outlast, or the lock could not be
   * hosted on this box at all.
   *
   * The ticket's acceptance requires that a process which cannot acquire within its timeout SAYS
   * SO rather than proceeding silently, per "a level may only weaken verification VISIBLY". A
   * verdict produced alongside an unknown other full suite is a weaker verdict than the same
   * verdict produced on a quiet box — the same argument `buildersQuiesced` and `queueWaitMs`
   * already make, extended past this process's own boundary.
   *
   * `undefined` (the overwhelmingly common case: the lock is opt-in, and when on it is usually
   * acquired) means the message says nothing.
   */
  unserializedNote?: string;
  /**
   * Set when #894's targeted re-run cleared suites that had failed under load. A PASSING gate
   * must say this: the merge was cleared by a second, narrower run, and an operator reading
   * "passed" with no mention of it would have a different picture of the evidence than the
   * one that actually exists. Same rule as `buildersQuiesced` — the conditions a verdict was
   * produced under are part of the verdict.
   */
  flakeRetryNote?: string;
  /**
   * Set only meaningfully under `scoped-base-watch` (#916): lets the message name
   * `base probe <age>` — the "backstop" this tier promises, made visible the same way
   * `buildersQuiesced`/`flakeRetryNote` make their own conditions visible on a PASSING gate.
   */
  baseProbeAgeLabel?: string;
  baseProbeDue?: boolean;
  /**
   * The risk posture that SELECTED this tier (#937), when it did — i.e. no explicit
   * `verify_gate_strategy_<projectId>` override was set. Decision 017's visibility rule:
   * every gate/merge message reading a `RiskPosture` field folds its `.summary` in, so an
   * operator can see that a weaker gate came from the posture dial rather than reading
   * "package-scoped" and having to guess which of two knobs chose it.
   *
   * Undefined when the tier came from the explicit pref, or for a caller that never resolved
   * a posture — a message must not claim a posture decided something it did not.
   */
  posture?: RiskPosture;
}

/**
 * The impact selection's facts as a message fragment (#956), or null when there is nothing to say.
 *
 * Extracted from `buildGateTierMessage` rather than inlined because it is the part with a real
 * decision in it — an unresolved selection must produce a LOUDER string than a resolved one, which
 * is the opposite of the usual "omit when absent" shape used for the optional fields around it.
 */
export function buildImpactSelectionNote(tierInfo: GateTierInfo): string | null {
  if (tierInfo.selector !== "impact" || tierInfo.guardsOnly) return null;
  const selection = tierInfo.impactSelection;
  if (!selection) {
    // Silence here would read as "nothing was dropped". The tier narrowed the run by an amount
    // nobody can state, which is strictly worse than a stated number and must say so.
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
  const kept =
    selection.externalCount !== undefined
      ? `selection kept ${selection.selectedCount} suite(s) (impact ${selection.selectedCount - selection.externalCount} + related added ${selection.externalCount})`
      : selection.unionUnmeasured
        ? `selection kept ${selection.selectedCount} impact suite(s) PLUS the \`vitest related\` scope (unioned at run time, not counted here — these figures are a lower bound)`
        : `selection kept ${selection.selectedCount} suite(s)`;
  return (
    `${budgetNote}${kept}, dropped ${selection.belowFloorCount} below the score floor` +
    (selection.selectionTier ? `, selection tier ${selection.selectionTier}` : "") +
    `, map ${selection.stale ? "STALE" : "fresh"}`
  );
}

/**
 * #538 — even a PASSED gate must say what actually ran, so a level may only weaken
 * verification VISIBLY: anyone reading a merge comment can see the tier, not just "passed".
 *
 * `tierInfo` is null whenever the verify_script branch never ran at all (smoke-only gate, or
 * docs-only skip handled by the caller before this is reached) — the message then names that
 * plainly instead of inventing tier details for a run that never happened.
 *
 * The tier label reflects what ACTUALLY ran, not the operator's `strategy` setting — a
 * `scoped` strategy with `verify_file_scope=false`, or an unreadable/unmodeled diff, performs
 * no narrowing at all and must say "full", never "package-scoped" (#538: a mislabeled tier is
 * exactly the "level weakens invisibly" failure this feature exists to prevent).
 */
export function buildGateTierMessage(tierInfo: GateTierInfo | null): string {
  if (!tierInfo) return "pre-merge gate passed (smoke check only — no verify_script tier)";
  // #956 — the impact SELECTION outranks the package/file scoping for the tier NAME, because it
  // is the narrower and the less provable of the two: `package-scoped` asserts that every suite in
  // those packages ran, which is exactly what an impact-selected run does not do. Guards-only still
  // wins, for the same reason it wins in `gateRanScope`: `KANBAN_TEST_GUARDS_ONLY` exits before the
  // selector is ever consulted, so no selection happened at all.
  const tier = tierInfo.guardsOnly
    ? "guards-only (docs-only diff)"
    : tierInfo.selector === "impact"
      // #967 — a run whose suites came from BOTH selectors is not the same claim as one that came
      // from the ranking alone, and the ledger records it under its own `ran` name for exactly that
      // reason. The tier label has to match, or the message and the row describe different runs.
      ? tierInfo.fileScoped
        ? "impact+related"
        : "impact-selected"
      : tierInfo.fileScoped
        ? "file-scoped"
        : tierInfo.packageScoped
          ? "package-scoped"
          : "full";
  const impactNote = buildImpactSelectionNote(tierInfo);
  const workersLabel = tierInfo.maxWorkersDerived
    ? `workers ${tierInfo.maxWorkers} (derived, host free ${(tierInfo.hostFreeGb ?? 0).toFixed(1)} GB)`
    : `workers ${tierInfo.maxWorkers}`;
  const parts = [
    `tier: ${tier}`,
    // #962: only when it is NOT the default. A run whose suites were chosen by a ranked heuristic
    // rather than by an import-graph walk is a materially weaker claim, and the tier name alone
    // does not carry it — `full` + impact selector reads as "everything ran". A level may only
    // weaken verification VISIBLY, so the message says which selector was in charge. Saying
    // "selector: related" on every gate would be noise that trains the reader to skip the field.
    ...(tierInfo.selector === "impact" && !tierInfo.guardsOnly
      // ASCII deliberately: this string travels through merge comments, PowerShell hosts and log
      // files on a Windows box, and a `∪` came back mojibake from the first tool in that chain
      // that guessed an encoding. A gate message that renders as `âˆª` is worse than a plain word.
      ? [tierInfo.fileScoped ? "selector: impact (heuristic) UNION related" : "selector: impact (heuristic)"]
      : []),
    // #956 — how many suites the selection kept, what it dropped below the floor, and whether the
    // map was fresh. Sits next to the selector name so the claim and its size read together.
    ...(impactNote ? [impactNote] : []),
    `${tierInfo.changedFileCount} changed file(s)`,
    // #956 adds the impact case: the guards run ON TOP of the selection there too, and a tier that
    // narrows this hard must name the set it did NOT narrow.
    ...(tierInfo.fileScoped || tierInfo.guardsOnly || (tierInfo.selector === "impact" && !tierInfo.guardsOnly)
      ? [`${tierInfo.guardsOnly ? "" : "+"}${tierInfo.guardSuiteCount} guard suites`]
      : []),
    workersLabel,
    ...(tierInfo.buildersQuiesced === undefined
      ? []
      : [tierInfo.buildersQuiesced ? "builders held" : "builders NOT held"]),
    // #949: only when it actually waited — a "queued 0s" on every passing gate would be noise
    // that trains the reader to skip the field, which is how the contention stayed invisible.
    ...(tierInfo.queueWaitMs && tierInfo.queueWaitMs > 0
      ? [`queued ${Math.round(tierInfo.queueWaitMs / 1000)}s behind another verification`]
      : []),
    // #957: this gate could not get the MACHINE-wide lock and ran anyway, so another process's
    // heavyweight verification was on the box at the same time. Named unconditionally when it
    // happens — the whole point of the note is that it is never the silent case.
    ...(tierInfo.unserializedNote ? ["UNSERIALIZED across processes"] : []),
  ];
  const retry = tierInfo.flakeRetryNote ? ` ${tierInfo.flakeRetryNote}` : "";
  const baseProbe = tierInfo.strategy === "scoped-base-watch" && tierInfo.baseProbeAgeLabel
    ? ` [base probe ${tierInfo.baseProbeAgeLabel}${tierInfo.baseProbeDue ? ", due now" : ""}]`
    : "";
  // #957: the parenthesised list carries the FLAG; the note itself carries who was holding and
  // for how long, which is what an operator needs to act on. Same split as `flakeRetryNote`.
  const unserialized = tierInfo.unserializedNote ? ` ${tierInfo.unserializedNote}` : "";
  return `pre-merge gate passed (${parts.join(", ")})${retry}${unserialized}${baseProbe}${formatPostureNote(tierInfo.posture)}`;
}

/**
 * What verification the gate is about to apply: the tier, the effective verify command, and an
 * opaque `verificationKey` folding both.
 *
 * **The ordering is the point.** The gate-PASS tree memo (#492) was keyed on project + merged
 * tree and consulted BEFORE either of these resolved. The tree carries the base commit by
 * content, so that part was sound — but not what the pass BOUGHT. Within the memo's 2 h TTL, a
 * pass banked under `verify_gate_strategy = scoped` was replayed after an operator switched the
 * project to `full`, and a pass banked under a looser `verify_script` was replayed after the
 * script was tightened. That is a level weakening verification INVISIBLY, which is the one thing
 * the tier contract above forbids. Resolving both here — two cheap pref reads — lets the caller
 * consult the memo with a key that says which verification earned the pass.
 *
 * `resolveEffectiveVerify` is the #551 single resolver ("what will the gate run" — override
 * first, derived second), the same call `workspace-provision` makes to tell the builder what to
 * run, so the two can never name different commands. `persistDerived` re-derives ONCE at gate
 * time when nothing is configured (#377): `verify_script` is otherwise only derived at
 * REGISTRATION, so a project registered from an empty repo would have no gate forever however
 * many suites it later grows. It never clobbers an existing value or writes an empty one, so it
 * can only ADD a gate. Honest limit, measured on #377's project: detection reads the repo ROOT
 * only, so a `package.json` under `src/` recovers nothing — the `unverified` flag covers that.
 *
 * A read error means we cannot tell whether a gate is configured, so it degrades to "no verify
 * gate" — fail-closed applies to a CONFIGURED gate that cannot RUN, never to gate DETECTION.
 *
 * **`workingDir` adds the third key component (#958): the test-impact SELECTOR's identity.** The
 * tier and the command live in preferences, but the selector is materialized into the WORKTREE and
 * is untracked, so it is invisible to both the prefs above and to `mergedTreeHash` — the one input
 * to "what will this gate actually run" that nothing else in the key can see. It is resolved here,
 * with the other two, precisely so the ORDERING property this function exists to guarantee still
 * holds: everything the memo key names is known before the memo is consulted. `selector-id` is
 * chosen over `select --json` for exactly that reason — see `resolveSelectorId`.
 *
 * A caller with no worktree (or a project without the skill, which is almost all of them) passes
 * nothing and gets today's two-component key unchanged.
 */
export async function resolveGateVerification(
  projectId: string,
  database: Database,
  options?: {
    /** The worktree the gate will run in, for the selector-identity component (#958). */
    workingDir?: string | null;
    /** Injected for tests — see `resolveSelectorId`. */
    resolveSelectorIdFn?: typeof resolveSelectorId;
  },
): Promise<{
  strategy: VerifyGateStrategy;
  /** The posture that selected `strategy`, or undefined when an explicit pref override did (#937). */
  posture: RiskPosture | undefined;
  effectiveVerify: Awaited<ReturnType<typeof resolveEffectiveVerify>> | null;
  verifyScript: string | null;
  /** The test-impact selector identity folded into the key, or `""` when there is none (#958). */
  selectorId: string;
  /** The project's test-impact budget, resolved with the tier (#966); null when off. */
  budget: ParsedTestImpactBudget | null;
  verificationKey: string;
}> {
  const { strategy, posture, fromPosture, budget } = await resolveGateTierFor(projectId, database);
  const effectiveVerify = await resolveEffectiveVerify(projectId, database, { persistDerived: true }).catch(() => null);
  const verifyScript = effectiveVerify?.command ?? null;
  // Never throws and never blocks: an unresolvable selector yields `""`, which reproduces the
  // pre-#958 key exactly. The only cost of losing it is an extra gate run.
  //
  // **The BUDGET is passed as a selector ARG, which is what makes flipping the setting invalidate
  // banked passes (#966).** `selectorIdentity()` in `impact.mjs` already folds `budgetMs` into the
  // id (#958), so the memo safety is free — but only if the budget actually reaches it. Omitting
  // it here would leave a pass banked under a 30s budget replayable under a 120s one, i.e. a
  // level weakening verification invisibly, which is the one thing the tier contract forbids.
  const selectorId = await (options?.resolveSelectorIdFn ?? resolveSelectorId)({
    workingDir: options?.workingDir ?? null,
    selectorArgs: budget ? ["--budget", budget.value] : [],
  });
  return {
    strategy,
    posture: fromPosture ? posture : undefined,
    effectiveVerify,
    verifyScript,
    selectorId,
    budget,
    // The KEY stays keyed on the resolved tier, not the posture that chose it: two projects on
    // different postures that resolve to the same tier + script bought the same verification, and
    // a pass under one is legitimately reusable under the other (#492's memo is about what the
    // pass BOUGHT). A posture CHANGE that moves the tier already changes this key.
    verificationKey: gateVerificationKey(strategy, verifyScript, selectorId),
  };
}
