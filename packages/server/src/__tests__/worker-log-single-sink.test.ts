// @gate:always-run
// #1351: every `[worker]` line goes through the one logger that writes worker.log. A relaunched
// unsupervised worker has stdout on null, so a stray console.* in the runner / repo ops / result
// push silently loses the session lifecycle lines (setup, launch, exit, push).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWorkerLogSink, workerLog } from "../worker/worker-updater.js";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "worker");
// worker-daemon.ts holds the one sanctioned console.log: the base sink the file tee wraps.
// worker-updater.ts holds the default stdout sink (two spellings of the same fallback).
const ALLOWED: Record<string, number> = { "worker-daemon.ts": 1, "worker-updater.ts": 2 };

describe("worker modules log through the single worker.log sink (#1351)", () => {
  afterEach(() => setWorkerLogSink(null));

  it("no worker module calls console.* directly", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(WORKER_DIR).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(WORKER_DIR, f), "utf8");
      const n = (src.match(/\bconsole\.(log|warn|error|info|debug)\s*\(/g) ?? []).length;
      if (n > (ALLOWED[f] ?? 0)) offenders.push(`${f}: ${n}`);
    }
    expect(offenders).toEqual([]);
  });

  it("workerLog writes to the installed sink and appends extra args", () => {
    const lines: string[] = [];
    setWorkerLogSink((l) => lines.push(l));
    workerLog("[worker] agent exited: sessionId=s1 code=0");
    workerLog("[worker] push failed:", new Error("boom"));
    expect(lines[0]).toBe("[worker] agent exited: sessionId=s1 code=0");
    expect(lines[1]).toContain("boom");
  });

  it("falls back to stdout when no sink is installed", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    workerLog("[worker] hello");
    expect(spy).toHaveBeenCalledWith("[worker] hello");
    spy.mockRestore();
  });
});
