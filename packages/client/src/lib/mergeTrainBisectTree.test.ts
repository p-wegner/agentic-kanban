import { describe, expect, it } from "vitest";
import {
  buildBisectTree,
  computeBisectTreeStats,
  culpritPathLabels,
  culpritPaths,
  type MergeTrainAttemptDto,
} from "./mergeTrainBisectTree.js";

function attempt(overrides: Partial<MergeTrainAttemptDto> & { label: string }): MergeTrainAttemptDto {
  return {
    members: ["ws-1"],
    included: ["ws-1"],
    dropped: [],
    gateStartedAt: null,
    gateFinishedAt: null,
    gateRuns: 0,
    verdict: "landed",
    ...overrides,
  };
}

describe("buildBisectTree", () => {
  it("returns a single root for a happy-path train (one gate, no bisect)", () => {
    const roots = buildBisectTree([
      attempt({ label: "q1", members: ["ws-1", "ws-2"], gateRuns: 1, verdict: "landed" }),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toEqual([]);
    expect(roots[0].isCulprit).toBe(false);
  });

  it("attaches a/b children under their parent by label prefix", () => {
    const roots = buildBisectTree([
      attempt({ label: "q1", members: ["ws-1", "ws-2"], verdict: "red", gateRuns: 1 }),
      attempt({ label: "q1a", members: ["ws-1"], verdict: "landed", gateRuns: 1 }),
      attempt({ label: "q1b", members: ["ws-2"], verdict: "red", gateRuns: 1 }),
    ]);
    expect(roots).toHaveLength(1);
    const [root] = roots;
    expect(root.attempt.label).toBe("q1");
    expect(root.children.map((c) => c.attempt.label).sort()).toEqual(["q1a", "q1b"]);
  });

  it("attaches grandchildren (q1a -> q1aa/q1ab)", () => {
    const roots = buildBisectTree([
      attempt({ label: "q1", verdict: "red" }),
      attempt({ label: "q1a", verdict: "red" }),
      attempt({ label: "q1aa", verdict: "landed" }),
      attempt({ label: "q1ab", verdict: "red" }),
      attempt({ label: "q1b", verdict: "landed" }),
    ]);
    const root = roots[0];
    const q1a = root.children.find((c) => c.attempt.label === "q1a")!;
    expect(q1a.children.map((c) => c.attempt.label).sort()).toEqual(["q1aa", "q1ab"]);
  });

  it("treats an attempt whose parent label is absent as its own root (defensive against partial evidence)", () => {
    const roots = buildBisectTree([attempt({ label: "q1a", verdict: "landed" })]);
    expect(roots).toHaveLength(1);
    expect(roots[0].attempt.label).toBe("q1a");
  });

  it("computes gate duration from start/finish timestamps", () => {
    const roots = buildBisectTree([
      attempt({
        label: "q1",
        gateStartedAt: "2026-01-01T00:00:00.000Z",
        gateFinishedAt: "2026-01-01T00:05:00.000Z",
      }),
    ]);
    expect(roots[0].durationMs).toBe(5 * 60 * 1000);
  });

  it("reports null duration when no gate ran (assembly_empty)", () => {
    const roots = buildBisectTree([attempt({ label: "q1", verdict: "assembly_empty", gateRuns: 0 })]);
    expect(roots[0].durationMs).toBeNull();
  });
});

describe("culpritPaths / culpritPathLabels", () => {
  it("finds the path to each red leaf, ignoring env/refused/empty leaves", () => {
    const roots = buildBisectTree([
      attempt({ label: "q1", verdict: "red" }),
      attempt({ label: "q1a", verdict: "env_failure" }),
      attempt({ label: "q1b", verdict: "red" }),
    ]);
    const paths = culpritPaths(roots);
    expect(paths).toHaveLength(1);
    expect(paths[0].map((n) => n.attempt.label)).toEqual(["q1", "q1b"]);

    const labels = culpritPathLabels(roots);
    expect(labels).toEqual(new Set(["q1", "q1b"]));
  });

  it("finds no culprit path when nothing was individually gate-rejected", () => {
    const roots = buildBisectTree([attempt({ label: "q1", verdict: "landed" })]);
    expect(culpritPaths(roots)).toEqual([]);
    expect(culpritPathLabels(roots).size).toBe(0);
  });

  it("finds two culprit paths for a train with two bad members", () => {
    const roots = buildBisectTree([
      attempt({ label: "q1", verdict: "red" }),
      attempt({ label: "q1a", verdict: "red" }),
      attempt({ label: "q1b", verdict: "red" }),
    ]);
    const paths = culpritPaths(roots);
    expect(paths.map((p) => p.map((n) => n.attempt.label))).toEqual([
      ["q1", "q1a"],
      ["q1", "q1b"],
    ]);
  });
});

describe("computeBisectTreeStats", () => {
  it("sums gate runs and duration across the whole tree", () => {
    const roots = buildBisectTree([
      attempt({
        label: "q1",
        members: ["ws-1", "ws-2"],
        verdict: "red",
        gateRuns: 1,
        gateStartedAt: "2026-01-01T00:00:00.000Z",
        gateFinishedAt: "2026-01-01T00:10:00.000Z",
      }),
      attempt({
        label: "q1a",
        members: ["ws-1"],
        verdict: "landed",
        gateRuns: 1,
        gateStartedAt: "2026-01-01T00:10:00.000Z",
        gateFinishedAt: "2026-01-01T00:15:00.000Z",
      }),
      attempt({
        label: "q1b",
        members: ["ws-2"],
        verdict: "red",
        gateRuns: 1,
        gateStartedAt: "2026-01-01T00:15:00.000Z",
        gateFinishedAt: "2026-01-01T00:20:00.000Z",
      }),
    ]);
    const stats = computeBisectTreeStats(roots);
    expect(stats.totalGateRuns).toBe(3);
    expect(stats.nodeCount).toBe(3);
    expect(stats.culpritCount).toBe(1);
    expect(stats.totalGateDurationMs).toBe(10 * 60 * 1000 + 5 * 60 * 1000 + 5 * 60 * 1000);
  });

  it("computes a zero counterfactual delta for a happy-path train (one gate covers the whole batch either way)", () => {
    const roots = buildBisectTree([
      attempt({
        label: "q1",
        members: ["ws-1", "ws-2", "ws-3"],
        verdict: "landed",
        gateRuns: 1,
        gateStartedAt: "2026-01-01T00:00:00.000Z",
        gateFinishedAt: "2026-01-01T00:09:00.000Z",
      }),
    ]);
    const stats = computeBisectTreeStats(roots);
    // Sequential-per-member cost extrapolated from the one gate that covered all 3 members —
    // for the happy path this equals the actual cost (no bisect happened to inflate it).
    expect(stats.sequentialCounterfactualMs).toBe(stats.totalGateDurationMs);
  });

  it("returns zeroed stats for an empty tree", () => {
    const stats = computeBisectTreeStats([]);
    expect(stats).toEqual({
      totalGateRuns: 0,
      totalGateDurationMs: 0,
      sequentialCounterfactualMs: 0,
      culpritCount: 0,
      nodeCount: 0,
    });
  });
});
