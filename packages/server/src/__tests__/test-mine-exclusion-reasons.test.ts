// @gate:always-run — imports `scripts/test-mine.mjs`, which lives outside this package's
// source tree, so a file-scoped run cannot see a change to the exclusion list it checks.
//
// #679. `scripts/test-mine.mjs` IS the pre-merge gate's test half, so every glob in its
// exclusion list is a hole in the gate. `ae6de9b34d` — the commit that pointed the gate at
// `test:mine` — added 12 of the then-17 exclusions in one go: the gate was made cheap and
// blinded to the suites guarding what it protects, in the same change.
//
// The list could only grow, because nothing distinguished the two kinds of entry. An
// exclusion is LEGITIMATE when the suite needs something the gate box may not have or cannot
// share under parallelism — a real `git` process, a docker daemon, a spawned CLI. It is NOT
// legitimate merely because the suite is slow: six of the excluded server suites ran on
// in-memory SQLite with an injected gitService and had no environmental excuse at all, and
// what they cover had each already shipped as a bug once.
//
// A comment above the list cannot enforce that, because a comment drifts away from the entry
// it was written for — which is exactly what happened. The reason is therefore part of the
// entry, and this asserts every entry has one that says something.

import { describe, expect, it } from "vitest";
import { PACKAGES } from "../../../../scripts/test-mine.mjs";

/**
 * Words that name a resource the gate box may not have or cannot share. An exclusion whose
 * reason contains none of these is asserting nothing checkable — most likely "it is slow",
 * which is the case this guard exists to reject.
 */
const ENVIRONMENTAL = [
  "git",
  "docker",
  "daemon",
  "spawn",
  "child process",
  "binary",
  "transport",
  "parallelism",
];

const entries = PACKAGES.flatMap((pkg) =>
  pkg.exclude.map((entry) => ({ label: pkg.label, ...entry })),
);

describe("every test:mine exclusion carries an environmental reason (#679)", () => {
  it("finds the exclusion list at all, so the scan cannot pass vacuously", () => {
    expect(PACKAGES.map((p) => p.label).sort()).toEqual(["client", "mcp-server", "server", "shared"]);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("gives every excluded glob a reason", () => {
    const missing = entries.filter((e) => !e.reason || e.reason.trim().length < 15);
    expect(
      missing.map((e) => `${e.label}: ${e.glob}`),
      "An exclusion is a hole in the pre-merge gate. Say what the suite needs that the gate " +
        "box may not have — not that it is slow.",
    ).toEqual([]);
  });

  it("rejects a reason that names no environmental need", () => {
    const unjustified = entries.filter(
      (e) => !ENVIRONMENTAL.some((word) => e.reason.toLowerCase().includes(word)),
    );
    expect(
      unjustified.map((e) => `${e.label}: ${e.glob} — "${e.reason}"`),
      "These exclusions give a reason that names no real git/docker/spawned-process need.\n" +
        "'Slow' is not a reason to leave a suite out of the gate: scope it, speed it up, or\n" +
        "state the resource it actually requires.",
    ).toEqual([]);
  });

  it("keeps the server list at the audited size, so a silent regrowth is visible", () => {
    // #679 cut this from 13 to 6. A NEW server exclusion is a deliberate act that must
    // update this number and carry an argument — the growth from 5 to 17 happened because
    // nothing here had to change.
    const server = PACKAGES.find((p) => p.label === "server");
    expect(server?.exclude.length).toBeLessThanOrEqual(6);
  });
});
