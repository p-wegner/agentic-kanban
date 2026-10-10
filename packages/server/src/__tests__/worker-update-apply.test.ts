// #1355 — `update-check --apply`: a worker operator brings the RUNNING daemon to the board's build
// through its local control endpoint, with no manual kill. The board is a fake (manifest + tarball
// served by an injected fetch); the daemon half is the real createDaemonSelfUpdate + control server.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemonSelfUpdate, type DaemonSelfUpdate } from "../worker/worker-daemon-update.js";
import { applyWorkerUpdate, readControlFile, startWorkerControlServer, type WorkerControlServer } from "../worker/worker-control.js";
import { entryForBuild } from "../worker/worker-updater.js";

const OLD = "1111111";
const NEW_BUILD = "2222222222222222222222222222222222222222";
const tarball = Buffer.from("fake worker tarball");

describe("worker update-check --apply against a running daemon", () => {
  let dir: string;
  let servers: WorkerControlServer[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-apply-"));
    servers = [];
  });
  afterEach(async () => {
    for (const s of servers) await s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const stateFile = () => join(dir, "worker-state.json");

  function fakeBoard(over: { buildId?: string; tarballStatus?: number } = {}): typeof fetch {
    const buildId = over.buildId ?? NEW_BUILD;
    return (async (url: string) => {
      if (String(url).endsWith("/api/workers/build")) {
        return new Response(JSON.stringify({
          version: `0.1.9-dev.${buildId.slice(0, 7)}`, buildId, size: tarball.length, protocolVersion: 2, boardWorkerVersion: "0.1.9",
          sha256: createHash("sha256").update(tarball).digest("hex"),
        }), { status: 200 });
      }
      if (String(url).endsWith("/api/workers/build/tarball")) {
        return over.tarballStatus && over.tarballStatus !== 200 ? new Response("nope", { status: over.tarballStatus }) : new Response(tarball);
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  }

  /** Start a daemon "process" on `version`; `restart` swaps in the next one (a fresh control server). */
  async function startDaemon(version: string, fetchImpl: typeof fetch, onRestart?: (entry: string) => Promise<void>): Promise<DaemonSelfUpdate> {
    const su: DaemonSelfUpdate = createDaemonSelfUpdate({
      opts: {
        auto: false,
        entry: "/old/bin/worker.js",
        fetchImpl,
        npm: async (args) => {
          const prefix = args[args.indexOf("--prefix") + 1]!;
          const entry = entryForBuild(join(dir, "versions"), NEW_BUILD);
          mkdirSync(join(entry, ".."), { recursive: true });
          writeFileSync(entry, "// worker");
          expect(prefix).toContain(NEW_BUILD);
        },
        restart: async (entry) => { await onRestart?.(entry); },
      },
      stateFile: stateFile(),
      boardUrl: "http://board:3001",
      workerToken: () => "tok",
      workerVersion: version,
      log: () => {},
      runningCount: () => 0,
      settle: async () => {},
      drain: async () => {},
      undrain: async () => {},
      pollMs: 1,
    });
    const server = await startWorkerControlServer({
      stateFile: stateFile(), boardUrl: "http://board:3001", workerVersion: version, log: () => {},
      handlers: { updateNow: () => su.updateNow(), status: () => su.controlStatus() },
    });
    servers.push(server!);
    return su;
  }

  const run = (extra: Partial<Parameters<typeof applyWorkerUpdate>[0]> = {}) => {
    const lines: string[] = [];
    return applyWorkerUpdate({ stateFile: stateFile(), print: (l) => lines.push(l), pollMs: 5, timeoutMs: 5000, ...extra }).then((outcome) => ({ outcome, lines }));
  };

  it("a worker one build behind: the running daemon is brought to the board's build, reported as updated from X to Y", async () => {
    const board = fakeBoard();
    const restarted = vi.fn();
    await startDaemon(`0.1.9-dev.${OLD}`, board, async (entry) => {
      restarted(entry);
      await servers.pop()!.close(); // the old process ends
      await startDaemon(`0.1.9-dev.${NEW_BUILD.slice(0, 7)}`, board); // the new one comes up
    });
    const before = readControlFile(stateFile())!;
    const { outcome } = await run();
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toBe(`updated from ${OLD} to ${NEW_BUILD.slice(0, 7)}`);
    expect(restarted).toHaveBeenCalledOnce();
    expect(readControlFile(stateFile())!.token).not.toBe(before.token);
  });

  it("an already-current daemon is left alone", async () => {
    const restarted = vi.fn();
    await startDaemon(`0.1.9-dev.${NEW_BUILD.slice(0, 7)}`, fakeBoard(), restarted);
    const { outcome } = await run();
    expect(outcome).toEqual({ ok: true, summary: `already current (build ${NEW_BUILD.slice(0, 7)})` });
    expect(restarted).not.toHaveBeenCalled();
  });

  it("a failed download is reported with its phase and cause, and the daemon stays on its build", async () => {
    const restarted = vi.fn();
    await startDaemon(`0.1.9-dev.${OLD}`, fakeBoard({ tarballStatus: 404 }), restarted);
    const { outcome } = await run();
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toMatch(/^failed in download: .*HTTP 404/);
    expect(restarted).not.toHaveBeenCalled();
  });

  it("an unreachable board fails in the manifest phase", async () => {
    const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    await startDaemon(`0.1.9-dev.${OLD}`, down);
    const { outcome } = await run();
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toMatch(/^failed in manifest: .*ECONNREFUSED/);
  });

  it("no running daemon is a clear error, not a hang", async () => {
    const { outcome } = await run();
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toMatch(/no running worker daemon/);
  });

  it("the control endpoint refuses a request without the token", async () => {
    await startDaemon(`0.1.9-dev.${OLD}`, fakeBoard());
    const ctl = readControlFile(stateFile())!;
    const res = await fetch(`http://127.0.0.1:${ctl.port}/update`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});
