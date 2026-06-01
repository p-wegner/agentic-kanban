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

import { setupScheduledTasks } from "../startup/scheduled-tasks.js";

describe("setupScheduledTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => "",
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses 127.0.0.1 for scheduled run self-fetches", async () => {
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

    setupScheduledTasks(4321);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/scheduled-runs/scheduled-run-1/run?triggeredBy=scheduler",
      { method: "POST" },
    );
  });
});
