import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginCommand, type PluginCommandProgress } from "../services/plugin-exec.js";

/**
 * #1229 — a plugin script used to run as one blocking request with no evidence it was
 * alive until it finished, so a multi-minute analysis looked hung. `runPluginCommand` now
 * takes an optional `onProgress` that fires once immediately and then on a fixed tick while
 * the command runs, carrying elapsed time, the output tail so far, and the timeout limit —
 * this is what the `scripts/:name/run?stream=1` route relays to the client as SSE.
 */
describe("plugin-exec progress + timeout", () => {
  // Files, not `node -e "..."`: the sanctioned shell spec splits the command itself and does
  // NOT strip quotes (see plugin-exec-structured-stdout.test.ts), so quoted script bodies do
  // not survive the trip.
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-plugin-exec-progress-"));
  });

  it("calls onProgress immediately (elapsedMs 0) and again while the command is still running", async () => {
    const sleeper = join(dir, "sleep-and-print.mjs");
    writeFileSync(
      sleeper,
      "process.stdout.write('a');\n" +
        "await new Promise((r) => setTimeout(r, 1200));\n" +
        "process.stdout.write('b');\n",
      "utf8",
    );
    const events: PluginCommandProgress[] = [];
    const result = await runPluginCommand(`node ${sleeper}`, {
      cwd: process.cwd(),
      env: {},
      onProgress: (p) => events.push(p),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ab");
    // The immediate call, plus at least one tick from the ~1.2s sleep past the 1s interval.
    expect(events.length).toBeGreaterThanOrEqual(2);
    // "Immediate" allows for real scheduling/spawn jitter on a loaded box — the point is that
    // it fires before the command has had time to do meaningful work, not at exactly 0ms.
    expect(events[0].elapsedMs).toBeLessThan(500);
    // Every progress event carries the limit that would eventually apply, so a caller can
    // show it before it is ever hit.
    expect(events.every((e) => e.timeoutMs === 5 * 60 * 1000)).toBe(true);
    // A later event reflects the passage of time and has picked up the streamed output.
    const last = events[events.length - 1];
    expect(last.elapsedMs).toBeGreaterThan(0);
    expect(last.stdout).toContain("a");
  }, 10_000);

  it("a command that hits the timeout reports timedOut, and the caller was already told the limit", async () => {
    const hang = join(dir, "hang.mjs");
    // An unresolved bare Promise does NOT keep Node's event loop alive — the process would
    // simply exit once the module body finishes, defeating the test. A ticking interval does.
    writeFileSync(hang, "process.stdout.write('working');\nsetInterval(() => {}, 1000);\n", "utf8");
    const events: PluginCommandProgress[] = [];
    // Long enough that a loaded CI box has time to actually spawn node and flush the write
    // before the kill — the point under test is the LIMIT being known up front, not shaving
    // this close to zero.
    const timeoutMs = 1500;
    const result = await runPluginCommand(`node ${hang}`, {
      cwd: process.cwd(),
      env: {},
      timeoutMs,
      onProgress: (p) => events.push(p),
    });

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe("working");
    // The immediate call fired well before the process was killed, so the caller was told the
    // limit up front rather than discovering it only once the run already hit it.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].timeoutMs).toBe(timeoutMs);
    expect(events[0].elapsedMs).toBeLessThan(500);
  }, 10_000);
});
