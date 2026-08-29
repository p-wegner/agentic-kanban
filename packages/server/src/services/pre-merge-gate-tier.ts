import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "../db/index.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { formatPostureNote, resolveRiskPosture, type RiskPosture } from "./risk-posture.service.js";
import { resolveEffectiveVerify } from "./stack-profile.service.js";
import { gateVerificationKey } from "./merge-gate-tree-memo.js";

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
 *
 * A level may only WEAKEN verification VISIBLY: `buildGateTierMessage` always names the level
 * actually used, so a merge comment never hides which of these ran.
 */
export const VERIFY_GATE_STRATEGY_VALUES = ["full", "scoped", "scoped-base-watch"] as const;
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

/** As `resolveVerifyGateStrategy`, but keeps the posture so a caller can surface `.summary`. */
export async function resolveGateTierFor(
  projectId: string,
  database: Database,
): Promise<{ strategy: VerifyGateStrategy; posture: RiskPosture; fromPosture: boolean }> {
  const prefMap = toPrefMap(await getAllPreferencesCached(database).catch(() => []));
  return resolveGateTier(prefMap, projectId);
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

export interface GateTierInfo {
  strategy: VerifyGateStrategy;
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
  const tier = tierInfo.guardsOnly
    ? "guards-only (docs-only diff)"
    : tierInfo.fileScoped
      ? "file-scoped"
      : tierInfo.packageScoped
        ? "package-scoped"
        : "full";
  const workersLabel = tierInfo.maxWorkersDerived
    ? `workers ${tierInfo.maxWorkers} (derived, host free ${(tierInfo.hostFreeGb ?? 0).toFixed(1)} GB)`
    : `workers ${tierInfo.maxWorkers}`;
  const parts = [
    `tier: ${tier}`,
    `${tierInfo.changedFileCount} changed file(s)`,
    ...(tierInfo.fileScoped || tierInfo.guardsOnly ? [`${tierInfo.guardsOnly ? "" : "+"}${tierInfo.guardSuiteCount} guard suites`] : []),
    workersLabel,
    ...(tierInfo.buildersQuiesced === undefined
      ? []
      : [tierInfo.buildersQuiesced ? "builders held" : "builders NOT held"]),
  ];
  const retry = tierInfo.flakeRetryNote ? ` ${tierInfo.flakeRetryNote}` : "";
  const baseProbe = tierInfo.strategy === "scoped-base-watch" && tierInfo.baseProbeAgeLabel
    ? ` [base probe ${tierInfo.baseProbeAgeLabel}${tierInfo.baseProbeDue ? ", due now" : ""}]`
    : "";
  return `pre-merge gate passed (${parts.join(", ")})${retry}${baseProbe}${formatPostureNote(tierInfo.posture)}`;
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
 */
export async function resolveGateVerification(
  projectId: string,
  database: Database,
): Promise<{
  strategy: VerifyGateStrategy;
  /** The posture that selected `strategy`, or undefined when an explicit pref override did (#937). */
  posture: RiskPosture | undefined;
  effectiveVerify: Awaited<ReturnType<typeof resolveEffectiveVerify>> | null;
  verifyScript: string | null;
  verificationKey: string;
}> {
  const { strategy, posture, fromPosture } = await resolveGateTierFor(projectId, database);
  const effectiveVerify = await resolveEffectiveVerify(projectId, database, { persistDerived: true }).catch(() => null);
  const verifyScript = effectiveVerify?.command ?? null;
  return {
    strategy,
    posture: fromPosture ? posture : undefined,
    effectiveVerify,
    verifyScript,
    // The KEY stays keyed on the resolved tier, not the posture that chose it: two projects on
    // different postures that resolve to the same tier + script bought the same verification, and
    // a pass under one is legitimately reusable under the other (#492's memo is about what the
    // pass BOUGHT). A posture CHANGE that moves the tier already changes this key.
    verificationKey: gateVerificationKey(strategy, verifyScript),
  };
}
