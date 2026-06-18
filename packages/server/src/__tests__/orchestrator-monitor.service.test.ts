import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";

// A repo "ships a loop" iff scripts/board-monitor/loop.sh exists; the status reader keys
// liveness off loop.log freshness plus a loop.stopped marker. These tests exercise that
// marker logic (the Stop-shows-running-for-11min fix) without spawning any process.
describe("readOrchestratorStatus stop-marker", () => {
  let repo: string;
  let dir: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "orch-mon-"));
    dir = join(repo, "scripts", "board-monitor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "loop.sh"), "#!/usr/bin/env bash\n", "utf8");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function writeLog(ageMs: number) {
    const p = join(dir, "loop.log");
    writeFileSync(p, "[2026-01-01T00:00:00+00:00] --- iteration 1 START ---\n", "utf8");
    const when = new Date(Date.now() - ageMs);
    utimesSync(p, when, when);
  }

  it("reports alive when loop.log is fresh and no stop-marker exists", () => {
    writeLog(1000);
    expect(readOrchestratorStatus(repo).alive).toBe(true);
  });

  it("reports NOT alive when a stop-marker is newer than loop.log", () => {
    writeLog(60_000); // log written a minute ago
    // marker written now (newer than the log) => a Stop just happened
    writeFileSync(join(dir, "loop.stopped"), new Date().toISOString(), "utf8");
    expect(readOrchestratorStatus(repo).alive).toBe(false);
  });

  it("ignores a stale stop-marker once loop.log is written after it (restart supersedes)", () => {
    // marker dropped first...
    const marker = join(dir, "loop.stopped");
    writeFileSync(marker, "stopped", "utf8");
    const old = new Date(Date.now() - 120_000);
    utimesSync(marker, old, old);
    // ...then the loop restarts and writes a fresher log
    writeLog(1000);
    expect(readOrchestratorStatus(repo).alive).toBe(true);
  });

  it("stays NOT alive when loop.log is stale regardless of marker", () => {
    writeLog(20 * 60 * 1000); // 20 min old => past ALIVE_STALENESS_MS
    expect(readOrchestratorStatus(repo).alive).toBe(false);
  });
});
