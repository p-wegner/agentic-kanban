/**
 * #1773 — the attested profile set changes on a LIVE daemon (board push or `worker config set profiles`)
 * and is re-attested on the next heartbeat: same daemon, no restart, no reconnect.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import { setStartConfig, unsetStartConfig, persistedProfilesOverride, isStartConfigKey } from "../worker/worker-lifecycle.js";
import { createWorkerSettingsApplier } from "../worker/worker-settings-apply.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "ak-wprof-")); dirs.push(d); return d; };

describe("persisted profiles config (#1773)", () => {
  it("is a start-config key and yields a live override", () => {
    const stateFile = join(tmp(), "state.json");
    expect(isStartConfigKey("profiles")).toBe(true);
    expect(persistedProfilesOverride(stateFile)).toBeNull();
    expect(setStartConfig(stateFile, "profiles", "a, b")).toBeNull();
    expect(persistedProfilesOverride(stateFile)).toEqual({ profiles: ["a", "b"] });
    unsetStartConfig(stateFile, "profiles");
    expect(persistedProfilesOverride(stateFile, ["x"])).toEqual({ profiles: ["x"] });
    expect(persistedProfilesOverride(stateFile)).toEqual({ profiles: undefined });
  });

  it("the board's profiles setting applies live and seeds the next start", () => {
    const stateFile = join(tmp(), "state.json");
    const calls: string[][] = [];
    const controls = { setMaxConcurrency() {}, setLabels() {}, setDrain() {}, setProfiles: (p: string[]) => calls.push(p) };
    const applier = createWorkerSettingsApplier({ opts: {}, stateFile, boardUrl: "http://b", log: () => {} });
    applier.onHeartbeatResponse({ config: { rev: "r1", settings: { profiles: ["anth"] } } }, controls);
    expect(calls).toEqual([["anth"]]);
    expect(applier.effectiveOptions({ profiles: undefined as string[] | undefined })).toMatchObject({ profiles: ["anth"] });
  });
});

describe("a live daemon re-attests a changed profile set (#1773)", () => {
  it("swaps the attested profiles on the next heartbeat without restarting or reconnecting", async () => {
    const dir = tmp();
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    for (const n of ["anth", "team"]) writeFileSync(join(home, ".claude", `settings_${n}.json`), "{}");
    const stateFile = join(dir, "state.json");
    const heartbeats: Array<Record<string, any>> = [];
    const server: Server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/heartbeat")) {
        let body = "";
        req.on("data", (d) => { body += d; });
        req.on("end", () => { heartbeats.push(JSON.parse(body)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, socket: true })); });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
    const boardUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    writeFileSync(stateFile, JSON.stringify({ boards: { [boardUrl]: { workerId: "w1", workerToken: "t", name: "n" } } }));
    const lines: string[] = [];
    const handle: WorkerDaemonHandle = await startWorkerDaemon({
      boardUrl, stateFile, workRoot: join(dir, "work"), heartbeatIntervalMs: 40, attestProviders: false,
      profileHome: home, log: (l) => lines.push(l),
    });
    closers.push(() => handle.stop({ killAgents: true, drainTimeoutMs: 100 }).then(() => undefined));
    const names = (h: Record<string, any>): string[] => (h.capabilities.profiles ?? []).map((p: { name: string }) => p.name).sort();
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 30));
      expect(pred()).toBe(true);
    };
    await waitFor(() => heartbeats.some((h) => names(h).join() === "anth,team"));
    const connectsBefore = lines.filter((l) => /connected|reconnect/i.test(l)).length;

    setStartConfig(stateFile, "profiles", "anth");
    await waitFor(() => names(heartbeats[heartbeats.length - 1]!).join() === "anth");
    expect(lines.some((l) => l.includes("attested profiles changed"))).toBe(true);
    expect(lines.filter((l) => /connected|reconnect/i.test(l)).length).toBe(connectsBefore);
  });
});
