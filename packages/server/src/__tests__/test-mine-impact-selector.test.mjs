// @gate:always-run - exercises the impact-selector derivation in `scripts/test-mine.mjs`, a repo
// script outside this suite's own import graph (same reason as test-mine-scope-derivation).
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  IMPACT_CLI_CANDIDATES,
  matchesExcludeGlob,
  mergeNewTestFiles,
  packageLabelByDir,
  parseImpactSelection,
  partitionExcluded,
  resolveImpactCli,
  relatedUnionSpecs,
  runImpactSelector,
  selectorFileScopeUnionNote,
  PACKAGES,
} from "../../../../scripts/test-mine.mjs";

/**
 * #951 — `KANBAN_TEST_SELECTOR=impact` shells out to the test-impact skill and consumes its
 * `--format pkgfile` output (`<packageDir>:<path relative to that package>` per line). These
 * tests exercise the pure parsing/resolution directly, never spawning the real skill.
 */
describe("selectorFileScopeUnionNote", () => {
  it("announces the UNION when both the impact selector and an explicit file scope are set", () => {
    // #967 reverses #962's refusal. The refusal existed because the file list was silently
    // DISCARDED — but the fix for silence is not exclusivity: the two selectors' misses are
    // different in kind (`related` is blind to runtime reach; impact is a ranked bet), so
    // replace-mode gave up the half `related` is actually good at. What must survive from #962 is
    // that the combination is never silent, which is what this note is.
    const message = selectorFileScopeUnionNote({
      impactSelectorRequested: true,
      scopedFiles: ["packages/server/src/a.ts", "packages/server/src/b.ts"],
    });
    expect(message).not.toContain("refusing to run");
    expect(message).toContain("UNION");
    // Both variables named, and the count, so the operator can see what is being combined.
    expect(message).toContain("KANBAN_TEST_SELECTOR=impact");
    expect(message).toContain("KANBAN_TEST_FILES");
    expect(message).toContain("2 named file(s)");
    // The ORDERING decision, stated where an operator reads it: our score floor has no authority
    // over another selector's evidence, but the budget must still hold over the union.
    expect(message).toContain("--min-score");
    expect(message).toContain("budget");
  });

  it("says nothing when only one of them is set", () => {
    expect(selectorFileScopeUnionNote({ impactSelectorRequested: true, scopedFiles: [] })).toBeNull();
    expect(selectorFileScopeUnionNote({ impactSelectorRequested: false, scopedFiles: ["a.ts"] })).toBeNull();
    expect(selectorFileScopeUnionNote({ impactSelectorRequested: false, scopedFiles: [] })).toBeNull();
  });
});

/**
 * #967 — the union INPUT: what `vitest related` would have selected, gathered per package and
 * handed to `select --union`.
 *
 * The derivation itself boots a real vitest instance, so it is injected here; what these pin is
 * the part that decides whether the union means anything — which packages are asked, that an
 * upstream-only package still contributes, and that a FAILED derivation is named rather than
 * read as "related agreed with the impact selection".
 */
describe("relatedUnionSpecs", () => {
  const packages = [
    { dir: "packages/server", label: "server" },
    { dir: "packages/shared", label: "shared" },
  ];

  it("collects and dedupes the related suites across every package with changed files", async () => {
    const { specs, failedPackages } = await relatedUnionSpecs(
      packages,
      (pkg) => (pkg.label === "server" ? ["src/a.ts"] : ["src/b.ts"]),
      () => [],
      async (_pkgDir, _files) => ["packages/server/src/__tests__/a.test.ts"],
    );
    // Both packages derived the same suite; the union is a SET, not a concatenation.
    expect(specs).toEqual(["packages/server/src/__tests__/a.test.ts"]);
    expect(failedPackages).toEqual([]);
  });

  it("falls back to the UPSTREAM changed files for a package that owns none", async () => {
    // The `related` path's own rule: a `packages/shared`-only diff reaches the server's suites
    // through its vitest alias. Skipping such a package would silently shrink the union to the
    // one package that happened to own the diff.
    const seen = [];
    await relatedUnionSpecs(
      packages,
      (pkg) => (pkg.label === "shared" ? ["src/b.ts"] : []),
      (pkg) => (pkg.label === "server" ? ["/repo/packages/shared/src/b.ts"] : []),
      async (pkgDir, files) => {
        seen.push([pkgDir, files]);
        return [];
      },
    );
    expect(seen).toHaveLength(2);
    expect(seen.some(([, files]) => files[0] === "/repo/packages/shared/src/b.ts")).toBe(true);
  });

  it("skips a package with no changed files of its own and none upstream", async () => {
    const seen = [];
    const { specs } = await relatedUnionSpecs(
      packages,
      () => [],
      () => [],
      async (pkgDir) => {
        seen.push(pkgDir);
        return [];
      },
    );
    expect(seen).toEqual([]);
    expect(specs).toEqual([]);
  });

  it("NAMES a package whose derivation failed instead of contributing silence", async () => {
    // Silence would read as "`vitest related` selected nothing there", i.e. "the other selector
    // agreed with ours" — the one claim a failed probe may not make.
    const { specs, failedPackages } = await relatedUnionSpecs(
      packages,
      () => ["src/a.ts"],
      () => [],
      async (pkgDir) => (pkgDir.includes("shared") ? null : ["packages/server/src/__tests__/a.test.ts"]),
    );
    expect(specs).toEqual(["packages/server/src/__tests__/a.test.ts"]);
    expect(failedPackages).toEqual(["shared"]);
  });
});

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

describe("exclusion of selected suites this runner never runs", () => {
  // The selector ranks EVERY test file in the repo and knows nothing about this runner's
  // `exclude` list (the #173 environmental exclusions). Handing it an excluded path is wrong in
  // both directions: with other suites alongside it, vitest runs those and exits 0 having
  // silently skipped the excluded one — a green for a suite that never ran; alone, vitest
  // resolves nothing and exits 1 with a bare `No test files found`.
  const server = PACKAGES.find((p) => p.label === "server");

  it("matches the `**/name.test.ts` shape the exclude globs actually use", () => {
    expect(matchesExcludeGlob("**/cli.test.ts", "src/__tests__/cli.test.ts")).toBe(true);
    expect(matchesExcludeGlob("**/cli.test.ts", "cli.test.ts")).toBe(true);
    // Not a prefix match — `cli-butler.test.ts` has its own entry for its own reason.
    expect(matchesExcludeGlob("**/cli.test.ts", "src/__tests__/cli-butler.test.ts")).toBe(false);
    expect(matchesExcludeGlob("**/cli.test.ts", "src/__tests__/mycli.test.ts")).toBe(false);
  });

  it("drops an excluded suite and reports WHY, keeping the runnable ones", () => {
    const { kept, excluded } = partitionExcluded(server, [
      "src/__tests__/cli.test.ts",
      "src/__tests__/gate-builder-quiesce.test.ts",
    ]);
    expect(kept).toEqual(["src/__tests__/gate-builder-quiesce.test.ts"]);
    expect(excluded).toEqual([
      { file: "packages/server/src/__tests__/cli.test.ts", reason: "spawns the CLI binary as a child process" },
    ]);
  });

  it("drops every excluded suite in the package, not just the first", () => {
    const { kept, excluded } = partitionExcluded(server, [
      "src/__tests__/cli.test.ts",
      "src/__tests__/git.service.test.ts",
      "src/__tests__/compose-lifecycle-real-docker.test.ts",
    ]);
    // All three are environmentally excluded — nothing left to run, which the caller turns
    // into a fall-back rather than a green from guards alone.
    expect(kept).toEqual([]);
    expect(excluded).toHaveLength(3);
  });

  it("leaves a package with no exclusions untouched", () => {
    const client = PACKAGES.find((p) => p.label === "client");
    expect(client.exclude).toEqual([]);
    const { kept, excluded } = partitionExcluded(client, ["src/__tests__/a.test.ts"]);
    expect(kept).toEqual(["src/__tests__/a.test.ts"]);
    expect(excluded).toEqual([]);
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
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: false, base: "", spawnFn });
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
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: true, base: "", spawnFn });
    expect(seen).toContain("--rebuild-if-stale");
  });
});

/**
 * #956 — the base ref, and the new-test-file widening.
 *
 * These two are what make the `impact` GATE TIER an honest narrowing rather than a decorative one.
 * Without the base the selection at gate time is computed from an empty change set; without the
 * new-file merge a suite the branch adds can be ranked out by its own newness and never run.
 */
describe("the selection's base ref", () => {
  const cli = resolve("/repo", ".claude/skills/test-impact/tools/impact.mjs");
  const spawnCapturing = (sink) => (_exe, args) => {
    sink.args = args;
    return { status: 0, stdout: "packages/server:src/__tests__/a.test.ts\n", stderr: "" };
  };

  it("passes the base POSITIONALLY, before the flags", () => {
    // `cmdSelect` reads `positional[0]` and never consults a `--base` flag. Passing it as a flag
    // is silently ignored, `changedFiles(undefined)` falls back to uncommitted work, and on the
    // clean committed tree a gate runs against the change set comes back EMPTY — the selection
    // then degrades to the constant always-run set while still calling itself a selection. That
    // is #963, and getting the spelling backwards is exactly what made its first fix inert.
    const sink = {};
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: false, base: "master", spawnFn: spawnCapturing(sink) });
    expect(sink.args.slice(1)).toEqual(["select", "master", "--format", "pkgfile", "--min-score", "1.0"]);
    expect(sink.args).not.toContain("--base");
  });

  it("omits it entirely when unset, keeping the inner loop's uncommitted-work behaviour", () => {
    // A developer mid-edit HAS uncommitted work, and that is the right change set for them. A base
    // there would replace it with everything committed since the base.
    const sink = {};
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: false, base: "", spawnFn: spawnCapturing(sink) });
    expect(sink.args.slice(1)).toEqual(["select", "--format", "pkgfile", "--min-score", "1.0"]);
  });
});

/**
 * #966 — the per-project TIME BUDGET (`KANBAN_TEST_BUDGET`), the board's `test_impact_budget_<id>`
 * setting as the runner sees it.
 *
 * The floor and the budget are two different cuts and they COMPOSE, floor first: `--min-score` is
 * an evidence threshold, `--budget` then fills the remaining seconds with the highest-scoring
 * survivors. Both stay independently configurable, so both must reach the tool.
 */
describe("the selection's time budget", () => {
  const cli = resolve("/repo", ".claude/skills/test-impact/tools/impact.mjs");
  const spawnCapturing = (sink) => (_exe, args) => {
    sink.args = args;
    return { status: 0, stdout: "packages/server:src/__tests__/a.test.ts\n", stderr: "" };
  };

  it("passes --budget alongside the floor, after the positional base", () => {
    const sink = {};
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: false, base: "master", budget: "60s", spawnFn: spawnCapturing(sink) });
    expect(sink.args.slice(1)).toEqual([
      "select", "master", "--format", "pkgfile", "--min-score", "1.0", "--budget", "60s",
    ]);
  });

  it("omits it entirely when unset — byte-identical argv to the pre-#966 runner", () => {
    // "Clearing the setting restores today's behaviour exactly" is the whole contract of the
    // Settings field, and this is where it either holds or does not.
    const sink = {};
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: false, base: "", budget: "", spawnFn: spawnCapturing(sink) });
    expect(sink.args.slice(1)).toEqual(["select", "--format", "pkgfile", "--min-score", "1.0"]);
  });
});

/**
 * #967 — the union reaches the tool as `select --union`, and the PLACEMENT is the contract.
 *
 * `impact.mjs` admits external entries after the `--min-score` cut and before the `--budget` cut.
 * Doing the union here instead — appending the related picks to a finished selection — would land
 * them after the budget was already spent, so a project with a 60s budget would silently run
 * longer than the setting promises. That is why this is an ARGV assertion and not a merge test.
 */
describe("the union hand-off to select --union", () => {
  const cli = resolve("/repo", ".claude/skills/test-impact/tools/impact.mjs");
  const spawnCapturing = (sink) => (_exe, args) => {
    sink.args = args;
    return { status: 0, stdout: "packages/server:src/__tests__/a.test.ts\n", stderr: "" };
  };

  it("passes the related picks as a comma-separated --union, before --rebuild-if-stale", () => {
    const sink = {};
    runImpactSelector({
      cli,
      minScore: "1.0",
      rebuildIfStale: false,
      base: "master",
      budget: "60s",
      union: ["packages/server/src/__tests__/b.test.ts", "packages/shared/__tests__/c.test.ts"],
      spawnFn: spawnCapturing(sink),
    });
    expect(sink.args.slice(1)).toEqual([
      "select", "master", "--format", "pkgfile", "--min-score", "1.0", "--budget", "60s",
      "--union", "packages/server/src/__tests__/b.test.ts,packages/shared/__tests__/c.test.ts",
    ]);
  });

  it("omits --union entirely when no other selector ran — byte-identical argv to the pre-#967 runner", () => {
    const sink = {};
    runImpactSelector({ cli, minScore: "1.0", rebuildIfStale: false, base: "", union: [], spawnFn: spawnCapturing(sink) });
    expect(sink.args.slice(1)).toEqual(["select", "--format", "pkgfile", "--min-score", "1.0"]);
  });
});

describe("mergeNewTestFiles", () => {
  it("adds a new suite the selection did not name", () => {
    // The motivating case: a test file the diff ADDS is absent from the committed impact map, so
    // it has no coverage, failure or runtime history — the very signals the score is built from —
    // and can be ranked out below the floor by its own newness.
    const byLabel = new Map([["server", ["src/__tests__/a.test.ts"]]]);
    const { added, unknown } = mergeNewTestFiles(byLabel, ["packages/server/src/__tests__/new.test.ts"]);
    expect(added).toBe(1);
    expect(unknown).toEqual([]);
    expect(byLabel.get("server")).toEqual(["src/__tests__/a.test.ts", "src/__tests__/new.test.ts"]);
  });

  it("creates the package entry when the selection named nothing there", () => {
    const byLabel = new Map([["server", ["src/__tests__/a.test.ts"]]]);
    mergeNewTestFiles(byLabel, ["packages/client/src/__tests__/new.test.tsx"]);
    expect(byLabel.get("client")).toEqual(["src/__tests__/new.test.tsx"]);
  });

  it("does not double-add a suite the selection already named", () => {
    const byLabel = new Map([["server", ["src/__tests__/a.test.ts"]]]);
    const { added } = mergeNewTestFiles(byLabel, ["packages/server/src/__tests__/a.test.ts"]);
    expect(added).toBe(0);
    expect(byLabel.get("server")).toEqual(["src/__tests__/a.test.ts"]);
  });

  it("ignores non-test paths, which would fail the package rather than widen it", () => {
    // The gate derives this list from its diff, and a diff names source files too. Handing vitest
    // a non-test path makes it resolve no suite and exit 1 with a bare `No test files found` —
    // turning a widening into a red gate.
    const byLabel = new Map();
    const { added } = mergeNewTestFiles(byLabel, [
      "packages/server/src/services/a.ts",
      "packages/server/README.md",
    ]);
    expect(added).toBe(0);
    expect(byLabel.size).toBe(0);
  });

  it("reports a file in a package this runner does not run instead of guessing", () => {
    const byLabel = new Map();
    const { added, unknown } = mergeNewTestFiles(byLabel, ["packages/desktop/src/__tests__/x.test.ts"]);
    expect(added).toBe(0);
    expect(unknown).toEqual(["packages/desktop/src/__tests__/x.test.ts"]);
  });

  it("accepts every test extension the runner runs", () => {
    const byLabel = new Map();
    mergeNewTestFiles(byLabel, [
      "packages/server/src/__tests__/a.test.ts",
      "packages/client/src/__tests__/b.test.tsx",
      "packages/server/src/__tests__/c.test.mjs",
    ]);
    expect(byLabel.get("server")).toEqual(["src/__tests__/a.test.ts", "src/__tests__/c.test.mjs"]);
    expect(byLabel.get("client")).toEqual(["src/__tests__/b.test.tsx"]);
  });
});

describe("new test files versus the empty-selection fail-open", () => {
  const cli = resolve("/repo", ".claude/skills/test-impact/tools/impact.mjs");

  it("still falls back to `vitest related` when the selection is empty", () => {
    // Deliberate ordering: running ONLY the new file there would be NARROWER than the fallback,
    // and an empty selection is evidence the selector had nothing to say about this change at all.
    const spawnFn = () => ({ status: 0, stdout: "", stderr: "" });
    expect(
      runImpactSelector({ cli, base: "", newTestFiles: ["packages/server/src/__tests__/new.test.ts"], spawnFn }),
    ).toBeNull();
  });

  it("merges them into a non-empty selection", () => {
    const spawnFn = () => ({ status: 0, stdout: "packages/server:src/__tests__/a.test.ts\n", stderr: "" });
    const scope = runImpactSelector({
      cli,
      base: "",
      newTestFiles: ["packages/server/src/__tests__/new.test.ts"],
      spawnFn,
    });
    expect(scope?.get("server")).toEqual(["src/__tests__/a.test.ts", "src/__tests__/new.test.ts"]);
  });
});
