import { describe, it, expect } from "vitest";
import {
  validateCronExpression,
  getNextCronRun,
  describeCronExpression,
} from "@agentic-kanban/shared/lib/cron-utils";

describe("validateCronExpression", () => {
  it("accepts a valid standard cron expression", () => {
    expect(validateCronExpression("0 9 * * 1").valid).toBe(true);
  });

  it("rejects fewer than 5 fields", () => {
    const result = validateCronExpression("0 9 * *");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/5 fields/);
  });

  it("rejects more than 5 fields", () => {
    expect(validateCronExpression("0 9 * * * *").valid).toBe(false);
  });

  it("rejects out-of-range minute (60)", () => {
    const result = validateCronExpression("60 * * * *");
    expect(result.valid).toBe(false);
  });

  it("rejects out-of-range hour (24)", () => {
    expect(validateCronExpression("0 24 * * *").valid).toBe(false);
  });

  it("rejects out-of-range day-of-month (0)", () => {
    expect(validateCronExpression("0 0 0 * *").valid).toBe(false);
  });

  it("rejects out-of-range month (13)", () => {
    expect(validateCronExpression("0 0 1 13 *").valid).toBe(false);
  });

  it("rejects out-of-range weekday (7)", () => {
    expect(validateCronExpression("0 0 * * 7").valid).toBe(false);
  });

  it("accepts wildcard step expressions like */15", () => {
    expect(validateCronExpression("*/15 * * * *").valid).toBe(true);
  });

  it("accepts range expressions like 1-5", () => {
    expect(validateCronExpression("0 9 * * 1-5").valid).toBe(true);
  });

  it("accepts comma-separated values", () => {
    expect(validateCronExpression("0 9,17 * * *").valid).toBe(true);
  });

  it("rejects an invalid step", () => {
    expect(validateCronExpression("*/0 * * * *").valid).toBe(false);
  });
});

describe("getNextCronRun", () => {
  it("returns a future date matching the cron expression", () => {
    // Every minute
    const from = new Date("2026-01-01T12:00:00Z");
    const next = getNextCronRun("* * * * *", from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it("matches the expected minute for a specific hourly cron", () => {
    // At minute 30 of every hour
    const from = new Date("2026-01-01T12:00:00Z");
    const next = getNextCronRun("30 * * * *", from);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(30);
  });

  it("matches the expected weekday for a weekday-specific cron", () => {
    // Every Monday (1) at 09:00
    const from = new Date("2026-01-04T10:00:00Z"); // Sunday
    const next = getNextCronRun("0 9 * * 1", from);
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(1);
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
  });

  it("skips to next matching day-of-month", () => {
    // On the 15th of every month at 00:00
    const from = new Date("2026-01-16T00:00:00Z");
    const next = getNextCronRun("0 0 15 * *", from);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(15);
    expect(next!.getMonth()).toBe(1); // February
  });

  it("advances the minute by at least 1 from `from`", () => {
    const from = new Date("2026-06-08T10:30:00Z");
    const next = getNextCronRun("* * * * *", from);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe("describeCronExpression", () => {
  it("describes every minute", () => {
    expect(describeCronExpression("* * * * *")).toBe("Every minute");
  });

  it("describes every N minutes", () => {
    expect(describeCronExpression("*/15 * * * *")).toBe("Every 15 minutes");
  });

  it("describes every hour", () => {
    expect(describeCronExpression("0 * * * *")).toBe("Every hour");
  });

  it("describes daily at a specific time", () => {
    expect(describeCronExpression("0 9 * * *")).toBe("Daily at 09:00");
  });

  it("describes weekdays at a time", () => {
    expect(describeCronExpression("0 9 * * 1-5")).toBe("Weekdays at 09:00");
  });

  it("describes a specific weekday", () => {
    expect(describeCronExpression("0 9 * * 1")).toBe("Every Monday at 09:00");
  });

  it("describes weekends", () => {
    expect(describeCronExpression("0 10 * * 6,0")).toBe("Weekends at 10:00");
  });

  it("describes monthly on a specific day", () => {
    expect(describeCronExpression("0 8 1 * *")).toBe("Monthly on day 1 at 08:00");
  });

  it("returns the raw expression when no description matches", () => {
    const expr = "*/5 9-17 * * 1-5";
    expect(describeCronExpression(expr)).toBe(expr);
  });

  it("returns the raw expression for wrong field count", () => {
    expect(describeCronExpression("* * *")).toBe("* * *");
  });
});
