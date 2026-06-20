import { describe, it, expect } from "vitest";
import {
  selectLatestSessionsByWorkspace,
  parseContextTokensFromStats,
} from "../lib/workspace-summary-session.js";

function row(over: Partial<{ id: string; workspaceId: string; status: string; startedAt: string; endedAt: string | null; stats: string | null; triggerType: string | null }> = {}) {
  return {
    id: over.id ?? "s1",
    workspaceId: over.workspaceId ?? "w1",
    status: over.status ?? "stopped",
    startedAt: over.startedAt ?? "2026-01-01T00:00:00.000Z",
    endedAt: over.endedAt ?? "2026-01-01T00:01:00.000Z",
    stats: over.stats ?? null,
    triggerType: over.triggerType ?? null,
  };
}

const noiseTrigger = (s: { triggerType?: string | null }) => s.triggerType === "noise";

describe("selectLatestSessionsByWorkspace", () => {
  it("keeps the last row seen per workspace (recency-ordered input)", () => {
    const out = selectLatestSessionsByWorkspace(
      [row({ id: "old", workspaceId: "w1" }), row({ id: "new", workspaceId: "w1" })],
      noiseTrigger,
    );
    expect(out.get("w1")?.id).toBe("new");
  });

  it("prefers a real session over a noise session for the same workspace", () => {
    const out = selectLatestSessionsByWorkspace(
      [row({ id: "real", workspaceId: "w1" }), row({ id: "noise", workspaceId: "w1", triggerType: "noise" })],
      noiseTrigger,
    );
    expect(out.get("w1")?.id).toBe("real");
  });

  it("falls back to a noise session only when no real session exists", () => {
    const out = selectLatestSessionsByWorkspace(
      [row({ id: "noiseOnly", workspaceId: "w2", triggerType: "noise" })],
      noiseTrigger,
    );
    expect(out.get("w2")?.id).toBe("noiseOnly");
  });

  it("handles multiple workspaces independently", () => {
    const out = selectLatestSessionsByWorkspace(
      [row({ id: "a", workspaceId: "w1" }), row({ id: "b", workspaceId: "w2", triggerType: "noise" })],
      noiseTrigger,
    );
    expect(out.get("w1")?.id).toBe("a");
    expect(out.get("w2")?.id).toBe("b");
    expect(out.size).toBe(2);
  });

  it("normalizes undefined triggerType to null", () => {
    const out = selectLatestSessionsByWorkspace([row({ workspaceId: "w1", triggerType: undefined })], noiseTrigger);
    expect(out.get("w1")?.triggerType).toBeNull();
  });
});

describe("parseContextTokensFromStats", () => {
  it("returns null for null/empty stats", () => {
    expect(parseContextTokensFromStats(null)).toBeNull();
    expect(parseContextTokensFromStats("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseContextTokensFromStats("{not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseContextTokensFromStats("42")).toBeNull();
    expect(parseContextTokensFromStats("null")).toBeNull();
  });

  it("prefers explicit contextTokens", () => {
    expect(parseContextTokensFromStats(JSON.stringify({ contextTokens: 1234, inputTokens: 1, cacheReadTokens: 2 }))).toBe(1234);
  });

  it("sums input + cache-read tokens when no explicit contextTokens", () => {
    expect(parseContextTokensFromStats(JSON.stringify({ inputTokens: 100, cacheReadTokens: 50 }))).toBe(150);
  });

  it("returns null when all token counts are zero/absent", () => {
    expect(parseContextTokensFromStats(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseContextTokensFromStats(JSON.stringify({ contextTokens: 0, inputTokens: 0, cacheReadTokens: 0 }))).toBeNull();
  });
});
