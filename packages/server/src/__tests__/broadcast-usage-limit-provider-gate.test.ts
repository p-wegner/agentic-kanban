import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionState } from "../services/session-manager/types.js";

/**
 * #1139: `persistFrictionFallback` (the terminal fallback stats write in
 * broadcast.ts) used to call `detectCodexUsageLimitMessages` UNCONDITIONALLY on
 * every session's exit messages, with no check that the session was actually a
 * Codex launch. A Claude session whose output happened to contain codex-shaped
 * usage-limit prose — e.g. a builder's own assistant text discussing or quoting
 * that wording, which is exactly what a ticket ABOUT usage-limit classification
 * produces — was misfiled as a `codex-usage-limit` death: `rateLimited: true`,
 * `rateLimitKind: "codex-usage-limit"`, an unsanitized `retryAfter` lifted
 * straight out of the matched text, and `launchFailure: true` on a session that
 * ran 78 turns and produced real, reviewed work. The workspace was then parked
 * `blocked` and skipped by the monitor for hours.
 *
 * These tests drive the REAL `createBroadcaster` (not a hand-rolled mock of it,
 * see broadcast-flush-on-exit.test.ts for the same pattern) against a mocked DB,
 * so the fix is exercised through the actual write path rather than reproduced
 * by re-deriving the logic in the test.
 */

let statsRow: { stats: string | null } | undefined;
const updatedStats: string[] = [];

vi.mock("../db/index.js", () => {
  const mockDb = {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(statsRow ? [statsRow] : [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: { stats: string }) => {
        updatedStats.push(patch.stats);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  };
  return { db: mockDb, writeDb: mockDb };
});

vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

const { createBroadcaster } = await import("../services/session-manager/broadcast.js");

// The Codex usage-limit prose the ticket used to fire on when it appeared as a Claude
// session's own assistant/result text rather than genuine Codex process output.
const CODEX_SHAPED_TEXT =
  "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at Jun 6th, 2026 12:30 AM.";

/** Poll until `predicate` holds, or give up at `budgetMs` — the stats write chain is async. */
async function flushUntil(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    if (predicate()) return;
  }
}

describe("persistFrictionFallback provider gate (#1139)", () => {
  let state: ReturnType<typeof createSessionState>;
  let broadcast: ReturnType<typeof createBroadcaster>;

  beforeEach(() => {
    statsRow = { stats: null };
    updatedStats.length = 0;
    state = createSessionState();
    broadcast = createBroadcaster(state, undefined);
  });

  it("does NOT classify a Claude session as codex-rate-limited even when its output contains codex-shaped usage-limit text", async () => {
    state.sessionProviders.set("claude1", "claude-code");
    broadcast("claude1", { sessionId: "claude1", type: "stdout", data: JSON.stringify({ type: "result", subtype: "success", result: CODEX_SHAPED_TEXT }) });
    broadcast("claude1", { sessionId: "claude1", type: "exit", exitCode: 0 });

    // The friction fallback may still write (unrelated to usage-limit detection), so wait
    // for it to settle rather than asserting on the ABSENCE of a write.
    await new Promise((r) => setTimeout(r, 100));

    // Whatever it wrote, it must never carry a usage-limit classification for this
    // Claude session — that is the bug: it used to write rateLimitKind: "codex-usage-limit"
    // here regardless of the actual launch provider.
    for (const raw of updatedStats) {
      const stats = JSON.parse(raw) as Record<string, unknown>;
      expect(stats.rateLimited).not.toBe(true);
      expect(stats.rateLimitKind).toBeUndefined();
    }
  });

  it("still classifies a real Codex session's usage-limit output as codex-rate-limited (fix is a gate, not a removal)", async () => {
    state.sessionProviders.set("codex1", "codex");
    broadcast("codex1", { sessionId: "codex1", type: "stdout", data: JSON.stringify({ type: "turn.failed", error: { message: CODEX_SHAPED_TEXT } }) });
    broadcast("codex1", { sessionId: "codex1", type: "exit", exitCode: 1 });

    await flushUntil(() => updatedStats.length > 0);

    expect(updatedStats.length).toBeGreaterThan(0);
    const stats = JSON.parse(updatedStats[updatedStats.length - 1]) as Record<string, unknown>;
    expect(stats.rateLimited).toBe(true);
    expect(stats.rateLimitKind).toBe("codex-usage-limit");
  });
});
