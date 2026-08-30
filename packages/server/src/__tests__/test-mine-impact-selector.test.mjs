// @gate:always-run - exercises the impact-selector derivation in `scripts/test-mine.mjs`, a repo
// script outside this suite's own import graph (same reason as test-mine-scope-derivation).
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  IMPACT_CLI_CANDIDATES,
  packageLabelByDir,
  parseImpactSelection,
  resolveImpactCli,
  runImpactSelector,
  PACKAGES,
} from "../../../../scripts/test-mine.mjs";

/**
 * #951 — `KANBAN_TEST_SELECTOR=impact` shells out to the test-impact skill and consumes its
 * `--format pkgfile` output (`<packageDir>:<path relative to that package>` per line). These
 * tests exercise the pure parsing/resolution directly, never spawning the real skill.
 */
describe("parseImpactSelection", () => {
  it("maps package DIRECTORIES back to the labels vitest is run under", () => {
    const stdout = [
      "packages/server:src/__tests__/a.test.ts",
      "packages/shared:__tests__/b.test.ts",
    ].join("\n");
    const { byLabel, unknown } = parseImpactSelection(stdout);
    expect(byLabel.get("server")).toEqual(["src/__tests__/a.test.ts"]);
    expect(byLabel.get("shared")).toEqual(["__tests__/b.test.ts"]);
    expect(unknown).toEqual([]);
  });

  it("ignores the skill's own [test-impact] summary/escalation lines on stdout", () => {
    const stdout = [
      "[test-impact] tier: file, 1 changed file(s), 6 test file(s) selected (151 below --min-score 1)",
      "packages/server:src/__tests__/a.test.ts",
    ].join("\n");
    expect(parseImpactSelection(stdout).byLabel.get("server")).toEqual(["src/__tests__/a.test.ts"]);
  });

  it("reports an unknown package directory instead of silently dropping it", () => {
    // A suite this runner cannot execute must be VISIBLE — swallowing it would report a green
    // for tests that never ran.
    const { byLabel, unknown } = parseImpactSelection("packages/desktop:src/__tests__/x.test.ts");
    expect(byLabel.size).toBe(0);
    expect(unknown).toEqual(["packages/desktop:src/__tests__/x.test.ts"]);
  });

  it("dedupes repeated entries and normalises backslashes", () => {
    const stdout = [
      "packages/server:src\\__tests__\\a.test.ts",
      "packages/server:src/__tests__/a.test.ts",
    ].join("\n");
    expect(parseImpactSelection(stdout).byLabel.get("server")).toEqual(["src/__tests__/a.test.ts"]);
  });

  it("returns an empty map for empty or whitespace-only output", () => {
    expect(parseImpactSelection("").byLabel.size).toBe(0);
    expect(parseImpactSelection("\n  \n").byLabel.size).toBe(0);
  });

  it("covers every package this runner runs, so no label is structurally unreachable", () => {
    const byDir = packageLabelByDir();
    for (const pkg of PACKAGES) {
      expect(byDir.get(pkg.dir)).toBe(pkg.label);
    }
  });
});

describe("resolveImpactCli", () => {
  const root = "/repo";

  it("prefers the worktree copy the board materialises into .claude/skills", () => {
    // The instruction handed to builder agents names this path, so it must be the one the
    // runner uses too — a $HOME path is not worktree-safe.
    expect(IMPACT_CLI_CANDIDATES[0]).toBe(".claude/skills/test-impact/tools/impact.mjs");
  });

  it("returns null when the skill is installed nowhere (so the caller fails open)", () => {
    expect(resolveImpactCli(root, "")).toBeNull();
  });
});

describe("runImpactSelector fail-open", () => {
  const cli = resolve("/repo", ".claude/skills/test-impact/tools/impact.mjs");

  it("returns null when the selector cannot start", () => {
    const spawnFn = () => ({ error: new Error("ENOENT"), status: null, stdout: "", stderr: "" });
    expect(runImpactSelector({ cli, spawnFn })).toBeNull();
  });

  it("returns null on a non-zero exit", () => {
    const spawnFn = () => ({ status: 2, stdout: "packages/server:src/__tests__/a.test.ts", stderr: "" });
    expect(runImpactSelector({ cli, spawnFn })).toBeNull();
  });

  it("returns null on an EMPTY selection — a green from that would assert nothing", () => {
    const spawnFn = () => ({ status: 0, stdout: "[test-impact] 0 test file(s) selected\n", stderr: "" });
    expect(runImpactSelector({ cli, spawnFn })).toBeNull();
  });

  it("returns the label map on a successful selection", () => {
    const spawnFn = () => ({ status: 0, stdout: "packages/server:src/__tests__/a.test.ts\n", stderr: "" });
    const scope = runImpactSelector({ cli, spawnFn });
    expect(scope?.get("server")).toEqual(["src/__tests__/a.test.ts"]);
  });

  it("asks for pkgfile output at the configured floor, and does NOT rebuild the map by default", () => {
    // `--rebuild-if-stale` in a WORKTREE writes a worktree-local docs/tests/impact-map.json:
    // it helps nobody, lands in the branch diff, and breaks #952's single-writer property.
    // Keeping the map fresh is #952's job on the main checkout.
    /** @type {string[]} */
    let seen = [];
    const spawnFn = (_exe, args) => {
      seen = args;
      return { status: 0, stdout: "packages/server:src/__tests__/a.test.ts\n", stderr: "" };
    };
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: false, spawnFn });
    expect(seen.slice(1)).toEqual(["select", "--format", "pkgfile", "--min-score", "1.0"]);
    expect(seen).not.toContain("--rebuild-if-stale");
  });

  it("passes --rebuild-if-stale only when explicitly opted in", () => {
    /** @type {string[]} */
    let seen = [];
    const spawnFn = (_exe, args) => {
      seen = args;
      return { status: 0, stdout: "packages/server:src/__tests__/a.test.ts\n", stderr: "" };
    };
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: true, spawnFn });
    expect(seen).toContain("--rebuild-if-stale");
  });
});
