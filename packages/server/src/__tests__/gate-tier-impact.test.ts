import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFY_GATE_STRATEGY,
  VERIFY_GATE_STRATEGY_VALUES,
  buildGateTierMessage,
  buildImpactSelectionNote,
  buildVerifyEnv,
  resolveImpactSelectorEnv,
  resolveGateFileScopeEmission,
  resolveGateScoping,
  resolveGateTestSelector,
  resolveGateTier,
  type GateTierInfo,
} from "../services/pre-merge-gate-tier.js";
import { gateRanScope } from "../services/test-impact-outcome.service.js";
import { verifyGateStrategyPrefKey } from "../services/pre-merge-gate-tier.js";

/**
 * #956 — the `impact` gate tier: narrower than `scoped`, and OPT-IN.
 *
 * The two things worth pinning are the two things that could silently go wrong. First, that the
 * tier is not reachable by accident — its whole justification for existing before #954's miss-rate
 * corpus does is that no project selects it. Second, that a run under it cannot report as anything
 * WIDER than it was: the repo's rule is that a level may only weaken verification visibly, and this
 * is the level with the most to hide, since what it drops is a ranked guess rather than a provable
 * non-dependency.
 */

const baseTier: GateTierInfo = {
  strategy: "impact",
  selector: "impact",
  packageScoped: true,
  fileScoped: false,
  changedFileCount: 9,
  guardSuiteCount: 66,
  maxWorkers: 6,
};

describe("the impact tier is opt-in", () => {
  it("is a recognized strategy value", () => {
    expect(VERIFY_GATE_STRATEGY_VALUES).toContain("impact");
  });

  it("is nobody's default", () => {
    // The premise the whole ticket rests on: #954's corpus gates PROMOTING this tier, not its
    // existence, and that is only true while no project lands on it without asking.
    expect(DEFAULT_VERIFY_GATE_STRATEGY).toBe("full");
  });

  it("is not produced by any risk posture", () => {
    // A posture is a dial an operator moves for OTHER reasons (train size, review mode); if one of
    // them also yielded `impact`, a project would acquire a heuristic gate as a side effect of
    // asking for faster reviews. Every posture level must resolve to one of the provable tiers.
    for (const level of ["strict", "standard", "fast", "sprint"]) {
      const prefMap = new Map([[`risk_posture_p1`, level]]);
      const { strategy, fromPosture } = resolveGateTier(prefMap, "p1");
      expect(fromPosture).toBe(true);
      expect(strategy).not.toBe("impact");
    }
  });

  it("is selected only by an explicit per-project pref", () => {
    const prefMap = new Map([[verifyGateStrategyPrefKey("p1"), "impact"]]);
    const { strategy, fromPosture } = resolveGateTier(prefMap, "p1");
    expect(strategy).toBe("impact");
    expect(fromPosture).toBe(false);
  });
});

describe("resolveGateTestSelector", () => {
  it("selects the impact selector from the TIER, with no env var set", () => {
    expect(resolveGateTestSelector({}, "impact")).toBe("impact");
  });

  it("still honours the ambient env var for every other tier (#962)", () => {
    // An operator who exports it for the server process gets an impact-narrowed gate with no code
    // change, and that run must not record as full — #962's reason, unchanged by #956.
    expect(resolveGateTestSelector({ KANBAN_TEST_SELECTOR: "impact" }, "full")).toBe("impact");
    expect(resolveGateTestSelector({}, "full")).toBe("related");
    expect(resolveGateTestSelector({ KANBAN_TEST_SELECTOR: "nonsense" }, "scoped")).toBe("related");
  });
});

describe("resolveGateScoping under impact", () => {
  it("keeps the package scope", () => {
    // The selection replaces the FILE half only. Dropping the package scope too would widen the
    // run, which is not what an operator asking for the narrowest tier requested.
    const { packagesEnv } = resolveGateScoping({
      strategy: "impact",
      testScope: "server,shared",
      fileScopePref: true,
      changedFileCount: 9,
    });
    expect(packagesEnv).toBe("server,shared");
  });

  it("emits no KANBAN_TEST_FILES, because that pair is a refusal in the runner", () => {
    const { emitFileScope, note } = resolveGateFileScopeEmission({
      env: {},
      fileScoped: true,
      changedFileCount: 9,
      strategy: "impact",
    });
    expect(emitFileScope).toBe(false);
    // And it says WHICH knob chose it — under the tier, "KANBAN_TEST_SELECTOR is set" would name
    // an env var the operator never set and would send them looking in the wrong place.
    expect(note).toContain("verify_gate_strategy=impact");
    expect(note).toContain("impact-scoped, not full");
  });

  it("still blames the env var when the env var is what set it", () => {
    const { note } = resolveGateFileScopeEmission({
      env: { KANBAN_TEST_SELECTOR: "impact" },
      fileScoped: true,
      changedFileCount: 9,
      strategy: "full",
    });
    expect(note).toContain("KANBAN_TEST_SELECTOR=impact");
  });
});

describe("resolveImpactSelectorEnv", () => {
  const fileExists = () => true;

  it("is empty for every tier but impact", () => {
    for (const strategy of ["full", "scoped", "scoped-base-watch"] as const) {
      expect(
        resolveImpactSelectorEnv({ strategy, baseBranch: "master", changedFiles: ["a.test.ts"], fileExists }),
      ).toEqual({});
    }
  });

  it("passes the base, which is what makes it a selection at all", () => {
    // Without it `impact.mjs` computes an EMPTY change set on the clean committed tree a gate runs
    // against, and silently degrades to the constant always-run set while still calling itself a
    // selection — the #963 defect in a new place.
    const env = resolveImpactSelectorEnv({
      strategy: "impact",
      baseBranch: "master",
      changedFiles: [],
      fileExists,
    });
    expect(env.KANBAN_TEST_SELECTOR).toBe("impact");
    expect(env.KANBAN_IMPACT_BASE).toBe("master");
  });

  it("omits the base rather than passing an empty one when the workspace has none", () => {
    const env = resolveImpactSelectorEnv({ strategy: "impact", baseBranch: null, changedFiles: [], fileExists });
    expect(env).not.toHaveProperty("KANBAN_IMPACT_BASE");
    expect(env.KANBAN_TEST_SELECTOR).toBe("impact");
  });

  it("names the diff's test files, and only its test files", () => {
    const env = resolveImpactSelectorEnv({
      strategy: "impact",
      baseBranch: "master",
      changedFiles: ["packages/server/src/a.ts", "packages/server/src/__tests__/a.test.ts", "README.md"],
      fileExists,
    });
    expect(env.KANBAN_TEST_NEW_FILES).toBe("packages/server/src/__tests__/a.test.ts");
  });

  it("drops a DELETED test file, which would fail the package rather than widen the run", () => {
    // Handing vitest a missing path exits 1 with a bare `No test files found` — turning a
    // widening into a red gate.
    const env = resolveImpactSelectorEnv({
      strategy: "impact",
      baseBranch: "master",
      changedFiles: ["packages/server/src/__tests__/gone.test.ts"],
      fileExists: () => false,
    });
    expect(env).not.toHaveProperty("KANBAN_TEST_NEW_FILES");
  });
});

describe("buildVerifyEnv", () => {
  const isolationEnv = { AGENTIC_KANBAN_DIR: "/tmp/gate" };
  const impactEnv = { KANBAN_TEST_SELECTOR: "impact", KANBAN_IMPACT_BASE: "master" };

  it("never emits the selector and a file scope together", () => {
    // `test-mine.mjs` REFUSES that pair (exit 2, #962), so an assembly bug here would turn a merge
    // gate into a hard failure rather than a wrong-but-visible run. `emitFileScope` is already
    // false under the selector; this pins that the assembly does not reintroduce it.
    const env = buildVerifyEnv({
      isolationEnv,
      guardsOnly: false,
      impactEnv,
      packagesEnv: "server",
      emitFileScope: false,
      changedFiles: ["packages/server/src/a.ts"],
    });
    expect(env.KANBAN_TEST_SELECTOR).toBe("impact");
    expect(env).not.toHaveProperty("KANBAN_TEST_FILES");
    expect(env.KANBAN_TEST_PACKAGES).toBe("server");
  });

  it("keeps the guards-only run free of any selector, which it never reaches anyway", () => {
    const env = buildVerifyEnv({
      isolationEnv,
      guardsOnly: true,
      impactEnv,
      packagesEnv: "server",
      emitFileScope: true,
      changedFiles: ["docs/a.md"],
    });
    expect(env.KANBAN_TEST_GUARDS_ONLY).toBe("1");
    expect(env).not.toHaveProperty("KANBAN_TEST_SELECTOR");
    expect(env).not.toHaveProperty("KANBAN_TEST_PACKAGES");
  });

  it("still carries the selector when there is no package scope to attach it to", () => {
    // An unreadable or unmodeled diff sets no package scope. The tier's narrowing must survive
    // that, or an `impact` project would silently get a full run reported as impact-selected.
    const env = buildVerifyEnv({
      isolationEnv,
      guardsOnly: false,
      impactEnv,
      packagesEnv: null,
      emitFileScope: false,
      changedFiles: [],
    });
    expect(env.KANBAN_TEST_SELECTOR).toBe("impact");
    expect(env).not.toHaveProperty("KANBAN_TEST_PACKAGES");
  });

  it("reproduces the pre-#956 env exactly for a non-impact scoped run", () => {
    expect(
      buildVerifyEnv({
        isolationEnv,
        guardsOnly: false,
        impactEnv: {},
        packagesEnv: "server,shared",
        emitFileScope: true,
        changedFiles: ["packages/server/src/a.ts", "packages/shared/src/b.ts"],
      }),
    ).toEqual({
      AGENTIC_KANBAN_DIR: "/tmp/gate",
      KANBAN_TEST_PACKAGES: "server,shared",
      KANBAN_TEST_FILES: "packages/server/src/a.ts,packages/shared/src/b.ts",
    });
  });
});

describe("buildImpactSelectionNote", () => {
  it("names what was kept, what was dropped below the floor, and that the map was fresh", () => {
    const note = buildImpactSelectionNote({
      ...baseTier,
      impactSelection: { selectedCount: 12, belowFloorCount: 151, stale: false, selectionTier: "impact" },
    });
    expect(note).toContain("kept 12 suite(s)");
    expect(note).toContain("dropped 151 below the score floor");
    expect(note).toContain("selection tier impact");
    expect(note).toContain("map fresh");
  });

  it("reads DIFFERENTLY for a stale map", () => {
    // The ticket's explicit requirement: a selection made from a stale map is a weaker artifact —
    // the skill widens to the package tier and prints `[inventory STALE]` — and must not read the
    // same as one made from a fresh map.
    const fresh = buildImpactSelectionNote({
      ...baseTier,
      impactSelection: { selectedCount: 12, belowFloorCount: 151, stale: false },
    });
    const stale = buildImpactSelectionNote({
      ...baseTier,
      impactSelection: { selectedCount: 12, belowFloorCount: 151, stale: true },
    });
    expect(stale).not.toBe(fresh);
    expect(stale).toContain("map STALE");
    expect(fresh).not.toContain("STALE");
  });

  it("says UNKNOWN — loudly — when the selection could not be resolved", () => {
    // Omitting the field would read as "nothing was dropped", which is the one thing this tier may
    // never imply. An unstated narrowing is worse than a stated one.
    const note = buildImpactSelectionNote({ ...baseTier, impactSelection: null });
    expect(note).toContain("UNKNOWN");
    expect(note).toContain("unmeasured");
  });

  it("says nothing for a run that was not impact-selected", () => {
    expect(buildImpactSelectionNote({ ...baseTier, strategy: "scoped", selector: "related" })).toBeNull();
  });

  it("says nothing for a guards-only run, which never consults the selector", () => {
    // `KANBAN_TEST_GUARDS_ONLY` exits before the selector is reached in `test-mine.mjs`, so a
    // selection note there would describe a selection that never happened.
    expect(buildImpactSelectionNote({ ...baseTier, guardsOnly: true })).toBeNull();
  });
});

describe("buildGateTierMessage under the impact tier", () => {
  it("names the tier, the selection, the guards and the changed files", () => {
    const message = buildGateTierMessage({
      ...baseTier,
      impactSelection: { selectedCount: 12, belowFloorCount: 151, stale: false, selectionTier: "impact" },
    });
    expect(message).toContain("tier: impact-selected");
    expect(message).toContain("selector: impact (heuristic)");
    expect(message).toContain("kept 12 suite(s)");
    expect(message).toContain("dropped 151 below the score floor");
    expect(message).toContain("map fresh");
    expect(message).toContain("9 changed file(s)");
    // The guards are the set the tier did NOT narrow, so a tier that narrows this hard must name
    // them — this is the same "+N guard suites" figure the file-scoped tier already reports.
    expect(message).toContain("+66 guard suites");
  });

  it("never reports an impact run as package-scoped, even though the packages WERE scoped", () => {
    // `package-scoped` asserts that every suite in those packages ran. That is precisely what an
    // impact-selected run does not do, so the narrower and less provable name has to win.
    const message = buildGateTierMessage({ ...baseTier, packageScoped: true, impactSelection: null });
    expect(message).toContain("tier: impact-selected");
    expect(message).not.toContain("package-scoped");
  });

  it("never reports an impact run as full when nothing was package-scoped either", () => {
    const message = buildGateTierMessage({ ...baseTier, packageScoped: false, impactSelection: null });
    expect(message).toContain("tier: impact-selected");
    expect(message).not.toContain("tier: full");
  });

  it("leaves a non-impact message exactly as it was", () => {
    // The regression that matters most: every project stays on `full`/`scoped`, so their messages
    // must be byte-identical to before this tier existed.
    const message = buildGateTierMessage({
      strategy: "scoped",
      selector: "related",
      packageScoped: true,
      fileScoped: true,
      changedFileCount: 3,
      guardSuiteCount: 66,
      maxWorkers: 6,
    });
    expect(message).toBe("pre-merge gate passed (tier: file-scoped, 3 changed file(s), +66 guard suites, workers 6)");
  });
});

describe("gateRanScope under the impact tier", () => {
  it("records an impact-tier run as impact-scoped, never as full", () => {
    // The ledger half of the same rule: `full` would put the row in the miss-rate DENOMINATOR
    // while being structurally unable to witness a miss, driving the measured rate toward a
    // confident zero exactly on the runs the selector was in charge of.
    expect(gateRanScope({ ...baseTier, packageScoped: false, fileScoped: false })).toBe("impact-scoped");
    expect(gateRanScope({ ...baseTier, packageScoped: true })).toBe("impact-scoped");
  });

  it("still lets guards-only win", () => {
    expect(gateRanScope({ ...baseTier, guardsOnly: true })).toBe("guards-only");
  });
});
