/**
 * #1381 — the worker's side: applies the board's pushed settings live, persists them, lets a
 * start flag pin a key, and starts from what the board last pushed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import {
  createWorkerSettingsApplier, loadPersistedSettings, pinnedSettingKeys, type WorkerSettingsControls,
} from "../worker/worker-settings-apply.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-wsettings-"));
  dirs.push(d);
  return d;
}

function controls() {
  const calls: string[] = [];
  const c: WorkerSettingsControls = {
    setMaxConcurrency: (n) => calls.push(`max=${n}`),
    setLabels: (l) => calls.push(`labels=${l.join("|")}`),
    setDrain: (on) => calls.push(`drain=${on}`),
  };
  return { calls, c };
}

describe("worker settings applier (#1381)", () => {
  it("pins exactly the keys a start flag gave", () => {
    expect(pinnedSettingKeys({})).toEqual([]);
    expect(pinnedSettingKeys({ labels: ["a"], maxConcurrency: 2, profileAliases: [] })).toEqual(["maxConcurrency", "labels", "profileAlias"]);
  });

  it("applies concurrency, labels and drain live, persists them, and reports the applied rev", () => {
    const stateFile = join(tmp(), "state.json");
    const lines: string[] = [];
    const applier = createWorkerSettingsApplier({ opts: {}, stateFile, boardUrl: "http://b", log: (l) => lines.push(l) });
    const { calls, c } = controls();
    applier.onHeartbeatResponse({ config: { rev: "r1", settings: { maxConcurrency: 4, labels: ["docker"], drain: true } } }, c);
    expect(calls).toEqual(["max=4", "labels=docker", "drain=true"]);
    expect(applier.report().appliedRev).toBe("r1");
    expect(loadPersistedSettings(stateFile, "http://b")?.settings).toMatchObject({ maxConcurrency: 4 });
    // Same revision again is a no-op; a later one undrains because the board asked for the drain.
    applier.onHeartbeatResponse({ config: { rev: "r1", settings: { maxConcurrency: 9 } } }, c);
    applier.onHeartbeatResponse({ config: { rev: "r2", settings: { maxConcurrency: 4, labels: ["docker"] } } }, c);
    expect(calls).toEqual(["max=4", "labels=docker", "drain=true", "drain=false"]);
  });

  it("leaves a flag-pinned key alone but still reports it", () => {
    const applier = createWorkerSettingsApplier({ opts: { maxConcurrency: 1 }, stateFile: join(tmp(), "s.json"), boardUrl: "http://b", log: () => {} });
    const { calls, c } = controls();
    applier.onHeartbeatResponse({ config: { rev: "r1", settings: { maxConcurrency: 8, labels: ["x"] } } }, c);
    expect(calls).toEqual(["labels=x"]);
    expect(applier.report().pinned).toEqual(["maxConcurrency"]);
  });

  it("does not undrain a drain the board never asked for", () => {
    const applier = createWorkerSettingsApplier({ opts: {}, stateFile: join(tmp(), "s.json"), boardUrl: "http://b", log: () => {} });
    const { calls, c } = controls();
    applier.onHeartbeatResponse({ config: { rev: "r1", settings: { drain: false } } }, c);
    expect(calls).toEqual([]);
  });

  it("a restart starts from the persisted settings, with a flag winning per key", () => {
    const stateFile = join(tmp(), "state.json");
    const first = createWorkerSettingsApplier({ opts: {}, stateFile, boardUrl: "http://b", log: () => {} });
    first.onHeartbeatResponse({ config: { rev: "r1", settings: { maxConcurrency: 5, labels: ["gpu"], drain: true } } }, controls().c);
    const again = createWorkerSettingsApplier({ opts: { labels: ["flag"] }, stateFile, boardUrl: "http://b", log: () => {} });
    expect(again.effectiveOptions({ labels: ["flag"] as string[] | undefined, maxConcurrency: undefined as number | undefined }))
      .toMatchObject({ labels: ["flag"], maxConcurrency: 5 });
    expect(again.startDrained()).toBe(true);
    expect(again.report().appliedRev).toBe("r1");
  });
});

describe("worker daemon applies board settings without a restart (#1381)", () => {
  it("takes max concurrency and labels from the heartbeat response and persists them", async () => {
    const dir = tmp();
    const stateFile = join(dir, "state.json");
    const heartbeats: Array<Record<string, any>> = [];
    let push: Record<string, unknown> | null = null;
    const server: Server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/heartbeat")) {
        let body = "";
        req.on("data", (d) => { body += d; });
        req.on("end", () => {
          heartbeats.push(JSON.parse(body));
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, socket: true, ...(push ? { config: push } : {}) }));
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
    const boardUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    writeFileSync(stateFile, JSON.stringify({ boards: { [boardUrl]: { workerId: "w1", workerToken: "t", name: "n" } } }));

    const handle: WorkerDaemonHandle = await startWorkerDaemon({
      boardUrl, stateFile, workRoot: join(dir, "work"), heartbeatIntervalMs: 40, attestProviders: false,
      labels: ["pinned-by-flag"], log: () => {},
    });
    closers.push(() => handle.stop({ killAgents: true, drainTimeoutMs: 100 }).then(() => undefined));

    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 30));
      expect(pred()).toBe(true);
    };
    await waitFor(() => heartbeats.length > 0);
    expect(heartbeats[0]!.settings.pinned).toEqual(["labels"]);

    push = { rev: "rev-1", settings: { maxConcurrency: 6, labels: ["board-label"] } };
    await waitFor(() => heartbeats.some((h) => h.settings?.appliedRev === "rev-1"));
    const last = heartbeats[heartbeats.length - 1]!;
    // Concurrency applied live and reported on the next beat; the flag-pinned labels stayed.
    expect(last.capabilities.maxConcurrency).toBe(6);
    expect(last.capabilities.labels).toEqual(["pinned-by-flag"]);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(persisted.settings[boardUrl].rev).toBe("rev-1");
    expect(persisted.boards[boardUrl].workerId).toBe("w1");
  });
});
