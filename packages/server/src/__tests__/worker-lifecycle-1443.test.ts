// #1443 — worker lifecycle: persisted start args, `status`, stop/restart over the control endpoint,
// and `update-check --apply --no-wait` reporting a drain as progress rather than failure.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyWorkerUpdate,
  fetchWorkerStatus,
  requestWorkerShutdown,
  startWorkerControlServer,
  type WorkerControlServer,
} from "../worker/worker-control.js";
import {
  applyStartConfig,
  buildLifecycleDetails,
  loadStartConfig,
  renderStatus,
  setStartConfig,
  unsetStartConfig,
  type LifecycleCtx,
} from "../worker/worker-lifecycle.js";
import { parseDuration, waitOption } from "../cli/commands/worker-lifecycle-command.js";

describe("worker lifecycle (#1443)", () => {
  let dir: string;
  let server: WorkerControlServer | null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-lifecycle-"));
    server = null;
  });
  afterEach(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const stateFile = () => join(dir, "worker-state.json");

  describe("persisted start args", () => {
    it("unset drops an argv pin, set overrides it, and the rest of the state file survives", () => {
      writeFileSync(stateFile(), JSON.stringify({ boards: { a: { workerId: "w" } } }));
      expect(applyStartConfig({ maxConcurrency: 2, labels: "x" }, stateFile())).toEqual({ maxConcurrency: 2, labels: "x" });

      expect(unsetStartConfig(stateFile(), "maxConcurrency")).toBeNull();
      expect(applyStartConfig({ maxConcurrency: 2, labels: "x" }, stateFile())).toEqual({ maxConcurrency: undefined, labels: "x" });

      expect(setStartConfig(stateFile(), "maxConcurrency", "3")).toBeNull();
      expect(loadStartConfig(stateFile())).toEqual({ set: { maxConcurrency: "3" }, unset: [] });
      expect(applyStartConfig({ maxConcurrency: 2 }, stateFile()).maxConcurrency).toBe(3);

      expect(JSON.parse(readFileSync(stateFile(), "utf8")).boards).toEqual({ a: { workerId: "w" } });
    });

    it("rejects unknown keys and bad values", () => {
      expect(setStartConfig(stateFile(), "nope", "1")).toMatch(/unknown key/);
      expect(setStartConfig(stateFile(), "maxConcurrency", "0")).toMatch(/between 1 and 64/);
      expect(setStartConfig(stateFile(), "labels", undefined)).toMatch(/needs a value/);
      expect(unsetStartConfig(stateFile(), "nope")).toMatch(/unknown key/);
    });
  });

  describe("status", () => {
    const ctx = (over: Partial<LifecycleCtx> = {}): LifecycleCtx => ({
      stateFile: stateFile(),
      workRoot: "/work",
      boardUrl: "http://board",
      draining: () => false,
      sessionsLeft: () => 0,
      effective: () => ({ maxConcurrency: 2 }),
      pinned: () => ["maxConcurrency"],
      desired: () => ({ maxConcurrency: 4 }),
      ...over,
    });

    it("shows a board-desired setting a flag pins as `desired 4, pinned 2 by --max-concurrency`", () => {
      const text = renderStatus({ workerVersion: "0.1.9-dev.abc1234", pid: 1, boardUrl: "http://board", ...buildLifecycleDetails(ctx()) });
      expect(text).toContain("desired 4, pinned 2 by --max-concurrency");
      expect(text).toContain("state file:");
      expect(text).toContain("work root:");
    });

    it("shows it unpinned once the pin is gone", () => {
      const text = renderStatus({ pid: 1, ...buildLifecycleDetails(ctx({ pinned: () => [], effective: () => ({ maxConcurrency: 4 }) })) });
      expect(text).toMatch(/maxConcurrency\s+4 \(from the board\)/);
      expect(text).not.toContain("pinned by");
    });

    it("names `config set` as the pinning source", () => {
      setStartConfig(stateFile(), "maxConcurrency", "2");
      expect(JSON.stringify(buildLifecycleDetails(ctx()))).toContain("config set maxConcurrency");
    });
  });

  describe("control endpoint", () => {
    async function serve(sessionsLeft: number, shutdown = vi.fn()) {
      server = await startWorkerControlServer({
        stateFile: stateFile(), boardUrl: "http://board", workerVersion: "v1", log: () => {},
        handlers: {
          updateNow: async () => ({ result: "started", from: "v1", to: "v2" }),
          status: () => ({ pid: 1, boardUrl: "http://board", workerVersion: "v1", update: { state: "updating", reason: `waiting for ${sessionsLeft} session(s)` } }),
          details: () => ({ sessionsLeft, draining: true }),
          shutdown: (req) => { shutdown(req); return { ok: true, sessionsLeft, drain: req.drain, restart: req.restart }; },
        },
      });
      return shutdown;
    }

    it("serves status details and routes stop/restart", async () => {
      const shutdown = await serve(2);
      expect((await fetchWorkerStatus(stateFile()))?.sessionsLeft).toBe(2);
      const r = await requestWorkerShutdown({ stateFile: stateFile(), restart: true, drain: true });
      expect(r.ok && r.ack).toMatchObject({ restart: true, drain: true, sessionsLeft: 2 });
      expect(shutdown).toHaveBeenCalledWith({ restart: true, drain: true });
    });

    it("update-check --apply --no-wait exits 0 mid-drain with the progress message", async () => {
      await serve(2);
      const outcome = await applyWorkerUpdate({ stateFile: stateFile(), print: () => {}, pollMs: 1, ...waitOption(false) });
      expect(outcome).toEqual({ ok: true, summary: "drain in progress, 2 session(s) left; check with: agentic-kanban-worker status" });
    });

    it("a --wait that runs out mid-drain is also progress, not a failure", async () => {
      await serve(1);
      const outcome = await applyWorkerUpdate({ stateFile: stateFile(), print: () => {}, pollMs: 1, ...waitOption("20ms") });
      expect(outcome.ok).toBe(true);
      expect(outcome.summary).toContain("drain in progress, 1 session(s) left");
    });
  });

  it("parses durations", () => {
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("soon")).toBeNull();
  });
});
