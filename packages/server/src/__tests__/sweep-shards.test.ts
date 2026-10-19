import { describe, expect, it } from "vitest";
import {
  checkShardCoverage, DEFAULT_SWEEP_PACKAGES, formatSweepProgress, mergeShardVerdicts, parseShardTimings, planSweepShards, recordShardTimings, runShardedSweep, serverShardCount,
  type ShardResult, type SweepShard,
} from "../services/sweep-shards.js";

const wanted = [...DEFAULT_SWEEP_PACKAGES.map((p) => p.pkg), "static"];
const res = (shard: SweepShard, outcome: ShardResult["outcome"], failedSuites?: string[]): ShardResult => ({ shard, outcome, durationMs: 1000, attempts: 1, failedSuites });

describe("planSweepShards", () => {
  it("covers every package once and the server as exactly 1..n of n (so every test file runs once)", () => {
    const shards = planSweepShards();
    expect(checkShardCoverage(shards, wanted)).toEqual([]);
    const server = shards.filter((s) => s.pkg === "server");
    expect(server.map((s) => s.index).sort()).toEqual([1, 2, 3, 4]);
    expect(server.every((s) => s.command.includes(`--shard ${s.index}/4`))).toBe(true);
    expect(new Set(shards.map((s) => s.id)).size).toBe(shards.length);
  });
  it("sizes the server split from recorded timings and keeps coverage", () => {
    const timings = { "server:1/4": 600_000, "server:2/4": 600_000, shared: 5_000, client: 90_000 };
    expect(serverShardCount(timings)).toBe(5);
    const shards = planSweepShards({ timings });
    expect(shards.filter((s) => s.pkg === "server")).toHaveLength(5);
    expect(checkShardCoverage(shards, wanted)).toEqual([]);
  });
  it("detects a hole in a plan", () => {
    const shards = planSweepShards().filter((s) => s.id !== "server:3/4");
    expect(checkShardCoverage(shards, wanted).join()).toContain("not exactly 1..4");
    expect(checkShardCoverage(shards.filter((s) => s.pkg !== "client"), wanted).join()).toContain("client has no shard");
  });
});

describe("mergeShardVerdicts", () => {
  const [a, b, c] = planSweepShards().slice(0, 3);
  it("one red shard makes the sweep red, carrying its suites merged across shards", () => {
    const v = mergeShardVerdicts([res(a!, "green"), res(b!, "red", ["x.test.ts"]), res(c!, "red", ["y.test.ts", "x.test.ts"])]);
    expect(v.outcome).toBe("red");
    expect(v.failedSuites).toEqual(["x.test.ts", "y.test.ts"]);
  });
  it("is green only when every shard is green", () => {
    expect(mergeShardVerdicts([res(a!, "green"), res(b!, "green")]).outcome).toBe("green");
  });
  it("a lost or missing shard is inconclusive, never green", () => {
    expect(mergeShardVerdicts([res(a!, "green"), res(b!, "lost")]).outcome).toBe("inconclusive");
    expect(mergeShardVerdicts([res(a!, "green")], [a!, b!]).outcome).toBe("inconclusive");
  });
});

describe("runShardedSweep", () => {
  const shards = planSweepShards().slice(0, 3);
  it("retries a lost shard once on another worker and does not count the loss as green", async () => {
    const seen: string[] = [];
    const out = await runShardedSweep({
      shards, workers: [{ id: "w1", name: "w1", freeSlots: 1 }, { id: "w2", name: "w2", freeSlots: 1 }],
      runShard: async (s, w) => {
        seen.push(`${s.id}@${w.id}`);
        if (s.id === shards[0]!.id && w.id === "w1") return { outcome: "lost", durationMs: 1, reason: "disconnect" };
        return { outcome: "green", durationMs: 1 };
      },
    });
    const first = out.find((r) => r.shard.id === shards[0]!.id)!;
    if (seen.includes(`${shards[0]!.id}@w1`)) {
      expect(first.attempts).toBe(2);
      expect(first.workerName).toBe("w2");
    }
    expect(mergeShardVerdicts(out, shards).outcome).toBe("green");
  });
  it("reports inconclusive when a shard is lost twice", async () => {
    const out = await runShardedSweep({
      shards, workers: [{ id: "w1", name: "w1", freeSlots: 2 }],
      runShard: async (s) => (s.id === shards[1]!.id ? { outcome: "lost", durationMs: 1 } : { outcome: "green", durationMs: 1 }),
    });
    expect(out.find((r) => r.shard.id === shards[1]!.id)).toMatchObject({ outcome: "lost", attempts: 2 });
    expect(mergeShardVerdicts(out, shards).outcome).toBe("inconclusive");
  });
  it("a throwing transport is a lost shard; no workers loses everything", async () => {
    const out = await runShardedSweep({ shards, workers: [{ id: "w1", name: "w1", freeSlots: 1 }], runShard: async () => { throw new Error("boom"); } });
    expect(out.every((r) => r.outcome === "lost")).toBe(true);
    const none = await runShardedSweep({ shards, workers: [], runShard: async () => ({ outcome: "green", durationMs: 1 }) });
    expect(none.every((r) => r.outcome === "lost")).toBe(true);
  });
  it("respects each worker's slot count", async () => {
    let running = 0;
    let peak = 0;
    await runShardedSweep({
      shards, workers: [{ id: "w1", name: "w1", freeSlots: 2 }],
      runShard: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return { outcome: "green", durationMs: 1 }; },
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("timings + progress", () => {
  it("records answered shards only and drops stale ids; an unparseable book reads empty", () => {
    const [a, b] = planSweepShards();
    expect(recordShardTimings({ gone: 5 }, [res(a!, "green"), res(b!, "lost")])).toEqual({ [a!.id]: 1000 });
    expect(parseShardTimings("not json")).toEqual({});
    expect(parseShardTimings('{"a":5,"b":"x"}')).toEqual({ a: 5 });
  });
  it("formats the progress line", () => {
    expect(formatSweepProgress(3, 5, 7 * 60_000 + 5000)).toBe("sweep 3/5 shards done · 7m");
  });
});
