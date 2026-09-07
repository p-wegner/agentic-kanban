/**
 * #1046 — the map has a MERGE trigger, and a stale map is no longer a silent widening.
 *
 * The defect these pin: every refresh trigger deferred to `impact.mjs check`, whose own threshold
 * is `staleWidenAfterCommits` = 30. A map 24 commits behind was therefore "fresh" to all of them,
 * nothing rebuilt it, and the day it tipped past 30 the gate quietly dropped to the package tier.
 *
 * Real git repos (temp dir, `git init`) because the bound is a git property — `<map stamp>..HEAD`
 * — and a fake would just re-assert the arithmetic. The `impact.mjs` CLI itself is injected: the
 * subject is which calls the trigger makes, not what the skill does with them.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IMPACT_MAP_PATH } from "../services/test-impact-map.service.js";
import type { ImpactMapRunner } from "../services/test-impact-map/impact-cli.js";
import {
  IMPACT_MAP_MAX_COMMITS_BEHIND,
  countImpactMapCommitsBehind,
  refreshImpactMapAfterMerge,
} from "../services/test-impact-map/post-merge.js";
import { buildImpactSelectionNote, IMPACT_MAP_STALE_REMEDY } from "../services/pre-merge-gate-tier.js";

const created: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
}

/**
 * A repo whose map is stamped `commitsBehind` commits back from HEAD, with the skill present and
 * the map path gitignored (the #1018 opt-in marker the pass verifies).
 */
function makeRepo(opts: { commitsBehind?: number; withMap?: boolean; stamp?: string } = {}): string {
  const { commitsBehind = 0, withMap = true } = opts;
  const repo = mkdtempSync(join(tmpdir(), "kanban-impact-postmerge-"));
  created.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);

  mkdirSync(join(repo, ".claude", "skills", "test-impact", "tools"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "test-impact", "tools", "impact.mjs"), "// stub\n");
  mkdirSync(join(repo, "docs", "tests"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), `/${IMPACT_MAP_PATH}\n`);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "seed"]);

  const stampSha = git(repo, ["rev-parse", "HEAD"]);
  // Each extra commit is one the map does not know about — i.e. `commitsBehind` exactly.
  for (let i = 0; i < commitsBehind; i++) {
    writeFileSync(join(repo, "README.md"), `seed ${i}\n`);
    git(repo, ["commit", "-am", `commit ${i}`]);
  }
  if (withMap) {
    const stamp = opts.stamp ?? stampSha;
    writeFileSync(join(repo, IMPACT_MAP_PATH), `{"format":"test-impact 1","commit":"${stamp}"}\n`);
  }
  return repo;
}

/** Records what the trigger asked the CLI to do; `fresh` is what a `check` call would answer. */
function makeRunner(behaviour: { fresh?: boolean } = {}): ImpactMapRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (async (_tool: string, args: string[], cwd: string) => {
    calls.push(args);
    if (args[0] === "check") return { code: behaviour.fresh === false ? 1 : 0, stdout: "", stderr: "", error: null };
    writeFileSync(join(cwd, IMPACT_MAP_PATH), '{"format":"test-impact 1","commit":"rebuilt"}\n');
    return { code: 0, stdout: "built", stderr: "", error: null };
  }) as ImpactMapRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

/** The board-wide switch on, no per-project override — the shipped default shape. */
const ON = new Map([["test_impact_map_refresh", "true"]]);

afterAll(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* a held Windows handle is not worth failing the suite over */ }
  }
});

describe("countImpactMapCommitsBehind", () => {
  it("counts <map stamp>..HEAD", async () => {
    expect(await countImpactMapCommitsBehind(makeRepo({ commitsBehind: 7 }))).toBe(7);
    expect(await countImpactMapCommitsBehind(makeRepo({ commitsBehind: 0 }))).toBe(0);
  });

  it("is null — never 0 — when there is no map to date", async () => {
    expect(await countImpactMapCommitsBehind(makeRepo({ withMap: false }))).toBeNull();
  });

  it("is null when the stamp is not reachable from HEAD (rewritten history, a foreign build)", async () => {
    expect(await countImpactMapCommitsBehind(makeRepo({ stamp: "deadbeefdeadbeef" }))).toBeNull();
  });
});

describe("refreshImpactMapAfterMerge", () => {
  it("REBUILDS past the bound even though the tool still calls the map fresh (#1046)", async () => {
    const repo = makeRepo({ commitsBehind: IMPACT_MAP_MAX_COMMITS_BEHIND + 1 });
    const runner = makeRunner({ fresh: true });

    const res = await refreshImpactMapAfterMerge({
      repoPath: repo, projectId: "p1", prefMap: ON, passDeps: { runner }, log: () => {},
    });

    expect(res.outcome).toBe("pass");
    expect(res.forced).toBe(true);
    expect(res.pass?.outcome).toBe("rebuilt");
    // The whole point: the tool's generous threshold is not consulted at all past our bound.
    expect(runner.calls.some((args) => args[0] === "check")).toBe(false);
    expect(runner.calls.some((args) => args[0] === "build")).toBe(true);
    expect(readFileSync(join(repo, IMPACT_MAP_PATH), "utf8")).toContain("rebuilt");
  });

  it("leaves the main checkout CLEAN and mints no commit", async () => {
    const repo = makeRepo({ commitsBehind: IMPACT_MAP_MAX_COMMITS_BEHIND + 1 });
    const head = git(repo, ["rev-parse", "HEAD"]);

    await refreshImpactMapAfterMerge({
      repoPath: repo, projectId: "p1", prefMap: ON, passDeps: { runner: makeRunner() }, log: () => {},
    });

    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("defers to the tool below the bound — a merge that adds a test file is stale at one commit", async () => {
    const repo = makeRepo({ commitsBehind: 1 });
    const runner = makeRunner({ fresh: false });

    const res = await refreshImpactMapAfterMerge({
      repoPath: repo, projectId: "p1", prefMap: ON, passDeps: { runner }, log: () => {},
    });

    expect(res.forced).toBe(false);
    expect(runner.calls[0]?.[0]).toBe("check");
    expect(res.pass?.outcome).toBe("rebuilt");
  });

  it("does nothing below the bound when the tool says fresh — one cheap check per merge", async () => {
    const repo = makeRepo({ commitsBehind: 1 });
    const runner = makeRunner({ fresh: true });

    const res = await refreshImpactMapAfterMerge({
      repoPath: repo, projectId: "p1", prefMap: ON, passDeps: { runner }, log: () => {},
    });

    expect(res.pass?.outcome).toBe("fresh");
    expect(runner.calls.map((args) => args[0])).toEqual(["check"]);
  });

  it("respects the per-project opt-out and the board-wide switch — no spawn at all", async () => {
    const repo = makeRepo();
    const boardWideOff = new Map([["test_impact_map_refresh", "false"]]);
    const projectOptedOut = new Map([["test_impact_map_refresh", "true"], ["test_impact_map_p1", "off"]]);
    for (const prefs of [boardWideOff, projectOptedOut]) {
      const runner = makeRunner();
      const res = await refreshImpactMapAfterMerge({
        repoPath: repo, projectId: "p1", prefMap: prefs, passDeps: { runner }, log: () => {},
      });
      expect(res.outcome).toBe("gate_off");
      expect(runner.calls).toHaveLength(0);
    }
  });

  it("is inert for a direct/unprojected merge rather than guessing a checkout", async () => {
    const res = await refreshImpactMapAfterMerge({ repoPath: null, projectId: "p1", prefMap: ON, log: () => {} });
    expect(res.outcome).toBe("no_project");
  });

  it("never throws — the post-merge tail must not be strandable by a test-selection optimisation", async () => {
    const repo = makeRepo({ commitsBehind: IMPACT_MAP_MAX_COMMITS_BEHIND + 1 });
    const res = await refreshImpactMapAfterMerge({
      repoPath: repo,
      projectId: "p1",
      prefMap: ON,
      passDeps: {
        runner: makeRunner(),
        acquireLock: () => {
          throw new Error("boom");
        },
      },
      log: () => {},
    });
    // The pass swallows a lock failure itself; either way the caller gets a value, not a throw.
    expect(["pass", "failed"]).toContain(res.outcome);
  });
});

describe("a STALE map is reported as an actionable widening, not one word (#1046)", () => {
  const selection = {
    selector: "impact" as const,
    strategy: "impact" as const,
    packageScoped: true,
    fileScoped: false,
    changedFileCount: 3,
    guardSuiteCount: 66,
    maxWorkers: 4,
    impactSelection: { selectedCount: 12, belowFloorCount: 37, stale: true, selectionTier: "package" },
  };

  it("names the consequence and the refresh command", () => {
    const note = buildImpactSelectionNote(selection);
    expect(note).toContain("map STALE");
    expect(note).toContain(IMPACT_MAP_STALE_REMEDY);
    expect(note).toContain("impact.mjs build");
    expect(note).toContain("MAIN CHECKOUT");
  });

  it("says nothing of the sort when the map is fresh", () => {
    const note = buildImpactSelectionNote({ ...selection, impactSelection: { ...selection.impactSelection, stale: false } });
    expect(note).toContain("map fresh");
    expect(note).not.toContain("impact.mjs build");
  });

  it("stays ASCII — this string travels through merge comments and PowerShell hosts", () => {
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7E]*$/.test(IMPACT_MAP_STALE_REMEDY)).toBe(true);
  });
});
