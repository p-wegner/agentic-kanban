/**
 * #373 — the dev backend died unattended for 15+ minutes and there was **no evidence to diagnose it
 * from**, which is the defect this covers. The load-bearing property is not "a log exists" but that
 * the log can DISTINGUISH the two cases, including the one where nothing can be written:
 *
 *   start with a matching exit record  => an explained shutdown, and it says which signal or code
 *   start with NO exit record          => killed without notice (OOM / taskkill /F / power loss)
 *
 * OOM was the ticket's leading unverified candidate precisely because it leaves no trace, so the
 * absence of a record is part of the signal. Only part, though — see the heartbeat block at the bottom
 * of this file for why absence ALONE turned out to be worthless here, and what replaced it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendExitRecord,
  findUnexplainedExits,
  readExitRecords,
  outageBeforeStartMs,
  readHeartbeat,
  recordProcessStart,
  startHeartbeat,
  trimExitLog,
  writeHeartbeat,
  OUTAGE_REPORT_THRESHOLD_MS,
  type ExitRecord,
} from "../lib/exit-record.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exit-record-"));
  path = join(dir, "process-exit-log.jsonl");
});

afterEach(() => {
  delete process.env.KANBAN_EXIT_LOG_FILE;
  rmSync(dir, { recursive: true, force: true });
});

function record(kind: ExitRecord["kind"], pid: number, extra: Partial<ExitRecord> = {}): ExitRecord {
  return {
    at: new Date().toISOString(),
    kind,
    pid,
    uptimeMs: 1000,
    memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1, osFreeBytes: 1, osTotalBytes: 2 },
    ...extra,
  };
}

describe("exit record survives process death (#373)", () => {
  it("persists the signal, pid, uptime and memory of a shutdown, and reads back what it wrote", () => {
    expect(appendExitRecord({ kind: "signal", signal: "SIGTERM" }, path)).toBe(true);
    const [written] = readExitRecords(path);
    expect(written.kind).toBe("signal");
    expect(written.signal).toBe("SIGTERM");
    expect(written.pid).toBe(process.pid);
    expect(written.uptimeMs).toBeGreaterThanOrEqual(0);
    // The OOM candidate the ticket could not settle stands or falls on these numbers.
    expect(written.memory.rssBytes).toBeGreaterThan(0);
    expect(written.memory.osTotalBytes).toBeGreaterThan(0);
    expect(Date.parse(written.at)).not.toBeNaN();
  });

  it("appends rather than replacing, so a whole day of restarts is one readable history", () => {
    appendExitRecord({ kind: "start" }, path);
    appendExitRecord({ kind: "signal", signal: "SIGTERM" }, path);
    appendExitRecord({ kind: "exit", code: 0 }, path);
    expect(readExitRecords(path).map((r) => r.kind)).toEqual(["start", "signal", "exit"]);
  });

  it("identifies a death that left NO record — the OOM/hard-kill signature", () => {
    // pid 111 started and never wrote anything again. pid 222 shut down cleanly.
    const records = [
      record("start", 111),
      record("start", 222),
      record("signal", 222, { signal: "SIGTERM" }),
      record("exit", 222, { code: 0 }),
    ];
    const unexplained = findUnexplainedExits(records, /* currentPid */ 999);
    expect(unexplained.map((r) => r.pid)).toEqual([111]);
  });

  it("does not accuse the CURRENTLY RUNNING process of having died", () => {
    const records = [record("start", 4242)];
    expect(findUnexplainedExits(records, 4242)).toEqual([]);
    expect(findUnexplainedExits(records, 1).map((r) => r.pid)).toEqual([4242]);
  });

  it("calls an ordinary explained restart explained, however many times it happens", () => {
    const records = [
      record("start", 1), record("signal", 1, { signal: "SIGTERM" }), record("exit", 1, { code: 0 }),
      record("start", 2), record("signal", 2, { signal: "SIGTERM" }), record("exit", 2, { code: 0 }),
      record("start", 3),
    ];
    // `tsx watch` reloads all day; none of them may be reported as a mystery.
    expect(findUnexplainedExits(records, 3)).toEqual([]);
  });

  it("survives a torn last line — the write interrupted by the death being recorded", () => {
    writeFileSync(path, `${JSON.stringify(record("start", 5))}\n{"kind":"exit","at":"2026-`, "utf8");
    const parsed = readExitRecords(path);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pid).toBe(5);
    // ...and the torn start is still correctly reported as unexplained rather than swallowed.
    expect(findUnexplainedExits(parsed, 999).map((r) => r.pid)).toEqual([5]);
  });

  it("never throws and never changes an exit code when the log cannot be written", () => {
    // A directory where a file is expected: the failure mode a read-only or full disk produces.
    expect(appendExitRecord({ kind: "signal", signal: "SIGTERM" }, dir)).toBe(false);
    expect(readExitRecords(dir)).toEqual([]);
  });

  it("bounds the log at startup, keeping the NEWEST lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify(record("start", i)));
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    trimExitLog(path, 10);
    const kept = readExitRecords(path);
    expect(kept).toHaveLength(10);
    expect(kept.map((r) => r.pid)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });

  it("reports the previous notice-less death at the next boot, then records its own start", () => {
    writeFileSync(path, `${JSON.stringify(record("start", 7777))}\n`, "utf8");
    const { unexplained } = recordProcessStart(path, join(dir, "alive.json"));
    expect(unexplained.map((r) => r.pid)).toEqual([7777]);
    const after = readExitRecords(path);
    expect(after).toHaveLength(2);
    expect(after[1].kind).toBe("start");
    expect(after[1].pid).toBe(process.pid);
  });
});

/**
 * The correction that made the above usable. The first version shipped with only start/exit records,
 * and its own live output within the hour showed **five consecutive `start` records with no exit
 * record between any of them** — because the dev watch wrapper KILLS the child instead of signalling
 * it, so an ordinary file-edit reload is indistinguishable from an OOM kill. An indicator that fires
 * on every routine event is as useless as one that never fires.
 *
 * The heartbeat is what separates them, and it is the figure the ticket actually asked for: the board
 * was DOWN for N seconds. A reload gives seconds; the reported incident gave 15+ minutes.
 */
describe("heartbeat turns 'no exit record' into an OUTAGE DURATION (#373)", () => {
  let beatPath: string;

  beforeEach(() => {
    beatPath = join(dir, "process-alive.json");
  });

  it("round-trips liveness, and a process's own heartbeat is never evidence that IT was down", () => {
    writeHeartbeat(beatPath);
    const beat = readHeartbeat(beatPath);
    expect(beat?.pid).toBe(process.pid);
    expect(outageBeforeStartMs(beat)).toBeNull();
  });

  it("measures the gap since ANOTHER process was last alive — the 15-minute outage figure", () => {
    const fifteenAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    const gap = outageBeforeStartMs({ at: fifteenAgo, pid: 4242, uptimeMs: 1 }, Date.now(), 999);
    expect(gap).not.toBeNull();
    expect(gap!).toBeGreaterThan(14 * 60_000);
    expect(gap!).toBeGreaterThan(OUTAGE_REPORT_THRESHOLD_MS);
  });

  it("does NOT call a watch reload an outage — the whole reason this exists", () => {
    const twoSecondsAgo = new Date(Date.now() - 2_000).toISOString();
    const gap = outageBeforeStartMs({ at: twoSecondsAgo, pid: 4242, uptimeMs: 1 }, Date.now(), 999);
    expect(gap!).toBeLessThan(OUTAGE_REPORT_THRESHOLD_MS);
  });

  it("treats a missing, malformed or future heartbeat as no evidence rather than as an outage", () => {
    expect(readHeartbeat(join(dir, "absent.json"))).toBeNull();
    writeFileSync(beatPath, "not json", "utf8");
    expect(readHeartbeat(beatPath)).toBeNull();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(outageBeforeStartMs({ at: future, pid: 1, uptimeMs: 1 }, Date.now(), 999)).toBeNull();
  });

  it("stamps immediately and cannot hold the process open", () => {
    const timer = startHeartbeat(30_000, beatPath);
    try {
      // The immediate stamp matters: a process that dies inside its first interval must still leave a
      // lower bound on when it was last alive.
      expect(readHeartbeat(beatPath)).not.toBeNull();
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it("recordProcessStart reports the outage alongside the unexplained start", () => {
    writeFileSync(path, JSON.stringify(record("start", 8888)) + "\n", "utf8");
    writeFileSync(beatPath, JSON.stringify({ at: new Date(Date.now() - 20 * 60_000).toISOString(), pid: 8888, uptimeMs: 1 }), "utf8");
    const { unexplained, outageMs } = recordProcessStart(path, beatPath);
    expect(unexplained.map((r) => r.pid)).toEqual([8888]);
    expect(outageMs!).toBeGreaterThan(19 * 60_000);
  });
});
