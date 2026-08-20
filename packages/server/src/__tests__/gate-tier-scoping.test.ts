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
  buildGateTierMessage,
  DEFAULT_VERIFY_GATE_STRATEGY,
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

  it("`scoped-base-watch` behaves as `scoped` until a base-health backstop exists", () => {
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

describe("the tier MESSAGE agrees with the tier that ran", () => {
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
