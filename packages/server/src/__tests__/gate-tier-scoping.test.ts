/**
 * #643 — `full` was not full.
 *
 * `pre-merge-gate-tier.ts` documents the tiers as: `full` = "no scoping; every package's full
 * suite runs (safest, slowest)". The code only ever disabled FILE-level scoping —
 * `KANBAN_TEST_PACKAGES` was set regardless of strategy — so on the DEFAULT setting a diff
 * still skipped whole packages while the operator-facing knob claimed it did not.
 *
 * That gap matters more here than it would elsewhere: this pref exists precisely so a level may
 * only weaken verification VISIBLY (#538). A knob whose name overstates what it does is the
 * failure mode the feature was built to prevent, arriving through the feature itself.
 *
 * `buildGateTierMessage` is exercised alongside, because the two must agree: what the gate DID
 * and what the gate SAYS it did are the same claim.
 */
import { describe, it, expect } from "vitest";
import {
  resolveGateScoping,
  resolveGateTestSelector,
  buildGateTierMessage,
  resolveBaseProbeDue,
  DEFAULT_VERIFY_GATE_STRATEGY,
  DEFAULT_BASE_PROBE_INTERVAL_MS,
  DEFAULT_BASE_PROBE_EVERY_N_TRAINS,
} from "../services/pre-merge-gate-tier.js";

const SCOPE = "shared,client";

describe("resolveGateScoping", () => {
  it("sets NO package scope on `full` — the tier means what it says", () => {
    expect(resolveGateScoping({ strategy: "full", testScope: SCOPE, fileScopePref: true, changedFileCount: 3 }))
      .toEqual({ packagesEnv: null, fileScoped: false });
  });

  it("is the DEFAULT strategy, so the default gate is now genuinely unscoped", () => {
    expect(DEFAULT_VERIFY_GATE_STRATEGY).toBe("full");
    const { packagesEnv } = resolveGateScoping({
      strategy: DEFAULT_VERIFY_GATE_STRATEGY, testScope: SCOPE, fileScopePref: true, changedFileCount: 3,
    });
    expect(packagesEnv).toBeNull();
  });

  it("scopes packages AND files on `scoped`", () => {
    expect(resolveGateScoping({ strategy: "scoped", testScope: SCOPE, fileScopePref: true, changedFileCount: 3 }))
      .toEqual({ packagesEnv: SCOPE, fileScoped: true });
  });

  it("`scoped-base-watch` scopes the per-train gate exactly like `scoped`", () => {
    // The per-train gate itself stays narrow under scoped-base-watch (#916) — what makes the
    // strategy REAL is the separate scheduled base probe (resolveBaseProbeDue below), not a
    // difference in this function's output.
    expect(resolveGateScoping({ strategy: "scoped-base-watch", testScope: SCOPE, fileScopePref: true, changedFileCount: 3 }))
      .toEqual(resolveGateScoping({ strategy: "scoped", testScope: SCOPE, fileScopePref: true, changedFileCount: 3 }));
  });

  it("never file-scopes where it did not package-scope — file scoping is strictly narrower", () => {
    // Diff unreadable / unmodeled: `testPackagesEnvValue` refused, so nothing may narrow.
    expect(resolveGateScoping({ strategy: "scoped", testScope: null, fileScopePref: true, changedFileCount: 5 }))
      .toEqual({ packagesEnv: null, fileScoped: false });
    // …and the same on `full`, where the package scope was deliberately dropped.
    expect(resolveGateScoping({ strategy: "full", testScope: SCOPE, fileScopePref: true, changedFileCount: 5 }).fileScoped)
      .toBe(false);
  });

  it("honours verify_file_scope=false as package-scoping only", () => {
    expect(resolveGateScoping({ strategy: "scoped", testScope: SCOPE, fileScopePref: false, changedFileCount: 3 }))
      .toEqual({ packagesEnv: SCOPE, fileScoped: false });
  });

  it("does not file-scope on an empty changed-file list (nothing to relate against)", () => {
    expect(resolveGateScoping({ strategy: "scoped", testScope: SCOPE, fileScopePref: true, changedFileCount: 0 }).fileScoped)
      .toBe(false);
  });
});

describe("resolveBaseProbeDue (#916 — scoped-base-watch's actual backstop)", () => {
  it("is never due for any strategy other than scoped-base-watch", () => {
    expect(resolveBaseProbeDue({ strategy: "full", lastProbeAgeMs: null, trainsSinceLastProbe: 999 }).due).toBe(false);
    expect(resolveBaseProbeDue({ strategy: "scoped", lastProbeAgeMs: null, trainsSinceLastProbe: 999 }).due).toBe(false);
  });

  it("is due when no probe has ever run — 'never' must not read as 'recent'", () => {
    const result = resolveBaseProbeDue({ strategy: "scoped-base-watch", lastProbeAgeMs: null, trainsSinceLastProbe: 0 });
    expect(result.due).toBe(true);
    expect(result.ageLabel).toBe("never");
  });

  it("is due once the interval elapses", () => {
    expect(resolveBaseProbeDue({
      strategy: "scoped-base-watch", lastProbeAgeMs: DEFAULT_BASE_PROBE_INTERVAL_MS + 1, trainsSinceLastProbe: 0,
    }).due).toBe(true);
    expect(resolveBaseProbeDue({
      strategy: "scoped-base-watch", lastProbeAgeMs: DEFAULT_BASE_PROBE_INTERVAL_MS - 1, trainsSinceLastProbe: 0,
    }).due).toBe(false);
  });

  it("is due once N trains have landed since the last probe, even if recent", () => {
    expect(resolveBaseProbeDue({
      strategy: "scoped-base-watch", lastProbeAgeMs: 1000, trainsSinceLastProbe: DEFAULT_BASE_PROBE_EVERY_N_TRAINS,
    }).due).toBe(true);
    expect(resolveBaseProbeDue({
      strategy: "scoped-base-watch", lastProbeAgeMs: 1000, trainsSinceLastProbe: DEFAULT_BASE_PROBE_EVERY_N_TRAINS - 1,
    }).due).toBe(false);
  });

  it("honours explicit interval/count overrides", () => {
    expect(resolveBaseProbeDue({
      strategy: "scoped-base-watch", lastProbeAgeMs: 5000, trainsSinceLastProbe: 0, intervalMs: 1000,
    }).due).toBe(true);
  });

  it("formats the age label for the gate message", () => {
    expect(resolveBaseProbeDue({ strategy: "scoped-base-watch", lastProbeAgeMs: 5 * 60_000, trainsSinceLastProbe: 0 }).ageLabel).toBe("5m");
    expect(resolveBaseProbeDue({ strategy: "scoped-base-watch", lastProbeAgeMs: 3 * 60 * 60_000, trainsSinceLastProbe: 0 }).ageLabel).toBe("3h");
  });
});

describe("resolveGateTestSelector (#962)", () => {
  it("recognizes only `impact`, case- and whitespace-insensitively", () => {
    expect(resolveGateTestSelector({ KANBAN_TEST_SELECTOR: "impact" })).toBe("impact");
    expect(resolveGateTestSelector({ KANBAN_TEST_SELECTOR: "  Impact " })).toBe("impact");
  });

  it("falls back to `related` for absent, empty or unrecognized values", () => {
    // Mirrors `scripts/test-mine.mjs`, which warns and uses `vitest related` for an unknown
    // value. The two must agree, or the ledger would name a selector that never ran.
    expect(resolveGateTestSelector({})).toBe("related");
    expect(resolveGateTestSelector({ KANBAN_TEST_SELECTOR: "" })).toBe("related");
    expect(resolveGateTestSelector({ KANBAN_TEST_SELECTOR: "vitest-related" })).toBe("related");
  });
});

describe("the tier MESSAGE agrees with the tier that ran", () => {
  it("names the impact selector, because the tier name alone does not carry it (#962)", () => {
    // `tier: full` + the impact selector reads as "everything ran". A level may only weaken
    // verification VISIBLY, and a ranked heuristic choosing the suites is a materially weaker
    // claim than an import-graph closure — so the message has to say which was in charge.
    const msg = buildGateTierMessage({
      strategy: "full", selector: "impact", packageScoped: false, fileScoped: false,
      changedFileCount: 4, guardSuiteCount: 7, maxWorkers: 6,
    });
    expect(msg).toContain("selector: impact (heuristic)");
  });

  it("stays silent about the DEFAULT selector, so the field means something when present", () => {
    for (const selector of ["related", undefined] as const) {
      const msg = buildGateTierMessage({
        strategy: "full", selector, packageScoped: false, fileScoped: false,
        changedFileCount: 4, guardSuiteCount: 7, maxWorkers: 6,
      });
      expect(msg).not.toContain("selector:");
    }
  });

  it("does not claim a selector on a guards-only run, which never consults one", () => {
    const msg = buildGateTierMessage({
      strategy: "full", selector: "impact", packageScoped: false, fileScoped: false, guardsOnly: true,
      changedFileCount: 2, guardSuiteCount: 16, maxWorkers: 6,
    });
    expect(msg).not.toContain("selector:");
  });

  it("says `full` for a full-strategy run, not `package-scoped`", () => {
    const { packagesEnv, fileScoped } = resolveGateScoping({
      strategy: "full", testScope: SCOPE, fileScopePref: true, changedFileCount: 4,
    });
    const msg = buildGateTierMessage({
      strategy: "full", packageScoped: Boolean(packagesEnv), fileScoped,
      changedFileCount: 4, guardSuiteCount: 7, maxWorkers: 6,
    });
    expect(msg).toContain("tier: full");
    expect(msg).not.toContain("package-scoped");
    // Guard-suite count is only meaningful when file scoping dropped suites.
    expect(msg).not.toContain("guard suites");
  });

  it("names file-scoping and its guard-suite top-up when that is what ran", () => {
    const msg = buildGateTierMessage({
      strategy: "scoped", packageScoped: true, fileScoped: true,
      changedFileCount: 3, guardSuiteCount: 14, maxWorkers: 6,
    });
    expect(msg).toContain("tier: file-scoped");
    expect(msg).toContain("3 changed file(s)");
    expect(msg).toContain("+14 guard suites");
  });

  // A docs-only diff used to skip verification entirely and report "pre-merge gate skipped —
  // docs-only diff", which read as "nothing could have broken" while the markdown-reading
  // @gate:always-run suites were exactly what went unrun. It now runs those guards, so the
  // message must name the narrower tier rather than passing as an ordinary run.
  it("names `base probe <age>` under scoped-base-watch (#916 acceptance criterion)", () => {
    const msg = buildGateTierMessage({
      strategy: "scoped-base-watch", packageScoped: true, fileScoped: true,
      changedFileCount: 3, guardSuiteCount: 14, maxWorkers: 6,
      baseProbeAgeLabel: "2h", baseProbeDue: false,
    });
    expect(msg).toContain("base probe 2h");
    expect(msg).not.toContain("due now");
  });

  it("says 'due now' when the base probe backstop is overdue", () => {
    const msg = buildGateTierMessage({
      strategy: "scoped-base-watch", packageScoped: true, fileScoped: true,
      changedFileCount: 3, guardSuiteCount: 14, maxWorkers: 6,
      baseProbeAgeLabel: "never", baseProbeDue: true,
    });
    expect(msg).toContain("base probe never, due now");
  });

  it("does not mention a base probe for `scoped` — that backstop is scoped-base-watch only", () => {
    const msg = buildGateTierMessage({
      strategy: "scoped", packageScoped: true, fileScoped: true,
      changedFileCount: 3, guardSuiteCount: 14, maxWorkers: 6,
    });
    expect(msg).not.toContain("base probe");
  });

  it("names the guards-only tier for a docs-only diff", () => {
    const msg = buildGateTierMessage({
      strategy: "full", packageScoped: false, fileScoped: false, guardsOnly: true,
      changedFileCount: 2, guardSuiteCount: 16, maxWorkers: 6,
    });
    expect(msg).toContain("tier: guards-only (docs-only diff)");
    expect(msg).toContain("16 guard suites");
    // Must not read as a full run — that is the dishonesty this tier exists to avoid.
    expect(msg).not.toContain("tier: full");
  });
});
