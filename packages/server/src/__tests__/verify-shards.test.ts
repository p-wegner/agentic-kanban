import { describe, expect, it } from "vitest";
import { mergeShardReports, pickShardWorkers, shardByDuration } from "../services/verify-shards.js";
import { rankVerifyWorkers } from "../services/verify-placement.js";

const allow = new Set(["a", "b"]);
const w = (name: string, builderSessions = 0) => ({ id: name, name, freeSlots: 1, builderSessions });

describe("verify shards (#1578)", () => {
  it("splits a selection into two balanced shards", () => {
    const files = [90, 80, 30, 20, 10, 10].map((ms, i) => ({ entry: `server:f${i}.test.ts`, ms }));
    const [x, y] = shardByDuration(files, 2);
    const sum = (s: typeof x) => s!.reduce((n, f) => n + f.ms, 0);
    expect(x!.length + y!.length).toBe(6);
    expect(Math.abs(sum(x) - sum(y))).toBeLessThanOrEqual(10);
  });

  it("merges verdicts: union of failing suites, red if any shard is red", () => {
    const base = { requestId: "r", workerId: "a", sha: "s", tier: "full" };
    const merged = mergeShardReports([
      { workerName: "a", report: { ...base, passed: true, log: "ok" } },
      { workerName: "b", report: { ...base, passed: false, exitCode: 2, failingSuites: ["server:x.test.ts"], log: "bad" } },
    ]);
    expect(merged.passed).toBe(false);
    expect(merged.exitCode).toBe(2);
    expect(merged.failingSuites).toEqual(["server:x.test.ts"]);
    expect(merged.log).toContain("shard 2/2 on b: FAILED");
  });

  it("a refused shard is never green", () => {
    const base = { requestId: "r", workerId: "a", sha: "s", tier: "full" };
    const merged = mergeShardReports([
      { workerName: "a", report: { ...base, passed: true } },
      { workerName: "b", report: { ...base, passed: false, refused: "no_slot" } },
    ]);
    expect(merged.passed).toBe(false);
    expect(merged.refused).toBe("no_slot");
  });

  it("placement avoids a worker running a builder when another is free", () => {
    expect(rankVerifyWorkers(allow, [w("a", 2), w("b", 0)])[0]!.name).toBe("b");
    expect(pickShardWorkers(allow, [w("a", 2), w("b", 0)]).map((x) => x.name)).toEqual(["b", "a"]);
    expect(pickShardWorkers(new Set(["a", "b", "c"]), [w("a"), w("b"), w("c", 1)]).map((x) => x.name)).toEqual(["a", "b"]);
  });
});
