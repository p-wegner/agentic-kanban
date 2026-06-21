import { describe, it, expect } from "vitest";
import {
  WS_STATUS_COLORS,
  workspaceRowStatusBadgeClass,
  workspaceRowStatusLabel,
  formatContextTokens,
  searchPlaceholder,
} from "./allWorkspacesStatus.js";

type Main = Parameters<typeof workspaceRowStatusBadgeClass>[0];
const main = (o: Record<string, unknown> & { status: string }): Main => o as unknown as Main;

describe("workspaceRowStatusBadgeClass", () => {
  it("conflicts (not fixing) → red, before the fallback", () => {
    expect(workspaceRowStatusBadgeClass(main({ status: "active", conflicts: { hasConflicts: true } }))).toBe("bg-red-100 text-red-700");
  });
  it("closed + fix-conflicts trigger → orange", () => {
    expect(workspaceRowStatusBadgeClass(main({ status: "closed", lastSessionTriggerType: "fix-conflicts" }))).toBe("bg-orange-100 text-orange-700");
  });
  it("closed + mergedAt → emerald", () => {
    expect(workspaceRowStatusBadgeClass(main({ status: "closed", mergedAt: "2026-06-21T00:00:00Z" }))).toBe("bg-emerald-100 text-emerald-700");
  });
  it("otherwise falls back to the status color map, then gray", () => {
    expect(workspaceRowStatusBadgeClass(main({ status: "idle" }))).toBe(WS_STATUS_COLORS.idle);
    expect(workspaceRowStatusBadgeClass(main({ status: "weird" }))).toBe("bg-gray-100 text-gray-600");
  });
  it("a fixing workspace with conflicts is NOT red (the !== fixing guard)", () => {
    expect(workspaceRowStatusBadgeClass(main({ status: "fixing", conflicts: { hasConflicts: true } }))).toBe(WS_STATUS_COLORS.fixing);
  });
});

describe("workspaceRowStatusLabel", () => {
  it("maps each status branch in order", () => {
    expect(workspaceRowStatusLabel(main({ status: "reviewing" }))).toBe("AI Reviewing");
    expect(workspaceRowStatusLabel(main({ status: "fixing" }))).toBe("AI Fixing Conflicts");
    expect(workspaceRowStatusLabel(main({ status: "active", conflicts: { hasConflicts: true } }))).toBe("Merge Conflicts");
    expect(workspaceRowStatusLabel(main({ status: "closed", lastSessionTriggerType: "fix-conflicts" }))).toBe("merged conflicts");
    expect(workspaceRowStatusLabel(main({ status: "closed", mergedAt: "t" }))).toBe("merged");
    expect(workspaceRowStatusLabel(main({ status: "idle" }))).toBe("idle");
  });
});

describe("formatContextTokens", () => {
  it("compacts at >= 1000, otherwise raw", () => {
    expect(formatContextTokens(12000)).toBe("12k ctx");
    expect(formatContextTokens(1000)).toBe("1k ctx");
    expect(formatContextTokens(999)).toBe("999 ctx");
    expect(formatContextTokens(0)).toBe("0 ctx");
  });
});

describe("searchPlaceholder", () => {
  it("picks the placeholder for the current mode", () => {
    expect(searchPlaceholder(true, false)).toBe("Search by title, branch, or issue #…");
    expect(searchPlaceholder(false, true)).toBe("Search by title, branch, or project…");
    expect(searchPlaceholder(false, false)).toBe("Search by title or branch…");
  });
});
