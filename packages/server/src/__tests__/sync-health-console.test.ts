import { describe, expect, it } from "vitest";
import type { PluginSyncHealth, PluginSyncRunRecord } from "../services/plugin-sync.service.js";
import { syncHealthAttention, syncHealthLines } from "../cli/sync-health.js";

const NOW = Date.now();
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const run = (direction: "pull" | "push", agoMs: number, over: Partial<PluginSyncRunRecord> = {}): PluginSyncRunRecord => ({
  direction, dryRun: false, startedAt: iso(agoMs), finishedAt: iso(agoMs), ok: true, scheduled: true, ...over,
});
const health = (over: Partial<PluginSyncHealth["status"]> = {}, rest: Partial<PluginSyncHealth> = {}): PluginSyncHealth => ({
  pluginName: "Jira Sync",
  status: { provider: "jira", configured: true, lastRun: null, lastRuns: { pull: run("pull", 5 * 60_000), push: run("push", 5 * 60_000) }, outboxLength: 2, schedule: { pullEveryMinutes: 15, pushEveryMinutes: 15 }, ...over },
  conflicts: { count: 0, oldestAt: null }, failures: { count: 0, oldestAt: null }, ...rest,
});

describe("sync health (#1673)", () => {
  it("renders one line with last runs, registers, outbox and next run", () => {
    const [l] = syncHealthLines([health()], NOW);
    expect(l!.level).toBe("ok");
    expect(l!.text).toContain("pull 5m ago ok");
    expect(l!.text).toContain("0 conflicts");
    expect(l!.text).toContain("outbox 2");
    expect(l!.text).toContain("next in 10m");
  });
  it("renders nothing for a project without sync plugins", () => {
    expect(syncHealthLines([], NOW)).toEqual([]);
    expect(syncHealthAttention([], NOW)).toEqual([]);
  });
  it("a failed scheduled pull is red ATTENTION", () => {
    const h = health({ lastRuns: { pull: run("pull", 60_000, { ok: false, error: "boom\nstack" }), push: null } });
    expect(syncHealthLines([h], NOW)[0]!.level).toBe("red");
    const a = syncHealthAttention([h], NOW);
    expect(a).toHaveLength(1);
    expect(a[0]!.level).toBe("red");
    expect(a[0]!.text).toContain("scheduled pull failed");
    expect(a[0]!.text).toContain("boom");
    expect(a[0]!.text).toContain("Plugins");
  });
  it("a manual failure is not a scheduled-failure attention", () => {
    const h = health({ lastRuns: { pull: run("pull", 60_000, { ok: false, scheduled: undefined }), push: null } });
    expect(syncHealthAttention([h], NOW).filter((x) => x.text.includes("failed"))).toEqual([]);
  });
  it("flags a run overdue by 3 intervals and conflicts older than a day", () => {
    const h = health({ lastRuns: { pull: run("pull", 50 * 60_000), push: run("push", 60_000) } }, { conflicts: { count: 2, oldestAt: iso(26 * 3600_000) } });
    const texts = syncHealthAttention([h], NOW).map((a) => a.text);
    expect(texts.some((t) => t.includes("no pull for"))).toBe(true);
    expect(texts.some((t) => t.includes("2 open conflict"))).toBe(true);
  });
  it("recent conflicts are not attention", () => {
    expect(syncHealthAttention([health({}, { conflicts: { count: 1, oldestAt: iso(3600_000) } })], NOW)).toEqual([]);
  });
});
describe("sync health across projects (#1697)", () => {
  it("lists a second project's conflict on its own line, tagged with the project", () => {
    const a = health({}, { projectName: "alpha" });
    const b = health({}, { projectName: "lab5", conflicts: { count: 1, oldestAt: iso(60_000), needsHuman: 1 }, conflictsDriven: false });
    const lines = syncHealthLines([a, b], NOW);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.level).toBe("yellow");
    expect(lines[1]!.text).toContain("lab5 / Jira Sync");
    expect(lines[1]!.text).toContain("1 conflicts (1 needs-human) (no ticket)");
  });
  it("a conflict nobody is working raises ATTENTION at once, not after 24h", () => {
    const b = health({}, { projectName: "lab5", conflicts: { count: 1, oldestAt: iso(60_000) }, conflictsDriven: false });
    const a = syncHealthAttention([b], NOW);
    expect(a).toHaveLength(1);
    expect(a[0]!.text).toContain("lab5 / Jira Sync");
    expect(a[0]!.text).toContain("no open loop ticket");
  });
  it("a conflict with an open loop ticket stays quiet until it is a day old", () => {
    const b = health({}, { conflicts: { count: 1, oldestAt: iso(60_000) }, conflictsDriven: true });
    expect(syncHealthAttention([b], NOW)).toEqual([]);
  });
});
