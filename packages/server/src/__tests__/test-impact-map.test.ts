/**
 * The test-impact map refresh pass (#952) and its durations wiring (#955).
 *
 * These run against a REAL git repo (temp dir, `git init`), because the properties that matter
 * are git properties: that a failed pass leaves the tree CLEAN (a dirty main checkout blocks
 * every subsequent merge), that the commit carries only the map, and that a byte-identical
 * rebuild does not mint an empty commit. The `impact.mjs` CLI itself is injected — spawning the
 * real 7.4s build would make this suite the slowest in the repo and would test the skill, not
 * the pass.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMPACT_DURATIONS_PATH,
  IMPACT_MAP_PATH,
  impactMapCommitSubject,
  resolveImpactMapPaths,
  resolveTestImpactMapGate,
  runTestImpactMapPass,
} from "../services/test-impact-map.service.js";
import type { ImpactMapRunner } from "../services/test-impact-map/impact-cli.js";

const created: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
}

/** A repo with a committed map and the skill's CLI present (contents irrelevant — it is injected). */
function makeRepo(opts: { withDurations?: boolean; withSkill?: boolean; withMap?: boolean } = {}): string {
  const { withDurations = false, withSkill = true, withMap = true } = opts;
  const repo = mkdtempSync(join(tmpdir(), "kanban-impact-map-"));
  created.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);

  if (withSkill) {
    mkdirSync(join(repo, ".claude", "skills", "test-impact", "tools"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "test-impact", "tools", "impact.mjs"), "// stub\n");
  }
  mkdirSync(join(repo, "docs", "tests"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "seed\n");
  if (withMap) writeFileSync(join(repo, IMPACT_MAP_PATH), '{"format":"test-impact 1","commit":"old"}\n');
  if (withDurations) writeFileSync(join(repo, IMPACT_DURATIONS_PATH), '{"testResults":[]}\n');

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "seed"]);
  return repo;
}

/** Records what the pass asked the CLI to do, and simulates `check`/`build` outcomes. */
function makeRunner(behaviour: {
  fresh?: boolean;
  buildOk?: boolean;
  /** What `build` writes into the map, when it "succeeds". */
  writes?: string;
}): ImpactMapRunner & { calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const runner = (async (_tool: string, args: string[], cwd: string) => {
    calls.push({ args, cwd });
    if (args[0] === "check") return { code: behaviour.fresh ? 0 : 1, stdout: "", stderr: "", error: null };
    if (behaviour.buildOk === false) {
      // A real failing build can still have written a partial file — that is the case the
      // pass must clean up, so simulate it.
      writeFileSync(join(cwd, IMPACT_MAP_PATH), "PARTIAL GARBAGE\n");
      return { code: 3, stdout: "", stderr: "REFUSING: 0 test files matched", error: null };
    }
    if (behaviour.writes !== undefined) writeFileSync(join(cwd, IMPACT_MAP_PATH), behaviour.writes);
    return { code: 0, stdout: "[test-impact] built docs/tests/impact-map.json", stderr: "", error: null };
  }) as ImpactMapRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

/** Everything git considers modified/untracked. A non-empty result blocks every later merge. */
function dirtyFiles(repo: string): string {
  return git(repo, ["status", "--porcelain"]);
}

afterAll(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* a held Windows handle is not worth failing the suite over */ }
  }
});

describe("resolveTestImpactMapGate", () => {
  it("follows the board-wide default when the project has no override", () => {
    expect(resolveTestImpactMapGate(new Map(), "p1", true).enabled).toBe(true);
    expect(resolveTestImpactMapGate(new Map(), "p1", false).enabled).toBe(false);
  });

  it("lets a project opt OUT even when the board-wide default is on", () => {
    for (const value of ["off", "false", "0", "OFF"]) {
      const prefs = new Map([["test_impact_map_p1", value]]);
      expect(resolveTestImpactMapGate(prefs, "p1", true).enabled).toBe(false);
    }
  });

  it("is scoped per project — one project's opt-out does not disable another", () => {
    const prefs = new Map([["test_impact_map_p1", "off"]]);
    expect(resolveTestImpactMapGate(prefs, "p2", true).enabled).toBe(true);
  });
});

describe("resolveImpactMapPaths", () => {
  it("prefers the repo-local skill bundle over the machine-wide one", () => {
    const repo = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "kanban-impact-home-"));
    created.push(home);
    mkdirSync(join(home, ".claude", "skills", "test-impact", "tools"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "test-impact", "tools", "impact.mjs"), "// home\n");

    const paths = resolveImpactMapPaths(repo, home);
    expect(paths.tool).toBe(join(repo, ".claude", "skills", "test-impact", "tools", "impact.mjs"));
  });

  it("falls back to the machine-wide skill when the repo has none", () => {
    const repo = makeRepo({ withSkill: false });
    const home = mkdtempSync(join(tmpdir(), "kanban-impact-home-"));
    created.push(home);
    mkdirSync(join(home, ".claude", "skills", "test-impact", "tools"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "test-impact", "tools", "impact.mjs"), "// home\n");

    expect(resolveImpactMapPaths(repo, home).tool).toBe(
      join(home, ".claude", "skills", "test-impact", "tools", "impact.mjs"),
    );
  });

  it("reports no durations report when the repo does not track one", () => {
    expect(resolveImpactMapPaths(makeRepo(), undefined).durations).toBeNull();
  });
});

describe("runTestImpactMapPass", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("skips a repo with no test-impact skill, without touching the tree", async () => {
    const noSkill = makeRepo({ withSkill: false });
    const res = await runTestImpactMapPass(noSkill, { homeDir: join(noSkill, "nope"), runner: makeRunner({}) });
    expect(res.outcome).toBe("no_skill");
    expect(dirtyFiles(noSkill)).toBe("");
  });

  it("refuses to CREATE a map in a repo that does not already track one", async () => {
    // Creating one unbidden would commit a 1.4 MB generated file into someone else's tree.
    const noMap = makeRepo({ withMap: false });
    const runner = makeRunner({ writes: "new\n" });
    const res = await runTestImpactMapPass(noMap, { runner });
    expect(res.outcome).toBe("no_map");
    expect(runner.calls).toHaveLength(0);
    expect(dirtyFiles(noMap)).toBe("");
  });

  it("does nothing when the map is already fresh — and never takes the lock", async () => {
    const runner = makeRunner({ fresh: true });
    let lockTaken = false;
    const res = await runTestImpactMapPass(repo, {
      runner,
      acquireLock: async () => {
        lockTaken = true;
        return { path: "", contents: {} as never, heartbeat: () => {}, release: () => {} };
      },
    });
    expect(res.outcome).toBe("fresh");
    expect(lockTaken).toBe(false);
    expect(runner.calls.map((c) => c.args[0])).toEqual(["check"]);
  });

  it("rebuilds a stale map and commits it with the fixed subject naming HEAD", async () => {
    const before = git(repo, ["rev-parse", "HEAD"]);
    const res = await runTestImpactMapPass(repo, { runner: makeRunner({ writes: '{"commit":"new"}\n' }) });

    expect(res.outcome).toBe("rebuilt");
    expect(dirtyFiles(repo)).toBe("");
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe(impactMapCommitSubject(res.headSha!));
    // The subject names the sha the map was rebuilt AT — i.e. the parent, not the chore commit.
    expect(before.startsWith(res.headSha!)).toBe(true);
    expect(git(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean))
      .toEqual([IMPACT_MAP_PATH]);
    expect(readFileSync(join(repo, IMPACT_MAP_PATH), "utf8")).toBe('{"commit":"new"}\n');
  });

  it("commits ONLY the map, leaving another agent's concurrent edit uncommitted", async () => {
    // The index is shared process-wide in a checkout several agents work in, so the pass
    // commits by pathspec. A `git add` + commit would sweep this file into the chore commit.
    writeFileSync(join(repo, "README.md"), "someone else is mid-edit\n");
    const res = await runTestImpactMapPass(repo, { runner: makeRunner({ writes: '{"commit":"new"}\n' }) });

    expect(res.outcome).toBe("rebuilt");
    expect(git(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean))
      .toEqual([IMPACT_MAP_PATH]);
    expect(dirtyFiles(repo)).toContain("README.md");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("someone else is mid-edit\n");
  });

  it("mints no empty commit when a stale-by-count map rebuilds byte-identically", async () => {
    const head = git(repo, ["rev-parse", "HEAD"]);
    const identical = readFileSync(join(repo, IMPACT_MAP_PATH), "utf8");
    const res = await runTestImpactMapPass(repo, { runner: makeRunner({ writes: identical }) });

    expect(res.outcome).toBe("fresh");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(dirtyFiles(repo)).toBe("");
  });

  it("leaves the tree CLEAN when the build fails — dirty main blocks every later merge", async () => {
    const head = git(repo, ["rev-parse", "HEAD"]);
    const res = await runTestImpactMapPass(repo, { runner: makeRunner({ buildOk: false }) });

    expect(res.outcome).toBe("build_failed");
    expect(res.detail).toContain("REFUSING");
    expect(dirtyFiles(repo)).toBe("");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    // Keyword, not an exact string: `git checkout --` restores through the repo's autocrlf
    // normalization, so the bytes may differ from what was written in line endings alone.
    const restored = readFileSync(join(repo, IMPACT_MAP_PATH), "utf8");
    expect(restored).toContain('"commit":"old"');
    expect(restored).not.toContain("PARTIAL GARBAGE");
  });

  it("SKIPS rather than waits when the repo lock is contended", async () => {
    // Waiting is the dangerous option: `landMergeTrain` refuses a base that moved since the
    // tree was assembled, so a commit landed under a train's feet kills it. A stale map
    // only widens the next gate run.
    const runner = makeRunner({});
    const res = await runTestImpactMapPass(repo, {
      runner,
      acquireLock: async () => {
        throw new Error("timed out waiting for the repo lock");
      },
    });
    expect(res.outcome).toBe("lock_busy");
    expect(runner.calls.some((c) => c.args[0] === "build")).toBe(false);
    expect(dirtyFiles(repo)).toBe("");
  });

  it("releases the lock even when the build throws", async () => {
    let released = false;
    const res = await runTestImpactMapPass(repo, {
      // `check` reports stale normally; the THROW happens after the lock is held, which is the
      // only ordering that actually exercises the release.
      runner: async (_tool, args) => {
        if (args[0] === "check") return { code: 1, stdout: "", stderr: "", error: null };
        throw new Error("spawn ENOENT");
      },
      acquireLock: async () => ({
        path: "", contents: {} as never, heartbeat: () => {}, release: () => { released = true; },
      }),
    });
    expect(res.outcome).toBe("build_failed");
    expect(res.detail).toContain("ENOENT");
    expect(released).toBe(true);
    expect(dirtyFiles(repo)).toBe("");
  });

  it("treats an unrecognised check exit as FRESH rather than rebuilding on every cycle", async () => {
    // Only 1 (stale) and 2 (no map) mean rebuild. A crash, a signal kill (`code: null`), or a
    // code the CLI grows later means "we do not know" — and the safe direction for an unknown
    // is to leave the map alone, not to commit to master every 30 seconds.
    for (const code of [null, 7]) {
      const fresh = makeRepo();
      const runner = (async () => ({ code, stdout: "", stderr: "boom", error: null })) as ImpactMapRunner;
      const res = await runTestImpactMapPass(fresh, { runner });
      expect(res.outcome, `check exit ${code}`).toBe("fresh");
      expect(dirtyFiles(fresh)).toBe("");
    }
  });

  it("reports a CLI that cannot even be spawned, instead of throwing into the cycle", async () => {
    const res = await runTestImpactMapPass(repo, {
      runner: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(res.outcome).toBe("build_failed");
    expect(dirtyFiles(repo)).toBe("");
  });

  it("skips a detached HEAD instead of rebuilding into an uncommittable tree", async () => {
    git(repo, ["checkout", "--detach"]);
    const runner = makeRunner({ writes: "new\n" });
    const res = await runTestImpactMapPass(repo, { runner });

    expect(res.outcome).toBe("detached_head");
    expect(runner.calls.some((c) => c.args[0] === "build")).toBe(false);
    expect(dirtyFiles(repo)).toBe("");
  });
});

describe("the merge=ours mechanism (#952)", () => {
  /**
   * The load-bearing check. `.gitattributes` alone is NOT enough and it fails SILENTLY: git has
   * no built-in `ours` driver, so `merge=ours` naming an unregistered one is ignored and the
   * merge conflicts exactly as if the line were absent (measured). `.git/config` is not checked
   * in, so only the board can register it. This test drives a real divergent merge.
   */
  function driveDivergentMapMerge(repo: string): { exitCode: number; content: string } {
    git(repo, ["checkout", "-b", "side"]);
    writeFileSync(join(repo, IMPACT_MAP_PATH), '{"commit":"theirs"}\n');
    git(repo, ["commit", "-am", "branch rebuilt the map"]);
    git(repo, ["checkout", "main"]);
    writeFileSync(join(repo, IMPACT_MAP_PATH), '{"commit":"ours"}\n');
    git(repo, ["commit", "-am", "main rebuilt the map"]);

    let exitCode = 0;
    try {
      git(repo, ["merge", "side", "-m", "merge"]);
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 1;
    }
    return { exitCode, content: readFileSync(join(repo, IMPACT_MAP_PATH), "utf8") };
  }

  /** The attribute the repo ships. Mirrors the real `.gitattributes` line. */
  function withAttribute(repo: string): void {
    writeFileSync(join(repo, ".gitattributes"), `${IMPACT_MAP_PATH} merge=ours\n`);
    git(repo, ["add", ".gitattributes"]);
    git(repo, ["commit", "-m", "attribute"]);
  }

  it("conflicts WITHOUT the driver — the attribute alone is inert", async () => {
    // The negative control. Without this, the test below would pass for the wrong reason and
    // could not tell "the mechanism works" from "these two commits happened not to conflict".
    const repo = makeRepo();
    withAttribute(repo);
    const merged = driveDivergentMapMerge(repo);

    expect(merged.exitCode).not.toBe(0);
    expect(merged.content).toContain("<<<<<<<");
  });

  it("resolves to ours once the pass has registered the driver", async () => {
    const repo = makeRepo();
    withAttribute(repo);
    await runTestImpactMapPass(repo, { runner: makeRunner({ fresh: true }) });

    // Registered on the repo, not the user's global config.
    expect(git(repo, ["config", "--local", "--get", "merge.ours.driver"])).toBe("true");

    const merged = driveDivergentMapMerge(repo);
    expect(merged.exitCode).toBe(0);
    expect(merged.content).toContain('"commit":"ours"');
    expect(merged.content).not.toContain("<<<<<<<");
    expect(dirtyFiles(repo)).toBe("");
  });

  it("registers the driver even when the map is already fresh", async () => {
    // The attribute is inert until the driver exists, so a checkout whose map never goes stale
    // is exactly the one that would otherwise keep conflicting on it forever.
    const repo = makeRepo();
    const res = await runTestImpactMapPass(repo, { runner: makeRunner({ fresh: true }) });
    expect(res.outcome).toBe("fresh");
    expect(git(repo, ["config", "--local", "--get", "merge.ours.driver"])).toBe("true");
  });

  it("does not clobber a driver the repo has already configured", async () => {
    const repo = makeRepo();
    git(repo, ["config", "--local", "merge.ours.driver", "custom-driver %A %O %B"]);
    await runTestImpactMapPass(repo, { runner: makeRunner({ fresh: true }) });
    expect(git(repo, ["config", "--local", "--get", "merge.ours.driver"])).toBe("custom-driver %A %O %B");
  });
});

describe("durations are re-fed on every rebuild (#955)", () => {
  it("passes --durations when the repo tracks a report", async () => {
    // `impact.mjs build` reads durations ONLY from --durations and does not carry them over
    // from the previous map. Omitting the flag would silently erase every measured time and
    // return `select --budget 60s` to its files x 3s estimate.
    const repo = makeRepo({ withDurations: true });
    const runner = makeRunner({ writes: '{"commit":"new"}\n' });
    const res = await runTestImpactMapPass(repo, { runner });

    const build = runner.calls.find((c) => c.args[0] === "build");
    expect(build?.args).toEqual(["build", "--durations", join(repo, IMPACT_DURATIONS_PATH)]);
    expect(res.durationsFed).toBe(true);
  });

  it("builds without the flag, and says so, when no report is committed", async () => {
    const repo = makeRepo({ withDurations: false });
    const runner = makeRunner({ writes: '{"commit":"new"}\n' });
    const res = await runTestImpactMapPass(repo, { runner });

    expect(runner.calls.find((c) => c.args[0] === "build")?.args).toEqual(["build"]);
    expect(res.durationsFed).toBe(false);
  });
});
