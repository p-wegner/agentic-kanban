/**
 * The test-impact map refresh pass (#952), its durations wiring (#955), and — since #1018 — the
 * fact that it COMMITS NOTHING.
 *
 * These run against a REAL git repo (temp dir, `git init`), because the properties that matter
 * are git properties: that the pass mints no commit at all, that it leaves the tree CLEAN (a dirty
 * main checkout blocks every subsequent merge), and that it refuses to write into a checkout where
 * doing so WOULD dirty the tree. The `impact.mjs` CLI itself is injected — spawning the real 7.4s
 * build would make this suite the slowest in the repo and would test the skill, not the pass.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMPACT_DURATIONS_PATH,
  IMPACT_MAP_PATH,
  resolveImpactMapPaths,
  resolveMapWritability,
  resolveTestImpactMapGate,
  runTestImpactMapPass,
} from "../services/test-impact-map.service.js";
import type { ImpactMapRunner } from "../services/test-impact-map/impact-cli.js";

const created: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
}

/**
 * A repo with the skill's CLI present (contents irrelevant — it is injected) and the map path
 * gitignored, which is the #1018 opt-in marker the pass verifies with `git check-ignore`.
 *
 * `withMap` puts an UNTRACKED map on disk. `trackMap` is the pre-#1018 shape — the map committed —
 * which the pass must now refuse rather than rewrite.
 */
function makeRepo(opts: {
  withDurations?: boolean;
  withSkill?: boolean;
  withMap?: boolean;
  ignoreMap?: boolean;
  trackMap?: boolean;
} = {}): string {
  const {
    withDurations = false, withSkill = true, withMap = true, ignoreMap = true, trackMap = false,
  } = opts;
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
  if (ignoreMap && !trackMap) writeFileSync(join(repo, ".gitignore"), `/${IMPACT_MAP_PATH}\n`);
  if (withDurations) writeFileSync(join(repo, IMPACT_DURATIONS_PATH), '{"testResults":[]}\n');

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "seed"]);

  // AFTER the seed commit, so an untracked map stays untracked.
  if (withMap) writeFileSync(join(repo, IMPACT_MAP_PATH), '{"format":"test-impact 1","commit":"old"}\n');
  if (trackMap) {
    git(repo, ["add", "--", IMPACT_MAP_PATH]);
    git(repo, ["commit", "-m", "track the map (pre-#1018 shape)"]);
  }
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

describe("resolveMapWritability (#1018)", () => {
  it("says ok when the path is gitignored and untracked", async () => {
    await expect(resolveMapWritability(makeRepo())).resolves.toBe("ok");
  });

  it("says ok even before any map exists — a fresh clone must be able to build its first", async () => {
    // The old guard was `existsSync(map)`, which on an untracked map would mean a clone never
    // gets one. Writability is about SAFETY, not about a map already being there.
    const repo = makeRepo({ withMap: false });
    expect(existsSync(join(repo, IMPACT_MAP_PATH))).toBe(false);
    await expect(resolveMapWritability(repo)).resolves.toBe("ok");
  });

  it("says tracked for a checkout that still has the map committed", async () => {
    await expect(resolveMapWritability(makeRepo({ trackMap: true }))).resolves.toBe("tracked");
  });

  it("says not_ignored when the repo has no ignore rule for the path", async () => {
    await expect(resolveMapWritability(makeRepo({ ignoreMap: false }))).resolves.toBe("not_ignored");
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

  it("refuses a checkout that still TRACKS the map, and names the one-time remedy", async () => {
    // The transition case. Rewriting a tracked map shows up as a modification, and dirty main
    // blocks every subsequent merge — so the pass is inert until `git rm --cached` has been run.
    const tracked = makeRepo({ trackMap: true });
    const runner = makeRunner({ writes: "new\n" });
    const res = await runTestImpactMapPass(tracked, { runner });

    expect(res.outcome).toBe("map_tracked");
    expect(res.detail).toContain("git rm --cached");
    expect(runner.calls).toHaveLength(0);
    expect(dirtyFiles(tracked)).toBe("");
  });

  it("refuses a repo that has not gitignored the path — writing there would dirty main", async () => {
    // `git check-ignore` IS the opt-in marker, and it is a marker the pass verifies rather than
    // assumes. An untracked-but-unignored generated file is exactly the `dirty_main` shape.
    const unignored = makeRepo({ ignoreMap: false, withMap: false });
    const runner = makeRunner({ writes: "new\n" });
    const res = await runTestImpactMapPass(unignored, { runner });

    expect(res.outcome).toBe("map_not_ignored");
    expect(runner.calls).toHaveLength(0);
    expect(dirtyFiles(unignored)).toBe("");
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

  it("rebuilds a stale map IN PLACE and mints NO COMMIT (#1018)", async () => {
    // The heart of #1018. `chore: rebuild test-impact map` commits landed on master every few
    // minutes and each one moved the base tip under every running pre-merge gate, whose verdict
    // #243 then discards. The pass must now leave HEAD exactly where it found it.
    const before = git(repo, ["rev-parse", "HEAD"]);
    const res = await runTestImpactMapPass(repo, { runner: makeRunner({ writes: '{"commit":"new"}\n' }) });

    expect(res.outcome).toBe("rebuilt");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(before.startsWith(res.headSha!)).toBe(true);
    // The file is genuinely rewritten...
    expect(readFileSync(join(repo, IMPACT_MAP_PATH), "utf8")).toBe('{"commit":"new"}\n');
    // ...and git sees nothing at all, because the path is ignored. A rebuild that dirtied main
    // would block every subsequent merge just as surely as a commit would break a gate.
    expect(dirtyFiles(repo)).toBe("");
  });

  it("builds the FIRST map for a checkout that has none", async () => {
    // A fresh clone: the map is not in git any more, so nothing put one there.
    const fresh = makeRepo({ withMap: false });
    const runner = makeRunner({ writes: '{"commit":"first"}\n' });
    const res = await runTestImpactMapPass(fresh, { runner });

    expect(res.outcome).toBe("rebuilt");
    expect(readFileSync(join(fresh, IMPACT_MAP_PATH), "utf8")).toBe('{"commit":"first"}\n');
    expect(dirtyFiles(fresh)).toBe("");
  });

  it("leaves another agent's concurrent edit alone", async () => {
    // Several agents work in this checkout. The pass touches exactly one path and stages nothing,
    // so a neighbour's in-flight edit is neither committed nor reverted.
    writeFileSync(join(repo, "README.md"), "someone else is mid-edit\n");
    const head = git(repo, ["rev-parse", "HEAD"]);
    const res = await runTestImpactMapPass(repo, { runner: makeRunner({ writes: '{"commit":"new"}\n' }) });

    expect(res.outcome).toBe("rebuilt");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(dirtyFiles(repo)).toContain("README.md");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("someone else is mid-edit\n");
  });

  it("reports a failed build without leaving the tree dirty", async () => {
    const head = git(repo, ["rev-parse", "HEAD"]);
    const res = await runTestImpactMapPass(repo, { runner: makeRunner({ buildOk: false }) });

    expect(res.outcome).toBe("build_failed");
    expect(res.detail).toContain("REFUSING");
    expect(dirtyFiles(repo)).toBe("");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("SKIPS rather than waits when the repo lock is contended", async () => {
    // The lock no longer guards a commit — it stops two overlapping rebuilds interleaving into a
    // half-written map. Waiting would hold the lock a merge train wants; a stale map only widens.
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

  it("heartbeats the lock every 15s while the build runs, not just at acquisition (#1182)", async () => {
    // The build can run up to IMPACT_CLI_TIMEOUT_MS (180s), well past the 60s repo-lock staleness
    // window. Without a periodic heartbeat, a merge train waiting on the same repo lock sees a
    // heartbeat frozen at acquisition time while this holder's pid is provably alive — so
    // `probeHolderProcess` correctly refuses to steal it, and the train waits out its own 15-minute
    // bound instead of the map finishing in seconds. Fake timers drive the interval without a real
    // multi-minute build.
    vi.useFakeTimers();
    try {
      let heartbeats = 0;
      let resolveBuild!: () => void;
      const buildGate = new Promise<void>((r) => { resolveBuild = r; });

      const pending = runTestImpactMapPass(repo, {
        runner: async (_tool, args, cwd) => {
          if (args[0] === "check") return { code: 1, stdout: "", stderr: "", error: null };
          await buildGate;
          writeFileSync(join(cwd, IMPACT_MAP_PATH), '{"commit":"new"}\n');
          return { code: 0, stdout: "", stderr: "", error: null };
        },
        acquireLock: async () => ({
          path: "",
          contents: {} as never,
          heartbeat: () => { heartbeats++; },
          release: () => {},
        }),
      });

      // Let the pass reach `check`, acquire the lock, and register the heartbeat interval before
      // asserting on it. `rev-parse --short HEAD` inside the pass is a REAL child process (fake
      // timers don't affect it), so poll with real waits until the interval exists rather than
      // assuming a fixed number of fake-timer ticks gets us there.
      await vi.waitFor(
        () => {
          expect(vi.getTimerCount()).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 10 },
      );
      expect(heartbeats).toBe(0);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(heartbeats).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeats).toBe(3);

      resolveBuild();
      const res = await pending;
      expect(res.outcome).toBe("rebuilt");

      // The interval must be cleared on completion — no heartbeat fires after release.
      const afterCompletion = heartbeats;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeats).toBe(afterCompletion);
    } finally {
      vi.useRealTimers();
    }
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
    // is to leave the map alone, not to spend 7.4s on every sweep.
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

  it("rebuilds on a DETACHED HEAD, which the commit-era pass refused", async () => {
    // The old `detached_head` outcome existed only because there was no branch to commit onto.
    // Nothing is committed now, and a detached checkout still has a HEAD to stamp and a history
    // to read, so refusing there would be staleness bought for nothing.
    git(repo, ["checkout", "--detach"]);
    const runner = makeRunner({ writes: '{"commit":"detached"}\n' });
    const res = await runTestImpactMapPass(repo, { runner });

    expect(res.outcome).toBe("rebuilt");
    expect(runner.calls.some((c) => c.args[0] === "build")).toBe(true);
    expect(dirtyFiles(repo)).toBe("");
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
