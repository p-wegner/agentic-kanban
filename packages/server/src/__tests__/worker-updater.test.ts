// #1338 — the worker's side of self-update.
//
// Pinned here, from the ticket: a daemon told of a newer build while a session runs does NOT
// update until that session ends; a checksum mismatch aborts and keeps the old build (and the
// worker leaves draining again); the relaunch argv equals the original minus `--token`;
// a supervised daemon exits with the dedicated code instead of spawning itself; install lands
// in a versioned directory, prunes beyond N and never prunes current/previous; a switched
// build that never connects rolls the worker back.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_UPDATE_EXIT_CODE,
  buildRelaunchCommand,
  parseBuildId,
  sameBuild,
  stripTokenArgs,
  type WorkerBuildManifest,
} from "../lib/worker-update.js";
import {
  BuildChecksumError,
  TransientUpdateError,
  createWorkerUpdater,
  describeFetchError,
  downloadBuild,
  entryForBuild,
  installBuild,
  pruneVersions,
  readFailure,
  readPending,
  readPointer,
  relaunchWorker,
  writePending,
  writePointer,
  type WorkerUpdaterDeps,
} from "../worker/worker-updater.js";
import { createDaemonSelfUpdate } from "../worker/worker-daemon-update.js";

const OWN = "1111111";
const NEW_BUILD = "2222222222222222222222222222222222222222";

function manifestFor(bytes: Buffer, buildId = NEW_BUILD): WorkerBuildManifest {
  return {
    version: `0.1.9-dev.${buildId.slice(0, 7)}`,
    buildId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    boardWorkerVersion: "0.1.9",
    protocolVersion: 2,
  };
}

describe("build identity + relaunch argv", () => {
  it("reads the commit out of a pack-worker stamp, and only out of one", () => {
    expect(parseBuildId("0.1.9-dev.AB12CD3")).toBe("ab12cd3");
    expect(parseBuildId("0.1.9")).toBeUndefined();
    expect(parseBuildId(undefined)).toBeUndefined();
    expect(sameBuild("ab12cd3", "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12")).toBe(true);
    expect(sameBuild("ab12cd3", "ff12cd34ef56ab12cd34ef56ab12cd34ef56ab12")).toBe(false);
    expect(sameBuild(undefined, "ab12cd3")).toBe(false);
  });

  it("relaunches with the original argv minus --token (both spellings), same state file and work root", () => {
    const original = [
      "start", "--board", "http://b:3003", "--token", "pair-secret", "--name", "win-box",
      "--state-file", "C:\\w\\state.json", "--work-root", "D:\\work", "--token=other", "--auto-update",
    ];
    expect(stripTokenArgs(original)).toEqual([
      "start", "--board", "http://b:3003", "--name", "win-box",
      "--state-file", "C:\\w\\state.json", "--work-root", "D:\\work", "--auto-update",
    ]);
    const cmd = buildRelaunchCommand(original, "/v/new/bin/worker.js", "/usr/bin/node");
    expect(cmd.command).toBe("/usr/bin/node");
    expect(cmd.args[0]).toBe("/v/new/bin/worker.js");
    expect(cmd.args.slice(1)).toEqual(stripTokenArgs(original));
    expect(cmd.args.join(" ")).not.toContain("pair-secret");
  });

  it("unsupervised: spawns the new build detached + hidden, then exits 0", () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    const exit = vi.fn();
    const cmd = relaunchWorker("/v/new/bin/worker.js", {
      argv: ["start", "--board", "http://b", "--token", "t"],
      execPath: "/usr/bin/node",
      supervised: false,
      spawnImpl: spawnImpl as never,
      exit,
    });
    expect(cmd?.args).toEqual(["/v/new/bin/worker.js", "start", "--board", "http://b"]);
    expect(spawnImpl).toHaveBeenCalledWith(
      "/usr/bin/node",
      cmd?.args,
      expect.objectContaining({ detached: true, windowsHide: true, stdio: "ignore" }),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("unsupervised with a log file: stdout/stderr are the file, not ignore (#1340)", () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    const openLog = vi.fn(() => 42);
    relaunchWorker("/v/new/bin/worker.js", {
      argv: ["start"],
      execPath: "node",
      supervised: false,
      spawnImpl: spawnImpl as never,
      exit: vi.fn(),
      logFile: "/home/worker.log",
      openLog,
    });
    expect(openLog).toHaveBeenCalledWith("/home/worker.log");
    const opts = (spawnImpl.mock.calls[0] as unknown as [string, string[], { stdio: unknown; env: NodeJS.ProcessEnv }])[2];
    expect(opts.stdio).toEqual(["ignore", 42, 42]);
    expect(opts.env.KANBAN_WORKER_LOG_INHERITED).toBe("1");
  });

  it("supervised: exits with the dedicated code and spawns nothing", () => {
    const spawnImpl = vi.fn();
    const exit = vi.fn();
    relaunchWorker("/v/new/bin/worker.js", { argv: ["start"], execPath: "node", supervised: true, spawnImpl: spawnImpl as never, exit });
    expect(exit).toHaveBeenCalledWith(WORKER_UPDATE_EXIT_CODE);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe("downloadBuild — verify before anything is installed", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ak-updater-dl-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fetchOf = (bytes: Buffer) => (async () => new Response(bytes)) as unknown as typeof fetch;

  it("keeps a download whose sha256 matches", async () => {
    const bytes = Buffer.from("good tarball");
    const destFile = join(dir, "dl", "b.tgz");
    await downloadBuild({ boardUrl: "http://b", workerToken: "t", manifest: manifestFor(bytes), destFile, fetchImpl: fetchOf(bytes) });
    expect(readFileSync(destFile)).toEqual(bytes);
  });

  it("deletes the file and throws on a checksum mismatch", async () => {
    const advertised = Buffer.from("what the board hashed");
    const served = Buffer.from("what actually arrived!");
    const destFile = join(dir, "dl", "b.tgz");
    await expect(
      downloadBuild({ boardUrl: "http://b", workerToken: "t", manifest: manifestFor(advertised), destFile, fetchImpl: fetchOf(served) }),
    ).rejects.toBeInstanceOf(BuildChecksumError);
    expect(existsSync(destFile)).toBe(false);
  });

  it("sends the worker bearer token", async () => {
    const bytes = Buffer.from("x");
    const seen: Array<string | null> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(bytes);
    }) as unknown as typeof fetch;
    await downloadBuild({ boardUrl: "http://b/", workerToken: "tok", manifest: manifestFor(bytes), destFile: join(dir, "a.tgz"), fetchImpl });
    expect(seen).toEqual(["Bearer tok"]);
  });
});

describe("installBuild + pruneVersions — side by side, never over the running package", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ak-updater-inst-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("installs into versions/<build> via npm --prefix and returns that build's entry", async () => {
    const npm = vi.fn(async (args: string[]) => {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const entry = entryForBuild(dir, "bbb");
      mkdirSync(join(entry, ".."), { recursive: true });
      writeFileSync(entry, "// worker");
      expect(prefix).toBe(join(dir, "bbb"));
    });
    const entry = await installBuild({ versionsDir: dir, buildId: "bbb", tarball: "/t/x.tgz", npm });
    expect(entry).toBe(entryForBuild(dir, "bbb"));
    expect(npm.mock.calls[0]![0]).toEqual(expect.arrayContaining(["install", "--prefix", join(dir, "bbb"), "/t/x.tgz"]));
    expect(npm.mock.calls[0]![0]).not.toContain("-g");
  });

  it("removes a half-installed prefix when npm fails", async () => {
    const npm = vi.fn(async () => { throw new Error("npm install failed: EBUSY"); });
    await expect(installBuild({ versionsDir: dir, buildId: "ccc", tarball: "/t/x.tgz", npm })).rejects.toThrow(/EBUSY/);
    expect(existsSync(join(dir, "ccc"))).toBe(false);
  });

  it("prunes versions beyond N, newest kept, never the protected current/previous", () => {
    const names = ["v1", "v2", "v3", "v4", "v5"];
    names.forEach((n, i) => {
      mkdirSync(join(dir, n));
      const t = new Date(Date.now() - (names.length - i) * 60_000);
      utimesSync(join(dir, n), t, t);
    });
    const removed = pruneVersions(dir, 2, ["v1"]);
    expect(removed.sort()).toEqual(["v2", "v3"]);
    expect(existsSync(join(dir, "v1"))).toBe(true); // oldest, but protected (the rollback target)
    expect(existsSync(join(dir, "v5"))).toBe(true);
    expect(existsSync(join(dir, "v4"))).toBe(true);
  });
});

describe("createWorkerUpdater — drain, wait, verify, switch", () => {
  function harness(over: Partial<WorkerUpdaterDeps> = {}) {
    const calls: string[] = [];
    let running = 0;
    const states: string[] = [];
    const bytes = Buffer.from("tarball");
    const deps: WorkerUpdaterDeps = {
      ownBuildId: OWN,
      auto: true,
      log: () => {},
      runningCount: () => running,
      drain: async () => { calls.push("drain"); },
      undrain: async () => { calls.push("undrain"); },
      fetchManifest: async () => { calls.push("manifest"); return manifestFor(bytes); },
      download: async () => { calls.push("download"); return "/tmp/x.tgz"; },
      install: async () => { calls.push("install"); return "/v/new/bin/worker.js"; },
      activate: () => { calls.push("activate"); },
      restart: async () => { calls.push("restart"); },
      onState: (r) => states.push(r.state + (r.reason ? `:${r.reason}` : "")),
      sleep: async () => { await Promise.resolve(); },
      pollMs: 1,
      ...over,
    };
    return { deps, calls, states, setRunning: (n: number) => { running = n; } };
  }

  it("does NOT update while a session is running — only after it ends", async () => {
    const h = harness();
    h.setRunning(1);
    const updater = createWorkerUpdater({
      ...h.deps,
      sleep: async () => {
        // the session finishes while the updater is waiting for it
        if (h.calls.filter((c) => c === "poll").length >= 3) h.setRunning(0);
        h.calls.push("poll");
        await Promise.resolve();
      },
    });
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    // #1352: the manifest is confirmed available first, THEN the worker drains
    expect(h.calls.slice(0, 2)).toEqual(["manifest", "drain"]);
    const beforeEnd = h.calls.slice(0, h.calls.indexOf("download"));
    expect(beforeEnd.filter((c) => c === "poll").length).toBeGreaterThanOrEqual(3); // it waited
    expect(h.calls).not.toContain("undrain");
    // nothing was downloaded/installed before the last session ended
    expect(h.calls.indexOf("download")).toBeGreaterThan(h.calls.lastIndexOf("poll"));
    expect(h.calls.slice(-4)).toEqual(["download", "install", "activate", "restart"]);
    expect(h.states.some((s) => s.includes("waiting for 1 running session"))).toBe(true);
  });

  it("with auto-update off, an advertised build is ignored; an explicit request still updates", async () => {
    const h = harness({ auto: false });
    const updater = createWorkerUpdater(h.deps);
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    expect(h.calls).toEqual([]);
    updater.onBoardBuild(NEW_BUILD, true);
    await updater.idle();
    expect(h.calls).toContain("restart");
  });

  it("is a no-op when the board's build is the worker's own (prefix match)", async () => {
    const h = harness({ ownBuildId: "2222222" });
    const updater = createWorkerUpdater(h.deps);
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    expect(h.calls).toEqual([]);
    expect(updater.state().state).toBe("current");
  });

  it("an unstamped worker never self-updates, and says why", async () => {
    const h = harness({ ownBuildId: undefined });
    const updater = createWorkerUpdater(h.deps);
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    expect(h.calls).toEqual([]);
    expect(updater.state()).toMatchObject({ state: "failed" });
  });

  it("a checksum mismatch aborts: nothing installed or switched, back in rotation, reported failed", async () => {
    const advertised = Buffer.from("advertised");
    const dir = mkdtempSync(join(tmpdir(), "ak-updater-cs-"));
    try {
      const h = harness();
      const updater = createWorkerUpdater({
        ...h.deps,
        fetchManifest: async () => manifestFor(advertised),
        download: async (manifest) => {
          h.calls.push("download");
          await downloadBuild({
            boardUrl: "http://b",
            workerToken: "t",
            manifest,
            destFile: join(dir, "x.tgz"),
            fetchImpl: (async () => new Response(Buffer.from("tampered"))) as unknown as typeof fetch,
          });
          return join(dir, "x.tgz");
        },
      });
      updater.onBoardBuild(NEW_BUILD);
      await updater.idle();
      expect(h.calls).toEqual(["drain", "download", "undrain"]);
      expect(h.calls).not.toContain("install");
      expect(h.calls).not.toContain("activate");
      expect(h.calls).not.toContain("restart");
      expect(updater.state()).toMatchObject({ state: "failed", targetBuild: NEW_BUILD });
      expect(updater.state().reason).toMatch(/checksum mismatch/);
      expect(existsSync(join(dir, "x.tgz"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not retry a build that failed on every heartbeat, but an explicit request does", async () => {
    const h = harness({ install: async () => { h.calls.push("install"); throw new Error("EBUSY"); } });
    const updater = createWorkerUpdater(h.deps);
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    expect(h.calls.filter((c) => c === "install")).toHaveLength(1);
    updater.onBoardBuild(NEW_BUILD); // next heartbeat, same build
    await updater.idle();
    expect(h.calls.filter((c) => c === "install")).toHaveLength(1);
    updater.onBoardBuild(NEW_BUILD, true); // `worker update`
    await updater.idle();
    expect(h.calls.filter((c) => c === "install")).toHaveLength(2);
  });

  it("waits for the board to finish packing (202) before downloading", async () => {
    let polls = 0;
    const h = harness();
    const updater = createWorkerUpdater({
      ...h.deps,
      fetchManifest: async () => (++polls < 3 ? "building" : manifestFor(Buffer.from("t"))),
    });
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    expect(polls).toBe(3);
    expect(h.calls).toContain("restart");
  });

  it("does NOT drain while the manifest answers 202 — assigns keep landing until it is 200 (#1352)", async () => {
    let polls = 0;
    const h = harness();
    const drainedAtPoll: number[] = [];
    const updater = createWorkerUpdater({
      ...h.deps,
      drain: async () => { drainedAtPoll.push(polls); h.calls.push("drain"); },
      fetchManifest: async () => (++polls < 4 ? "building" : manifestFor(Buffer.from("t"))),
    });
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    expect(drainedAtPoll).toEqual([4]); // drained only after the 4th poll finally answered 200
    expect(h.states.filter((s) => s.includes("draining"))).toHaveLength(1);
  });

  it("a transient failure is retried with backoff and never pins the build as failed (#1352)", async () => {
    let tries = 0;
    const recorded: unknown[] = [];
    const h = harness();
    const updater = createWorkerUpdater({
      ...h.deps,
      retryBackoffMs: [1, 1],
      recordFailure: (f) => recorded.push(f),
      download: async () => {
        h.calls.push("download");
        if (++tries < 3) throw new TransientUpdateError("GET http://b/x failed: fetch failed (cause: ECONNRESET: reset)");
        return "/tmp/x.tgz";
      },
    });
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    expect(tries).toBe(3);
    expect(h.calls).toContain("restart");
    expect(recorded).toEqual([]);

    // retries exhausted: recorded as transient, back in rotation, next heartbeat tries again
    const h2 = harness();
    const rec2: Array<{ phase: string; transient: boolean; reason: string }> = [];
    let tries2 = 0;
    const u2 = createWorkerUpdater({
      ...h2.deps,
      retryBackoffMs: [1],
      recordFailure: (f) => rec2.push(f),
      download: async () => { tries2++; throw new TransientUpdateError("HTTP 503"); },
    });
    u2.onBoardBuild(NEW_BUILD);
    await u2.idle();
    expect(tries2).toBe(2);
    expect(rec2).toEqual([expect.objectContaining({ phase: "download", transient: true })]);
    expect(h2.calls).toContain("undrain");
    u2.onBoardBuild(NEW_BUILD); // not pinned: the next heartbeat retries
    await u2.idle();
    expect(tries2).toBe(4);
  });

  it("records a checksum failure as non-transient with its phase (#1352)", async () => {
    const rec: Array<{ phase: string; transient: boolean }> = [];
    const h = harness();
    const updater = createWorkerUpdater({
      ...h.deps,
      recordFailure: (f) => rec.push(f),
      download: async () => { throw new BuildChecksumError("a", "b"); },
    });
    updater.onBoardBuild(NEW_BUILD);
    await updater.idle();
    expect(rec).toEqual([expect.objectContaining({ phase: "checksum", transient: false })]);
  });

  it("describeFetchError surfaces undici's err.cause (#1352)", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    expect(describeFetchError(err)).toBe("fetch failed (cause: ECONNRESET: read ECONNRESET)");
  });
});

describe("createDaemonSelfUpdate — the switch, the confirm, the rollback", () => {
  let dir: string;
  const stateFile = () => join(dir, "worker-state.json");
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ak-updater-daemon-")); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  function make(over: { workerVersion?: string; restart?: (e: string) => void; confirmTimeoutMs?: number } = {}) {
    const restart = vi.fn(over.restart ?? (() => {}));
    const logs: string[] = [];
    const su = createDaemonSelfUpdate({
      opts: { auto: true, entry: "/old/bin/worker.js", restart, confirmTimeoutMs: over.confirmTimeoutMs ?? 5000 },
      stateFile: stateFile(),
      boardUrl: "http://b",
      workerToken: () => "t",
      workerVersion: over.workerVersion ?? `0.1.9-dev.${NEW_BUILD.slice(0, 7)}`,
      log: (l) => logs.push(l),
      runningCount: () => 0,
      settle: async () => {},
      drain: async () => {},
      undrain: async () => {},
    });
    return { su, restart, logs };
  }

  const versionsDir = () => join(dir, "versions");

  it("a new build that connects confirms the switch (pending marker cleared)", () => {
    writePending(versionsDir(), { buildId: NEW_BUILD, previousEntry: "/old/bin/worker.js", previousBuildId: OWN, startedAt: new Date().toISOString(), attempts: 0 });
    const { su, restart } = make();
    su.begin();
    expect(readPending(versionsDir())?.attempts).toBe(1);
    su.onConnected();
    expect(readPending(versionsDir())).toBeNull();
    su.dispose();
    expect(restart).not.toHaveBeenCalled();
  });

  it("a new build that never connects rolls back to the previous entry and records why", async () => {
    vi.useFakeTimers();
    writePointer(versionsDir(), { buildId: NEW_BUILD, entry: "/v/new/bin/worker.js", previousBuildId: OWN, previousEntry: "/old/bin/worker.js" });
    writePending(versionsDir(), { buildId: NEW_BUILD, previousEntry: "/old/bin/worker.js", previousBuildId: OWN, startedAt: new Date().toISOString(), attempts: 0 });
    const { su, restart } = make({ confirmTimeoutMs: 5000 });
    su.begin();
    await vi.advanceTimersByTimeAsync(5001);
    expect(restart).toHaveBeenCalledWith("/old/bin/worker.js");
    expect(readPointer(versionsDir())?.entry).toBe("/old/bin/worker.js");
    expect(readPending(versionsDir())).toBeNull();
    expect(readFailure(versionsDir())).toMatchObject({ buildId: NEW_BUILD });
    expect(readFailure(versionsDir())?.reason).toMatch(/did not connect/);
  });

  it("a build restarted too many times without connecting is rolled back immediately", async () => {
    writePending(versionsDir(), { buildId: NEW_BUILD, previousEntry: "/old/bin/worker.js", startedAt: new Date().toISOString(), attempts: 3 });
    const { su, restart } = make();
    su.begin();
    await vi.waitFor(() => expect(restart).toHaveBeenCalledWith("/old/bin/worker.js"));
    expect(readFailure(versionsDir())?.reason).toMatch(/without ever connecting/);
  });

  it("the rolled-back build REPORTS the failure instead of retrying it", () => {
    mkdirSync(versionsDir(), { recursive: true });
    writeFileSync(join(versionsDir(), "last-update.json"), JSON.stringify({ buildId: NEW_BUILD, reason: "did not connect", at: new Date().toISOString() }));
    const { su } = make({ workerVersion: `0.1.9-dev.${OWN}` });
    expect(su.state()).toMatchObject({ state: "failed", reason: "did not connect", targetBuild: NEW_BUILD });
    su.onHeartbeatResponse({ boardBuildId: NEW_BUILD, updateNow: false }); // automatic: not retried
    expect(su.state().state).toBe("failed");
  });
});
