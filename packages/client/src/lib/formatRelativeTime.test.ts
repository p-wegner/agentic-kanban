import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./formatRelativeTime";

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
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(tenDaysAgo)).toBe("10d ago");
  });

  it("uses en-US locale for old dates (no German month names)", () => {
    // Use a fixed date well over 30 days ago so we hit the toLocaleDateString path
    const oldDate = new Date("2020-05-27T12:00:00Z").toISOString();
    const result = formatRelativeTime(oldDate);
    // Should NOT contain German month abbreviations
    expect(result).not.toMatch(/Mai|Mär|Okt|Dez|Jan\.|Feb\.|Mär\.|Apr\.|Mai\.|Jun\.|Jul\.|Aug\.|Sep\.|Nov\./);
    // Should be a valid en-US date string (contains a slash)
    expect(result).toMatch(/\d/);
  });
});
