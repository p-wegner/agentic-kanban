// @gate:always-run — two cases probe the repo root for the materialized test-impact skill
// (`.claude/skills/test-impact/tools/impact.mjs`), which is state outside this file's import
// graph, so dependency-based selection cannot see that they depend on it.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isValidTestImpactBudget,
  parseTestImpactBudget,
  resolveTestImpactBudget,
  resolveTestImpactBudgetEnv,
  testImpactBudgetPrefKey,
} from "@agentic-kanban/shared/lib/test-impact-budget";
import { isProjectScopedDynamicKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import {
  buildGateTierMessage,
  buildImpactSelectionNote,
  buildVerifyEnv,
  resolveGateFileScopeEmission,
  resolveGateTestSelector,
  resolveGateVerification,
  resolveImpactSelectorEnv,
  type GateTierInfo,
} from "../services/pre-merge-gate-tier.js";
import { IMPACT_TOOL_RELATIVE_PATH, parseSelection, resolveGateImpactSelection } from "../services/test-impact-outcome.service.js";
import { withBuilderTestImpactBudget } from "../services/session-manager/session-launch-helpers.js";
import type { Database } from "../db/index.js";

/**
 * #966 — the per-project test-impact BUDGET.
 *
 * Three properties are worth pinning, and they are the three that would fail silently:
 *
 *  1. **Clearing it restores today's behaviour EXACTLY.** Every "off" path returns an empty env
 *     map rather than empty-valued variables, because a SET-but-empty `KANBAN_TEST_SELECTOR` is
 *     not the same as an absent one (`test-mine.mjs` warns on an unrecognised value).
 *  2. **Setting it IMPLIES the selector, and is named in the gate message.** A budget on a
 *     selection nobody makes would be inert, and a tier that weakens verification without saying
 *     so is exactly what the tier contract forbids.
 *  3. **Memo safety: flipping the budget must invalidate banked passes.** `selectorIdentity()` in
 *     `impact.mjs` already folds `budgetMs` into the selector id (#958) — but only if the budget
 *     actually REACHES it. That plumbing is what this file pins; without it a pass banked under a
 *     30s budget replays under a 120s one, a stale green.
 */

const PROJECT = "11111111-2222-3333-4444-555555555555";

const baseTier: GateTierInfo = {
  strategy: "full",
  selector: "impact",
  packageScoped: true,
  fileScoped: false,
  changedFileCount: 9,
  guardSuiteCount: 66,
  maxWorkers: 6,
};

describe("the budget preference key", () => {
  it("is built from the shared key family, not a hand-written string", () => {
    expect(testImpactBudgetPrefKey(PROJECT)).toBe(`test_impact_budget_${PROJECT}`);
  });

  it("is registered, so the settings route accepts a write to it", () => {
    // Without the registry entry the Settings PUT 422s and the field silently never persists —
    // the exact failure #874 documents.
    expect(isProjectScopedDynamicKey(testImpactBudgetPrefKey(PROJECT))).toBe(true);
  });
});

describe("parsing a budget value", () => {
  it("accepts the units impact.mjs accepts and converts to ms", () => {
    expect(parseTestImpactBudget("60s")).toEqual({ value: "60s", ms: 60_000 });
    expect(parseTestImpactBudget("90000ms")).toEqual({ value: "90000ms", ms: 90_000 });
    // A bare number is milliseconds there, so it must be here too.
    expect(parseTestImpactBudget("500")).toEqual({ value: "500", ms: 500 });
  });

  it("REJECTS a minutes suffix, because the tool would read it as milliseconds", () => {
    // `impact.mjs`'s parseMs is `/s$/ && !/ms$/ ? *1000 : parseFloat(v)` — it knows exactly two
    // units, so `2m` reaches it as parseFloat("2m") === 2, i.e. TWO MILLISECONDS. Accepting `m`
    // would let the board validate the value, print `budget 2m` in the gate message, and hand the
    // selector a budget that drops every non-always-run suite: a near-empty verification reported
    // as a two-minute one. Rejecting at the settings boundary is the only failure direction that
    // cannot silently weaken a gate.
    expect(parseTestImpactBudget("2m")).toBeNull();
    expect(isValidTestImpactBudget("2m")).toBe(false);
  });

  it("mirrors impact.mjs's parseMs exactly on every value it accepts", () => {
    // The invariant the module claims: "a value this accepts is a value the tool accepts". Pinned
    // against a local copy of the tool's own expression rather than against hand-written numbers,
    // so a future unit added on one side without the other fails here.
    const toolParseMs = (v: string) =>
      /s$/.test(v) && !/ms$/.test(v) ? parseFloat(v) * 1000 : parseFloat(v);
    for (const raw of ["60s", "90000ms", "500", "0.5s", "120s"]) {
      const parsed = parseTestImpactBudget(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.ms).toBe(toolParseMs(parsed!.value));
    }
  });

  it("preserves the operator's own spelling rather than normalising it", () => {
    // Re-rendering the value would put a SECOND parser in the pipeline that could disagree with
    // the tool's — and the tool's is the one that decides what actually runs.
    expect(parseTestImpactBudget("  60s  ")?.value).toBe("60s");
  });

  it("treats absent, empty and unparseable as OFF rather than defaulting", () => {
    // A default budget would silently NARROW a gate on a typo, which is precisely backwards.
    for (const raw of [undefined, null, "", "   ", "soon", "60 s", "-5s", "0s", "60h"]) {
      expect(parseTestImpactBudget(raw)).toBeNull();
    }
  });

  it("accepts an empty value at the settings boundary (that is how it is cleared)", () => {
    expect(isValidTestImpactBudget("")).toBe(true);
    expect(isValidTestImpactBudget("60s")).toBe(true);
    expect(isValidTestImpactBudget("later")).toBe(false);
  });

  it("reads off a prefMap under the registered key", () => {
    const prefMap = new Map([[testImpactBudgetPrefKey(PROJECT), "45s"]]);
    expect(resolveTestImpactBudget(prefMap, PROJECT)?.ms).toBe(45_000);
    expect(resolveTestImpactBudget(new Map(), PROJECT)).toBeNull();
  });
});

describe("the env a budget exports", () => {
  it("is EMPTY when off — not a map of empty values", () => {
    // A SET-but-empty KANBAN_TEST_SELECTOR is not an absent one: `test-mine.mjs` warns on an
    // unrecognised value, so "clearing restores today's behaviour exactly" would be false.
    expect(resolveTestImpactBudgetEnv(null)).toEqual({});
  });

  it("turns the selector on and carries the budget through", () => {
    expect(resolveTestImpactBudgetEnv(parseTestImpactBudget("60s"))).toEqual({
      KANBAN_TEST_SELECTOR: "impact",
      KANBAN_TEST_BUDGET: "60s",
    });
  });
});

describe("the budget implies the impact selector for the gate", () => {
  const budget = parseTestImpactBudget("60s");

  it("selects `impact` even on the default `full` tier with no env var set", () => {
    expect(resolveGateTestSelector({}, "full", budget)).toBe("impact");
    // ...and changes nothing when off, which is every project today.
    expect(resolveGateTestSelector({}, "full", null)).toBe("related");
  });

  it("drops the file scope, so the runner is never handed the pair it refuses", () => {
    // `test-mine.mjs` REFUSES KANBAN_TEST_FILES + KANBAN_TEST_SELECTOR=impact (exit 2, a hard
    // merge blocker), so the gate has to resolve this itself.
    const result = resolveGateFileScopeEmission({
      env: {},
      fileScoped: true,
      changedFileCount: 4,
      strategy: "scoped",
      budget,
    });
    expect(result.selector).toBe("impact");
    expect(result.emitFileScope).toBe(false);
    expect(result.note).toContain("test_impact_budget=60s");
  });

  it("names the budget rather than the tier when the budget is what chose the selector", () => {
    // The note must name the knob an operator would actually have to change, and the budget is
    // the one visible in Settings.
    const viaTier = resolveGateFileScopeEmission({ env: {}, fileScoped: true, changedFileCount: 4, strategy: "impact" });
    expect(viaTier.note).toContain("verify_gate_strategy=impact");
  });

  it("emits the selector, the budget AND the base/new-file companions", () => {
    // The base is what makes the selection see the diff at all (#963) — just as load-bearing
    // when the BUDGET chose the selector as when the tier did.
    const env = resolveImpactSelectorEnv({
      strategy: "full",
      baseBranch: "master",
      changedFiles: ["packages/server/src/__tests__/new.test.ts", "packages/server/src/x.ts"],
      fileExists: () => true,
      budget,
    });
    expect(env).toEqual({
      KANBAN_TEST_SELECTOR: "impact",
      KANBAN_TEST_BUDGET: "60s",
      KANBAN_IMPACT_BASE: "master",
      KANBAN_TEST_NEW_FILES: "packages/server/src/__tests__/new.test.ts",
    });
  });

  it("emits nothing at all when the budget is off and the tier is not impact", () => {
    expect(
      resolveImpactSelectorEnv({
        strategy: "scoped",
        baseBranch: "master",
        changedFiles: ["packages/server/src/x.ts"],
        fileExists: () => true,
        budget: null,
      }),
    ).toEqual({});
  });

  it("never lets the assembled verify env carry both the selector and a file list", () => {
    const env = buildVerifyEnv({
      isolationEnv: { KANBAN_TEST_MAX_WORKERS: "6" },
      guardsOnly: false,
      impactEnv: resolveImpactSelectorEnv({
        strategy: "full",
        baseBranch: "master",
        changedFiles: ["packages/server/src/x.ts"],
        fileExists: () => true,
        budget,
      }),
      packagesEnv: "server",
      emitFileScope: false,
      changedFiles: ["packages/server/src/x.ts"],
    });
    expect(env.KANBAN_TEST_SELECTOR).toBe("impact");
    expect(env.KANBAN_TEST_BUDGET).toBe("60s");
    expect(env.KANBAN_TEST_FILES).toBeUndefined();
  });
});

describe("the gate message names the budget", () => {
  it("reports the budget, the estimate and what the CLOCK dropped, separately from the floor", () => {
    // Two drop counts, never summed: they name different knobs (`test_impact_budget` vs
    // `KANBAN_TEST_MIN_SCORE`), and a reader who cannot tell them apart cannot tell which to turn.
    const note = buildImpactSelectionNote({
      ...baseTier,
      impactSelection: {
        selectedCount: 143,
        belowFloorCount: 37,
        stale: false,
        selectionTier: "impact",
        budget: "60s",
        budgetDroppedCount: 12,
        estMs: 58_000,
      },
    });
    expect(note).toContain("budget 60s");
    expect(note).toContain("est 58s");
    expect(note).toContain("dropped 12 over budget");
    expect(note).toContain("dropped 37 below the score floor");
  });

  it("omits the budget clause entirely when no budget applied", () => {
    // Not a reassuring "dropped 0 over budget" for a run that had no clock at all.
    const note = buildImpactSelectionNote({
      ...baseTier,
      impactSelection: { selectedCount: 12, belowFloorCount: 151, stale: false, selectionTier: "impact" },
    });
    expect(note).not.toContain("budget");
    expect(note).toContain("kept 12 suite(s)");
  });

  it("still says UNKNOWN, not silence, when a budgeted selection could not be resolved", () => {
    expect(buildImpactSelectionNote({ ...baseTier, impactSelection: null })).toContain("selection UNKNOWN");
  });

  it("surfaces the whole clause in the passing gate message", () => {
    const message = buildGateTierMessage({
      ...baseTier,
      impactSelection: {
        selectedCount: 143,
        belowFloorCount: 37,
        stale: false,
        budget: "60s",
        budgetDroppedCount: 12,
        estMs: 58_000,
      },
    });
    expect(message).toContain("tier: impact-selected");
    expect(message).toContain("budget 60s");
    // A budgeted run must never read as though everything ran.
    expect(message).not.toContain("tier: full");
  });
});

describe("the selection the message describes is the selection the run makes", () => {
  it("passes --budget to `select`, after the base and the score floor", async () => {
    // An unbudgeted describing-call would report a `selected` set WIDER than what ran, and
    // `dropped 0 over budget` for every gate — the number whose whole purpose is to size what the
    // clock cut, structurally pinned at zero. Same failure shape as the #956 score-floor bug.
    //
    // A real directory holding the tool is needed because `resolveGateSelection` guards on
    // `existsSync(<dir>/.claude/skills/test-impact/tools/impact.mjs)`; this worktree has one, so
    // the repo root is used as the fixture rather than fabricating a tree.
    const workingDir = resolve(import.meta.dirname, "../../../..");
    if (!existsSync(join(workingDir, IMPACT_TOOL_RELATIVE_PATH))) return; // skill not materialized here

    let seenArgs: string[] = [];
    const selection = await resolveGateImpactSelection({
      applies: true,
      workingDir,
      baseBranch: "master",
      budget: "60s",
      runCommand: async ({ args }) => {
        seenArgs = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ tier: "impact", selected: ["a.test.ts"], changed: ["x.ts"], dropped: ["b.test.ts"], estMs: 58_000 }),
          stderr: "",
        };
      },
    });
    // Base FIRST and positional (#963), then the floor, then the budget.
    expect(seenArgs.slice(1)).toEqual(["select", "master", "--json", "--always-run", "--min-score", "1.0", "--budget", "60s"]);
    expect(selection).toMatchObject({ budget: "60s", budgetDroppedCount: 1, estMs: 58_000 });
  });

  it("omits --budget entirely when the project has none", async () => {
    const workingDir = resolve(import.meta.dirname, "../../../..");
    if (!existsSync(join(workingDir, IMPACT_TOOL_RELATIVE_PATH))) return;

    let seenArgs: string[] = [];
    const selection = await resolveGateImpactSelection({
      applies: true,
      workingDir,
      baseBranch: "master",
      budget: null,
      runCommand: async ({ args }) => {
        seenArgs = args;
        return { exitCode: 0, stdout: JSON.stringify({ tier: "impact", selected: [], changed: ["x.ts"] }), stderr: "" };
      },
    });
    expect(seenArgs).not.toContain("--budget");
    // ...and the message then has no budget clause to print.
    expect(selection?.budget).toBeUndefined();
  });

  it("parses the budget-dropped count and the estimate out of `select --json`", () => {
    const parsed = parseSelection(
      JSON.stringify({
        tier: "impact",
        selected: [{ test: "a.test.ts" }, { test: "b.test.ts" }],
        changed: ["src/x.ts"],
        belowFloor: ["c.test.ts"],
        dropped: ["d.test.ts", "e.test.ts"],
        estMs: 58_000,
        stale: false,
      }),
    );
    expect(parsed?.budgetDroppedCount).toBe(2);
    expect(parsed?.belowFloorCount).toBe(1);
    expect(parsed?.estMs).toBe(58_000);
  });

  it("reads a missing `dropped`/`estMs` as no budget drops rather than throwing", () => {
    const parsed = parseSelection(JSON.stringify({ tier: "impact", selected: ["a.test.ts"], changed: [] }));
    expect(parsed?.budgetDroppedCount).toBe(0);
    expect(parsed?.estMs).toBeUndefined();
  });
});

describe("memo safety — flipping the budget invalidates banked passes (#958 + #966)", () => {
  /**
   * The property, stated precisely: the budget must reach `selector-id` as a selection-affecting
   * FLAG. `selectorIdentity()` in `impact.mjs` folds `budgetMs` into the id, so two budgets yield
   * two ids and therefore two `verificationKey`s — but ONLY if it is passed. Nothing else in the
   * key can see it: the budget is a preference, not a tree fact, and `gateVerificationKey` folds
   * only tier + verify command + selector id. Miss this wiring and a pass banked under a 30s
   * budget replays under a 120s one — a level weakening verification invisibly.
   */
  function dbWithBudget(budget: string | null): Database {
    const rows = budget
      ? [{ key: testImpactBudgetPrefKey(PROJECT), value: budget, updatedAt: new Date().toISOString() }]
      : [];
    // `getAllPreferencesCached` caches per Database INSTANCE, so a fresh object per call is what
    // keeps these two resolutions independent rather than serving the first one's rows twice.
    return { select: () => ({ from: async () => rows }) } as unknown as Database;
  }

  /** Stands in for the real tool: the id is a hash OF the flags, which is the property under test. */
  const hashingSelectorId = (seen: string[][]) =>
    (async (input: { selectorArgs?: readonly string[] }) => {
      const args = [...(input.selectorArgs ?? [])];
      seen.push(args);
      return `ti1:${Buffer.from(args.join(" ")).toString("hex").padStart(8, "0")}`;
    }) as never;

  it("passes no selector flags when the budget is off — the pre-#966 key, byte for byte", async () => {
    const seen: string[][] = [];
    const result = await resolveGateVerification(PROJECT, dbWithBudget(null), {
      workingDir: "/tmp/wt",
      resolveSelectorIdFn: hashingSelectorId(seen),
    });
    expect(seen).toEqual([[]]);
    expect(result.budget).toBeNull();
  });

  it("passes --budget, and two different budgets produce two different verification keys", async () => {
    const seen: string[][] = [];
    const at60 = await resolveGateVerification(PROJECT, dbWithBudget("60s"), {
      workingDir: "/tmp/wt",
      resolveSelectorIdFn: hashingSelectorId(seen),
    });
    const at120 = await resolveGateVerification(PROJECT, dbWithBudget("120s"), {
      workingDir: "/tmp/wt",
      resolveSelectorIdFn: hashingSelectorId(seen),
    });

    expect(seen[0]).toEqual(["--budget", "60s"]);
    expect(seen[1]).toEqual(["--budget", "120s"]);
    expect(at60.budget?.ms).toBe(60_000);
    expect(at120.budget?.ms).toBe(120_000);
    // The whole point: the banked pass cannot be reused across the change.
    expect(at60.verificationKey).not.toBe(at120.verificationKey);
  });
});

describe("the builder loop gets the same budget as the gate", () => {
  const prefs = (budget: string) => async () => [{ key: testImpactBudgetPrefKey(PROJECT), value: budget }];

  it("exports the selector + budget into a BUILDER's env", async () => {
    const env = await withBuilderTestImpactBudget({ EXISTING: "1" }, true, PROJECT, {} as Database, {
      loadPrefs: prefs("60s"),
    });
    expect(env).toEqual({ EXISTING: "1", KANBAN_TEST_SELECTOR: "impact", KANBAN_TEST_BUDGET: "60s" });
  });

  it("leaves a review/verify/reconcile session's env untouched", async () => {
    // Narrowing what a REVIEWER could run is a weakening nobody asked for.
    const env = await withBuilderTestImpactBudget({ EXISTING: "1" }, false, PROJECT, {} as Database, {
      loadPrefs: prefs("60s"),
    });
    expect(env).toEqual({ EXISTING: "1" });
  });

  it("changes nothing when the project has no budget", async () => {
    const env = await withBuilderTestImpactBudget({ EXISTING: "1" }, true, PROJECT, {} as Database, {
      loadPrefs: async () => [],
    });
    expect(env).toEqual({ EXISTING: "1" });
  });

  it("fails toward OFF when the pref read throws, never toward a narrowed run", async () => {
    const env = await withBuilderTestImpactBudget({ EXISTING: "1" }, true, PROJECT, {} as Database, {
      loadPrefs: async () => { throw new Error("db down"); },
    });
    expect(env).toEqual({ EXISTING: "1" });
  });
});
