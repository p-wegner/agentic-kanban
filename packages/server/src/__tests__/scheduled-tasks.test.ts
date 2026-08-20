// @gate:always-run — reads startup/scheduled-tasks.ts as text to assert a property it cannot import (#647).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWhere = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockWhere,
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  },
}));

import { setupScheduledTasks, stopScheduledTasks } from "../startup/scheduled-tasks.js";

describe("setupScheduledTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopScheduledTasks();
    vi.useRealTimers();
  });

  it("triggers a due scheduled run via the injected service call (no self-HTTP)", async () => {
    mockWhere.mockResolvedValueOnce([{
      id: "scheduled-run-1",
      name: "Daily cleanup",
      projectId: "project-1",
      enabled: true,
      intervalMinutes: 60,
      cronExpression: null,
      lastRunAt: null,
      systemIssueId: null,
    }]);
    const runScheduledRun = vi.fn(async () => ({ workspaceId: "ws-1" }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    setupScheduledTasks({ runScheduledRun });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runScheduledRun).toHaveBeenCalledWith("scheduled-run-1", "scheduler");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("logs but does not crash the cycle when the injected run trigger throws", async () => {
    mockWhere.mockResolvedValueOnce([{
      id: "scheduled-run-1",
      name: "Daily cleanup",
      projectId: "project-1",
      enabled: true,
      intervalMinutes: 60,
      cronExpression: null,
      lastRunAt: null,
      systemIssueId: null,
    }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runScheduledRun = vi.fn(async () => {
      throw new Error("boom");
    });

    setupScheduledTasks({ runScheduledRun });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runScheduledRun).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed"), "boom");
    warnSpy.mockRestore();
  });

  it("source contains no self-HTTP fetch to its own server (#402 anti-pattern gate)", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "startup", "scheduled-tasks.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/fetch\(\s*[`"']https?:\/\/(127\.0\.0\.1|localhost)/);
  });
});
