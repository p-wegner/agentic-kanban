import { describe, it, expect } from "vitest";
import { formatRelativeTime, formatAbsoluteTime } from "./formatRelativeTime";

describe("formatRelativeTime", () => {
  it("returns 'just now' for recent times", () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    expect(formatRelativeTime(recent)).toBe("just now");
  });

  it("returns minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe("5m ago");
  });

  it("returns hours ago", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe("2h ago");
  });

  it("returns days ago", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe("3d ago");
  });

  it("returns weeks ago", () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(twoWeeksAgo)).toBe("2w ago");
  });

  it("uses en-US locale for old dates (no German month names)", () => {
    const oldDate = new Date("2020-05-27T12:00:00Z").toISOString();
    const result = formatRelativeTime(oldDate);
    expect(result).not.toMatch(/Mai|Mär|Okt|Dez|Jan\.|Feb\.|Mär\.|Apr\.|Mai\.|Jun\.|Jul\.|Aug\.|Sep\.|Nov\./);
    expect(result).toMatch(/\d/);
  });
});

describe("formatAbsoluteTime", () => {
  it("returns a human-readable absolute datetime string", () => {
    const dateStr = new Date("2025-03-15T14:30:00Z").toISOString();
    const result = formatAbsoluteTime(dateStr);
    expect(result).toMatch(/2025/);
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/15/);
  });

  it("uses en-US locale (no German month names)", () => {
    const dateStr = new Date("2025-05-01T10:00:00Z").toISOString();
    const result = formatAbsoluteTime(dateStr);
    expect(result).not.toMatch(/Mai|Mär|Okt|Dez/);
    expect(result).toMatch(/May/);
  });
});
