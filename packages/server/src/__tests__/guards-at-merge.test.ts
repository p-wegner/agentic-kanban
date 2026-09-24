// @gate:always-run when:packages/server/src/services/guards-at-merge.ts,packages/server/src/services/always-run-guard-floor.ts,packages/server/src/services/pre-merge-gate-tier.ts
// — asserts the gate's own honesty contract for the guards mode (a level may only weaken
// verification VISIBLY) against the modules it imports; marked by policy, like gate-tier-scoping.
/**
 * #1232 — under the `iterate` posture a merge paid the whole unconditional `@gate:always-run`
 * floor (~585s pinned) on top of a ~2-file impact selection. `guardsAtMerge` is the gate-side
 * setting that defers that floor to the base sweep: derived from the posture (`iterate` ->
 * `intersecting`, everything else -> `all`), overridable per project by `guards_at_merge_<id>`,
 * read through ONE resolver, carried to the runner as `KANBAN_TEST_GUARDS`, priced in the pass
 * message, and folded into the verification key so a deferred-floor pass cannot be replayed as a
 * full one.
 *
 * The property every case below defends: `standard`/`strict`/`fast`/`sprint` are byte-for-byte
 * untouched — no env var, no message change, no key change.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RISK_POSTURES } from "@agentic-kanban/shared/lib/risk-posture";
import { riskPosturePrefKey } from "../services/risk-posture.service.js";
import {
  guardsAtMergeEnv,
  guardsAtMergeForPosture,
  guardsAtMergePrefKey,
  resolveGuardsAtMerge,
} from "../services/guards-at-merge.js";
import {
  buildGateTierMessage,
  buildGuardFloorClause,
  buildVerifyEnv,
  describeAlwaysRunGuards,
  guardFloorFor,
  type GateTierInfo,
} from "../services/pre-merge-gate-tier.js";
import { gateVerificationKey } from "../services/merge-gate-tree-memo.js";

const PID = "p-1232";
const prefs = (entries: Record<string, string> = {}): Map<string, string> => new Map(Object.entries(entries));
const posture = (level: string, extra: Record<string, string> = {}) =>
  prefs({ [riskPosturePrefKey(PID)]: level, ...extra });

describe("resolveGuardsAtMerge (#1232)", () => {
  it("`iterate` yields `intersecting`; every other level (and no posture) yields `all`", () => {
    expect(resolveGuardsAtMerge(posture("iterate"), PID)).toMatchObject({ guardsAtMerge: "intersecting", source: "posture" });
    for (const level of RISK_POSTURES.filter((l) => l !== "iterate")) {
      expect(resolveGuardsAtMerge(posture(level), PID), level).toMatchObject({ guardsAtMerge: "all", source: "posture" });
    }
    expect(resolveGuardsAtMerge(prefs(), PID)).toMatchObject({ guardsAtMerge: "all", source: "posture" });
    // The level -> mode table is one function, and it is the one the resolver uses.
    expect(guardsAtMergeForPosture({ level: "iterate" })).toBe("intersecting");
    expect(guardsAtMergeForPosture({ level: "standard" })).toBe("all");
  });

  it("the per-project pref wins in either direction", () => {
    expect(resolveGuardsAtMerge(posture("iterate", { [guardsAtMergePrefKey(PID)]: "all" }), PID))
      .toMatchObject({ guardsAtMerge: "all", source: "pref" });
    expect(resolveGuardsAtMerge(posture("standard", { [guardsAtMergePrefKey(PID)]: "intersecting" }), PID))
      .toMatchObject({ guardsAtMerge: "intersecting", source: "pref" });
    expect(resolveGuardsAtMerge(posture("standard", { [guardsAtMergePrefKey(PID)]: " Intersecting " }), PID).guardsAtMerge)
      .toBe("intersecting");
  });

  it("an unparseable pref is ignored with a warning and the posture decides — never a silent narrowing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveGuardsAtMerge(posture("standard", { [guardsAtMergePrefKey(PID)]: "some" }), PID))
        .toMatchObject({ guardsAtMerge: "all", source: "posture" });
      expect(resolveGuardsAtMerge(posture("iterate", { [guardsAtMergePrefKey(PID)]: "yes" }), PID))
        .toMatchObject({ guardsAtMerge: "intersecting", source: "posture" });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toMatch(/\[guards-at-merge\].*'some'/);
      // Empty = unset, not an error.
      expect(resolveGuardsAtMerge(posture("standard", { [guardsAtMergePrefKey(PID)]: "" }), PID).source).toBe("posture");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("is keyed on the registered prefix", () => {
    expect(guardsAtMergePrefKey(PID)).toBe(`guards_at_merge_${PID}`);
  });
});

describe("buildVerifyEnv carries the mode as KANBAN_TEST_GUARDS (#1232)", () => {
  const isolationEnv = { AGENTIC_KANBAN_DIR: "/tmp/gate" };
  const impactEnv = { KANBAN_TEST_SELECTOR: "impact", KANBAN_IMPACT_BASE: "master" };
  const base = { isolationEnv, guardsOnly: false, impactEnv, packagesEnv: "server", emitFileScope: true, changedFiles: ["packages/server/src/a.ts"] };

  it("emits nothing for `all` or when absent — a non-iterate project's env is byte-identical", () => {
    expect(guardsAtMergeEnv("all")).toEqual({});
    expect(guardsAtMergeEnv(undefined)).toEqual({});
    expect(buildVerifyEnv(base)).toEqual(buildVerifyEnv({ ...base, guardsAtMerge: "all" }));
    expect(buildVerifyEnv({ ...base, guardsAtMerge: "all" })).not.toHaveProperty("KANBAN_TEST_GUARDS");
  });

  it("emits `intersecting` in the impact arm AND the guards-only arm", () => {
    expect(buildVerifyEnv({ ...base, guardsAtMerge: "intersecting" }).KANBAN_TEST_GUARDS).toBe("intersecting");
    const docs = buildVerifyEnv({ ...base, guardsOnly: true, changedFiles: ["docs/a.md"], guardsAtMerge: "intersecting" });
    expect(docs.KANBAN_TEST_GUARDS).toBe("intersecting");
    expect(docs.KANBAN_TEST_GUARDS_ONLY).toBe("1");
    // And with no package scope to attach to.
    expect(buildVerifyEnv({ ...base, packagesEnv: null, guardsAtMerge: "intersecting" }).KANBAN_TEST_GUARDS).toBe("intersecting");
  });
});

describe("the guard floor under `intersecting` (#1232)", () => {
  function repoWith(): string {
    const root = mkdtempSync(join(tmpdir(), "ak-guards-at-merge-"));
    const dir = join(root, "packages", "server", "src", "__tests__");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bare.test.ts"), "// @gate:always-run\n");
    writeFileSync(join(dir, "always.test.ts"), "// @gate:always-run always — tree scanner\n");
    writeFileSync(join(dir, "routes.test.ts"), "// @gate:always-run when:packages/server/src/routes/**\n");
    writeFileSync(join(dir, "docs.test.ts"), "// @gate:always-run when:docs/**\n");
    return root;
  }

  it("describeAlwaysRunGuards defers bare + always markers and reports both numbers", () => {
    const root = repoWith();
    try {
      const changed = ["packages/server/src/routes/issues.ts"];
      expect(describeAlwaysRunGuards(root, { changedFiles: changed, guards: "intersecting" }))
        .toMatchObject({ count: 1, deferredCount: 2, totalCount: 4 });
      // `all` is today's rule: bare + always + the intersecting territory.
      expect(describeAlwaysRunGuards(root, { changedFiles: changed, guards: "all" }))
        .toMatchObject({ count: 3, deferredCount: 0, totalCount: 4 });
      expect(describeAlwaysRunGuards(root, { changedFiles: changed }).count).toBe(3);
      // An UNKNOWN change set forces everything under either mode — nothing is deferred.
      expect(describeAlwaysRunGuards(root, { changedFiles: [], guards: "intersecting" }))
        .toMatchObject({ count: 4, deferredCount: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("guardFloorFor fills the deferred/total fields only under `intersecting`", () => {
    const root = repoWith();
    try {
      const changed = ["packages/server/src/routes/issues.ts"];
      const all = guardFloorFor(root, changed, { narrowed: true, guardsAtMerge: "all" });
      expect(all.guardSuiteCount).toBe(3);
      expect(all).not.toHaveProperty("guardDeferredCount");
      expect(guardFloorFor(root, changed, { narrowed: true })).toEqual(all);
      const intersecting = guardFloorFor(root, changed, { narrowed: true, guardsAtMerge: "intersecting" });
      expect(intersecting).toMatchObject({ guardSuiteCount: 1, guardDeferredCount: 2, guardTotalCount: 4 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the pass message prices a deferred floor (#1232)", () => {
  const tierInfo: GateTierInfo = {
    strategy: "impact",
    selector: "impact",
    packageScoped: true,
    fileScoped: true,
    changedFileCount: 3,
    guardSuiteCount: 12,
    guardEstMs: 30_000,
    guardAssumedCount: 0,
    maxWorkers: 4,
  };

  it("names intersecting / total / deferred in the #1043 shape, with the cost estimate", () => {
    const clause = buildGuardFloorClause({ ...tierInfo, guardsAtMerge: "intersecting", guardDeferredCount: 196, guardTotalCount: 208 });
    expect(clause).toEqual(["guards: 12 intersecting of 208 (196 deferred to the base sweep) (~30s est)"]);
    const msg = buildGateTierMessage({ ...tierInfo, guardsAtMerge: "intersecting", guardDeferredCount: 196, guardTotalCount: 208 });
    expect(msg).toContain("guards: 12 intersecting of 208 (196 deferred to the base sweep)");
    expect(msg).not.toContain("guard suites");
  });

  it("says so even for a run no other narrowing applied to — deferral is a weakening in its own right", () => {
    const clause = buildGuardFloorClause({ ...tierInfo, selector: "related", fileScoped: false, packageScoped: false, guardsAtMerge: "intersecting", guardDeferredCount: 5, guardTotalCount: 6, guardSuiteCount: 1 });
    expect(clause[0]).toMatch(/^guards: 1 intersecting of 6 \(5 deferred to the base sweep\)/);
  });

  it("`all` and absent produce today's clause, unchanged", () => {
    const before = buildGateTierMessage(tierInfo);
    expect(buildGateTierMessage({ ...tierInfo, guardsAtMerge: "all" })).toBe(before);
    expect(before).toContain("+12 guard suites (~30s est) (forced floor; selected/full suites may include more)");
  });
});

describe("the verification key distinguishes a deferred-floor pass (#1232)", () => {
  it("`intersecting` changes the key; `all` leaves it byte-identical", () => {
    const base = gateVerificationKey("impact", "pnpm verify", "sel-1");
    expect(gateVerificationKey("impact", "pnpm verify", "sel-1")).toBe(base);
    expect(gateVerificationKey("impact", "pnpm verify", "sel-1|guards=intersecting")).not.toBe(base);
    // With no selector id at all the fold still yields a distinct, non-empty component.
    expect(gateVerificationKey("impact", "pnpm verify", "|guards=intersecting")).not.toBe(gateVerificationKey("impact", "pnpm verify", ""));
  });
});
