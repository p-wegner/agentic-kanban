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
    // Dropping the package scope would widen the run, which is not what an operator asking for the
    // narrowest tier requested.
    const { packagesEnv } = resolveGateScoping({
      strategy: "impact",
      testScope: "server,shared",
      fileScopePref: true,
      changedFileCount: 9,
    });
    expect(packagesEnv).toBe("server,shared");
  });

  it("KEEPS the file scope, so the runner can union the two selectors (#967)", () => {
    // #962 made this pair a refusal; #967 retires that. The two selectors MISS different things --
    // `vitest related` is safe but blind to runtime reach (spawned scripts, fixtures, migrations),
    // the impact heuristic sees that reach but is a ranked bet under a floor and a budget. Emitting
    // only one of them silently gives up the other's coverage, so the file list now travels with the
    // selector and `test-mine.mjs` hands the derived suites to `select --union`.
    const { emitFileScope, unioned, note } = resolveGateFileScopeEmission({
      env: {},
      fileScoped: true,
      changedFileCount: 9,
      strategy: "impact",
    });
    expect(emitFileScope).toBe(true);
    expect(unioned).toBe(true);
    // And it says WHICH knob chose it -- under the tier, "KANBAN_TEST_SELECTOR is set" would name
    // an env var the operator never set and would send them looking in the wrong place.
    expect(note).toContain("verify_gate_strategy=impact");
    expect(note).toContain("UNIONED");
    // The ordering decision, stated where an operator reads it: OUR floor may not drop another
    // selector's evidence, but the budget must still hold over the union or the budget setting's
    // promise ("only these seconds") is broken.
    expect(note).toContain("exempt from the score floor");
    expect(note).toContain("counted against the budget");
    expect(note).toContain("impact+related, not full");
  });

  it("is not 'unioned' when there was no file scope to union with", () => {
    const { emitFileScope, unioned, note } = resolveGateFileScopeEmission({
      env: {},
      fileScoped: false,
      changedFileCount: 0,
      strategy: "impact",
    });
    expect(emitFileScope).toBe(false);
    expect(unioned).toBe(false);
    expect(note).toBeNull();
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

  it("omits the file scope when the resolver said not to emit one", () => {
    // The assembly obeys `emitFileScope` and nothing else -- it does not re-derive the decision
    // from the selector, which is what let the two halves disagree before #967.
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

  it("emits the selector AND the file scope together for a union run (#967)", () => {
    // The pair used to be a refusal (exit 2, #962). It is now the instruction that MAKES the union:
    // `test-mine.mjs` reads the file list, derives the suites `vitest related` would pick for it,
    // and passes them to `select --union`. Dropping either half here silently drops one selector.
    const env = buildVerifyEnv({
      isolationEnv,
      guardsOnly: false,
      impactEnv,
      packagesEnv: "server",
      emitFileScope: true,
      changedFiles: ["packages/server/src/a.ts", "packages/shared/src/b.ts"],
    });
    expect(env.KANBAN_TEST_SELECTOR).toBe("impact");
    expect(env.KANBAN_TEST_FILES).toBe("packages/server/src/a.ts,packages/shared/src/b.ts");
    expect(env.KANBAN_TEST_PACKAGES).toBe("server");
    // The base is what makes it a selection rather than the constant always-run set (#963).
    expect(env.KANBAN_IMPACT_BASE).toBe("master");
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

  it("splits the provenance when the union's size is known (#967)", () => {
    // The ticket's own example message. A combined selector that reports one number cannot be
    // audited: `kept 155` hides whether `related` contributed anything, and therefore whether the
    // union is doing the job it was added for.
    const note = buildImpactSelectionNote({
      ...baseTier,
      fileScoped: true,
      impactSelection: {
        selectedCount: 155,
        externalCount: 12,
        belowFloorCount: 90,
        stale: false,
        budget: "60s",
        estMs: 58_000,
        budgetDroppedCount: 4,
      },
    });
    expect(note).toContain("kept 155 suite(s) (impact 143 + related added 12)");
    expect(note).toContain("budget 60s");
    expect(note).toContain("est 58s");
    expect(note).toContain("dropped 4 over budget");
    // The floor still applies -- to the impact-scored candidates only, which is the whole point of
    // externals entering AFTER the floor and BEFORE the budget cut inside `impact.mjs`.
    expect(note).toContain("dropped 90 below the score floor");
  });

  it("reports 'related added 0' rather than hiding it (#967)", () => {
    // A real answer: the impact ranking had already picked everything `related` named. That is
    // evidence the heuristic is doing well, and it must not read the same as "no union ran".
    const note = buildImpactSelectionNote({
      ...baseTier,
      fileScoped: true,
      impactSelection: { selectedCount: 12, externalCount: 0, belowFloorCount: 151, stale: false },
    });
    expect(note).toContain("impact 12 + related added 0");
  });

  it("labels a union whose size it could not measure as a LOWER BOUND (#967)", () => {
    // The board's descriptive `select --json` call cannot pass the union list: `vitest related`'s
    // picks come out of vitest's own per-package module graph, walked in the worktree at run time.
    // Printing the impact half as the whole selection would understate what ran -- the flattering
    // direction, and therefore the one this tier may never take silently.
    const note = buildImpactSelectionNote({
      ...baseTier,
      fileScoped: true,
      impactSelection: { selectedCount: 12, belowFloorCount: 151, stale: false, unionUnmeasured: true },
    });
    expect(note).toContain("12 impact suite(s)");
    expect(note).toContain("lower bound");
  });

  it("leaves an impact-only run's note exactly as #956 wrote it", () => {
    const note = buildImpactSelectionNote({
      ...baseTier,
      impactSelection: { selectedCount: 12, belowFloorCount: 151, stale: false },
    });
    expect(note).toContain("kept 12 suite(s)");
    expect(note).not.toContain("related added");
    expect(note).not.toContain("lower bound");
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

  it("names a union run 'impact+related', because that is the selector it ran (#967)", () => {
    // Two selectors ran, so `impact-selected` would name only half of what chose the suites --
    // and #954's corpus judges the COMBINED selector, which is the thing the setting ships.
    const message = buildGateTierMessage({
      ...baseTier,
      fileScoped: true,
      changedFileCount: 3,
      impactSelection: { selectedCount: 155, externalCount: 12, belowFloorCount: 90, stale: false },
    });
    expect(message).toContain("tier: impact+related");
    // ASCII on purpose: this string travels through merge comments, PowerShell hosts and log files
    // on a Windows box, where a `∪` comes back mojibake from the first tool that guesses an encoding.
    expect(message).toContain("selector: impact (heuristic) UNION related");
    expect(message).toContain("impact 143 + related added 12");
    // Still never `file-scoped`: that name asserts every suite reachable from those files ran, and
    // a union under a floor and a budget does not promise that.
    expect(message).not.toContain("tier: file-scoped");
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

  it("records a union run under its OWN name, not as impact alone (#967)", () => {
    // The ledger has to judge what actually selected the suites. `impact-scoped` would credit (or
    // blame) the heuristic for a set that `vitest related` also contributed to, so a union run is
    // its own `ran` value -- still a non-witness for the miss-rate corpus, but a distinct one.
    expect(gateRanScope({ ...baseTier, packageScoped: true, fileScoped: true })).toBe("impact+related");
    expect(gateRanScope({ ...baseTier, packageScoped: false, fileScoped: true })).toBe("impact+related");
  });

  it("still lets guards-only win", () => {
    expect(gateRanScope({ ...baseTier, guardsOnly: true })).toBe("guards-only");
  });
});
