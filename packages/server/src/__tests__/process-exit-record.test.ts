/**
 * #373 — the dev backend died unattended for 15+ minutes and there was **no evidence to diagnose it
 * from**, which is the defect this covers. The load-bearing property is not "a log exists" but that
 * the log can DISTINGUISH the two cases, including the one where nothing can be written:
 *
 *   start with a matching exit record  => an explained shutdown, and it says which signal or code
 *   start with NO exit record          => killed without notice (OOM / taskkill /F / power loss)
 *
 * OOM was the ticket's leading unverified candidate precisely because it leaves no trace, so the
 * absence of a record has to be the signal. That is what these tests pin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendExitRecord,
  findUnexplainedExits,
  readExitRecords,
  recordProcessStart,
  trimExitLog,
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
    const unexplained = recordProcessStart(path);
    expect(unexplained.map((r) => r.pid)).toEqual([7777]);
    const after = readExitRecords(path);
    expect(after).toHaveLength(2);
    expect(after[1].kind).toBe("start");
    expect(after[1].pid).toBe(process.pid);
  });
});
