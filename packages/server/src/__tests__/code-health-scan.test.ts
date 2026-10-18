/**
 * #1619 — the code-health report scan: a landing triggers exactly one report for its sha, a
 * re-observed landing does not, and a failed scan neither throws nor blocks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";
import type { SoftBreach } from "../lib/code-health.js";
import { createTestDb } from "./helpers/test-db.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { CODE_HEALTH_SCAN_DAILY_MS, isScanDue, scanCodeHealthOnce } from "../services/code-health-scan.service.js";

const breach: SoftBreach = { file: "packages/x/src/f.ts", metric: "lines", value: 1100, cap: 1000 };

describe("code-health report scan (#1619)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let tip: string;
  const record = vi.fn(async (_input: Record<string, unknown>) => ({}) as never);
  const runScan = vi.fn(async () => [breach]);
  const input = () => ({ projectId, repoPath: "C:/repo", defaultBranch: "master" });
  const deps = () => ({ database: db, resolveTip: async () => ({ tip, head: tip }), runScan, record });

  beforeEach(async () => {
    ({ db } = createTestDb());
    invalidatePreferencesCache();
    projectId = randomUUID();
    tip = "aaa111";
    record.mockClear();
    runScan.mockClear();
    runScan.mockImplementation(async () => [breach]);
    await db.insert(projects).values({ id: projectId, name: "ch", repoPath: "C:/repo", repoName: "repo", createdAt: new Date().toISOString() });
  });

  it("a landing triggers exactly one report, stamped with its sha", async () => {
    expect(await scanCodeHealthOnce(input(), deps())).toBe("scanned");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ projectId, ref: "aaa111", breaches: [breach] });
  });

  it("a re-observed landing does not report again", async () => {
    await scanCodeHealthOnce(input(), deps());
    expect(await scanCodeHealthOnce(input(), deps())).toBe("unchanged");
    expect(record).toHaveBeenCalledTimes(1);
    tip = "bbb222";
    expect(await scanCodeHealthOnce(input(), deps())).toBe("scanned");
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("a failed scan does not throw, stores nothing, and retries next time", async () => {
    runScan.mockImplementationOnce(async () => { throw new Error("boom"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await scanCodeHealthOnce(input(), deps())).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("[code-health-scan]");
    warn.mockRestore();
    expect(record).not.toHaveBeenCalled();
    expect(await scanCodeHealthOnce(input(), deps())).toBe("scanned");
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("waits for the checkout to reach the tip", async () => {
    const out = await scanCodeHealthOnce(input(), { ...deps(), resolveTip: async () => ({ tip, head: "other" }) });
    expect(out).toBe("skipped");
    expect(runScan).not.toHaveBeenCalled();
  });

  it("re-scans a quiet project once a day", () => {
    const at = new Date(1_000_000).toISOString();
    expect(isScanDue({ sha: "a", at }, "a", 1_000_000 + 1000)).toBe(false);
    expect(isScanDue({ sha: "a", at }, "a", 1_000_000 + CODE_HEALTH_SCAN_DAILY_MS)).toBe(true);
    expect(isScanDue({ sha: "a", at }, "b", 1_000_000 + 1000)).toBe(true);
    expect(isScanDue(null, "a", 0)).toBe(true);
  });
});
