// @covers butler.feed.systemEvents [capability,config,concurrency,error-handling]
//
// Behaviour (AK-75): the board-event → butler injection pipeline in
// `butler-event-feed.ts`. `emitButlerSystemEvent` decides whether and how a board
// event (merge failure, agent crash, stuck workspace, …) is pushed into the warm
// DEFAULT butler session as a tagged `[system event]` turn. The documented rules:
//   1. capability     — a warm default session receives `[system event] <text>`.
//   2. config         — the feed is gated by the `butler_event_feed[_<projectId>]`
//                       preference; disabled → nothing is injected.
//   3. concurrency    — rate-limited to 1 turn / 30s / project; a burst of events
//                       inside the window collapses into ONE summary turn; the
//                       per-project `state` Map keeps projects independent (a burst
//                       in project A never delays/merges project B's events).
//   4. error-handling — a cold session drops the event silently, AND a throwing
//                       collaborator is swallowed (the try/catch at
//                       butler-event-feed.ts:106) — emit never rejects.
// Plus the routing invariant: the feed only ever targets the DEFAULT butler
// (plain projectId key) — named butlers never receive a system event.
//
// Pure decision-logic test: the two collaborators the module talks to — the
// preferences repository (`getPreference`) and the butler SDK boundary
// (`getButlerSession` / `sendButlerTurn`) — are mocked, so no real DB and no real
// LLM session are involved. Time is driven with vitest fake timers so the 30s
// rate-limit / burst-collapse window is deterministic (no real sleeps).
//
// MUTATION RATIONALE (why each assertion goes RED on a regression):
//   - Drop the cold-session guard (always inject) → "drops when cold" fails:
//     sendButlerTurn would be called for a cold project.
//   - Drop the rate-limit (inject every event) → the burst test fails on
//     toHaveBeenCalledTimes(2) — it would be once per event, no collapse.
//   - Break burst-collapse (flush each pending event individually) → the summary
//     would not carry an aggregate "<count> <kind>" token, failing the semantic
//     summary assertions.
//   - Lose per-project state isolation (one global window) → project B's first
//     event would be queued behind A's window, failing the two-project test.
//   - Ignore the feed-disabled preference → the "feed off" assertion fails.
//   - Remove the try/catch swallow → the throwing-collaborator test fails on an
//     unhandled rejection.
//
// NOTE on cold-guard redundancy: the cold check is duplicated at three points
// (emit gate :102, immediate-send :77, burst-flush :63). The cold-drop tests below
// exercise the emit gate (:102) and the burst-flush guard (:63); the immediate-send
// guard (:77) is co-redundant with :102 (same getButlerSession read in one tick) so
// a single-point regression there is masked — documented here rather than forced.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocked collaborators (hoisted so the vi.mock factories can see them) -------
const h = vi.hoisted(() => ({
  // project -> whether a warm default butler session is active
  active: new Map<string, boolean>(),
  // preference key -> value
  prefs: new Map<string, string>(),
  sendButlerTurn: vi.fn(),
  getButlerSession: vi.fn(),
  getPreference: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ db: {} }));

vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: (key: string) => h.getPreference(key),
}));

vi.mock("../services/butler-sdk.service.js", () => ({
  // The module under test only ever passes a plain projectId — the default
  // butler key. We model the session state per project.
  getButlerSession: (projectId: string) => {
    h.getButlerSession(projectId);
    return { active: h.active.get(projectId) ?? false };
  },
  sendButlerTurn: (...args: unknown[]) => h.sendButlerTurn(...args),
}));

import {
  emitButlerSystemEvent,
  _resetButlerEventFeedState,
  type ButlerSystemEventKind,
} from "../services/butler-event-feed.js";

// Flush the async fire-and-forget IIFE inside emitButlerSystemEvent (it awaits a
// couple of mocked-promise getPreference calls before reaching `deliver`).
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function emit(projectId: string, kind: ButlerSystemEventKind, text: string): Promise<void> {
  emitButlerSystemEvent({ projectId, kind, text });
  await flushAsync();
}

// Sent turns to a given project, in order. Each call is [projectId, text].
function textsSentTo(projectId: string): string[] {
  return h.sendButlerTurn.mock.calls.filter((c) => c[0] === projectId).map((c) => c[1] as string);
}

const PROJECT = "proj-feed";

describe("butler-event-feed: board-event → default-butler injection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Anchor wall-clock well past the 30s window so the FIRST event of any test
    // satisfies `elapsed >= intervalMs` (lastSentAt starts at 0) and sends now.
    vi.setSystemTime(new Date("2026-06-27T12:00:00.000Z"));
    h.active.clear();
    h.prefs.clear();
    h.sendButlerTurn.mockReset();
    h.getButlerSession.mockReset();
    // Default getPreference: read from the prefs map.
    h.getPreference.mockReset();
    h.getPreference.mockImplementation(async (key: string) => h.prefs.get(key) ?? null);
    // Feed enabled globally by default for these tests.
    h.prefs.set("butler_event_feed", "true");
    _resetButlerEventFeedState();
  });

  afterEach(() => {
    _resetButlerEventFeedState();
    vi.useRealTimers();
  });

  it("injects a [system event] turn into the warm DEFAULT butler when enabled", async () => {
    h.active.set(PROJECT, true);

    await emit(PROJECT, "merge_failed", "merge of #42 failed: conflict in app.css");

    // The default butler received exactly one tagged turn with the event text.
    expect(h.sendButlerTurn).toHaveBeenCalledTimes(1);
    const [target, text] = h.sendButlerTurn.mock.calls[0];
    expect(target).toBe(PROJECT); // default-butler key (plain projectId)
    expect(text).toContain("[system event]");
    expect(text).toContain("merge of #42 failed: conflict in app.css");
  });

  it("DROPS the event silently when no session is warm (cold) — emit gate", async () => {
    // No h.active entry → cold.
    await emit(PROJECT, "session_failed", "agent crashed");

    expect(h.sendButlerTurn).not.toHaveBeenCalled();
  });

  it("does NOT inject when the feed preference is disabled", async () => {
    h.active.set(PROJECT, true);
    h.prefs.set("butler_event_feed", "false");

    await emit(PROJECT, "stuck_agent", "workspace stuck for 20m");

    expect(h.sendButlerTurn).not.toHaveBeenCalled();
  });

  it("honours a per-project enable override even when the global feed is off", async () => {
    h.active.set(PROJECT, true);
    h.prefs.set("butler_event_feed", "false");
    h.prefs.set(`butler_event_feed_${PROJECT}`, "true");

    await emit(PROJECT, "permission_pending", "tool approval awaiting");

    expect(h.sendButlerTurn).toHaveBeenCalledTimes(1);
    expect(h.sendButlerTurn.mock.calls[0][1]).toContain("tool approval awaiting");
  });

  it("rate-limits a burst to one immediate turn + one collapsed summary within 30s", async () => {
    h.active.set(PROJECT, true);

    // First event in an empty window → injected immediately.
    await emit(PROJECT, "merge_retry", "retry #1");
    expect(h.sendButlerTurn).toHaveBeenCalledTimes(1);
    expect(h.sendButlerTurn.mock.calls[0][1]).toContain("retry #1");

    // Two more events within the same 30s window → suppressed (pending), NOT sent.
    await emit(PROJECT, "merge_retry", "retry #2");
    await emit(PROJECT, "merge_retry", "retry #3");
    expect(h.sendButlerTurn).toHaveBeenCalledTimes(1);

    // Advancing past the window flushes the burst as ONE summary turn.
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();

    expect(h.sendButlerTurn).toHaveBeenCalledTimes(2);
    // Semantic assertions (not exact copy): the collapsed summary names the kind
    // and carries the aggregate count (2 suppressed merge_retry events).
    const summary = h.sendButlerTurn.mock.calls[1][1] as string;
    expect(summary).toContain("[system event]");
    expect(summary).toMatch(/merge_retry/);
    expect(summary).toMatch(/\b2\b/);
    // The individual suppressed texts are NOT re-sent verbatim — they collapsed.
    expect(summary).not.toContain("retry #2");
    expect(summary).not.toContain("retry #3");
  });

  it("collapses a mixed-kind burst into per-kind counts", async () => {
    h.active.set(PROJECT, true);

    await emit(PROJECT, "merge_failed", "first"); // immediate
    // Burst of mixed kinds inside the window: 2× merge_failed + 1× workspace_error.
    await emit(PROJECT, "merge_failed", "second");
    await emit(PROJECT, "merge_failed", "third");
    await emit(PROJECT, "workspace_error", "fourth");

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();

    expect(h.sendButlerTurn).toHaveBeenCalledTimes(2);
    const summary = h.sendButlerTurn.mock.calls[1][1] as string;
    // Both kinds are named with their aggregate counts (2 and 1 respectively).
    expect(summary).toMatch(/merge_failed/);
    expect(summary).toMatch(/workspace_error/);
    expect(summary).toMatch(/\b2\b/);
    expect(summary).toMatch(/\b1\b/);
  });

  it("isolates rate-limit windows per project — a burst in A does not stall B", async () => {
    const A = "proj-A";
    const B = "proj-B";
    h.active.set(A, true);
    h.active.set(B, true);

    // Open A's window and queue a burst into it.
    await emit(A, "merge_failed", "A-immediate");
    await emit(A, "merge_failed", "A-queued-1");
    await emit(A, "merge_failed", "A-queued-2");

    // B's FIRST event must be delivered immediately — B has its own window and is
    // NOT throttled by A's in-flight burst.
    await emit(B, "stuck_agent", "B-immediate");

    const aTexts = textsSentTo(A);
    const bTexts = textsSentTo(B);
    expect(aTexts).toHaveLength(1); // only A's immediate; A's burst still pending
    expect(aTexts[0]).toContain("A-immediate");
    expect(bTexts).toHaveLength(1); // B delivered straight away
    expect(bTexts[0]).toContain("B-immediate");

    // Flushing A's window must not touch B (separate `state` entries).
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();

    const aAfter = textsSentTo(A);
    const bAfter = textsSentTo(B);
    expect(aAfter).toHaveLength(2); // A's collapsed summary now delivered
    expect(aAfter[1]).toMatch(/merge_failed/);
    expect(bAfter).toHaveLength(1); // B untouched by A's flush — no extra turn
    expect(bAfter[0]).toContain("B-immediate");
  });

  it("drops a queued burst summary if the session has gone cold by flush time", async () => {
    h.active.set(PROJECT, true);

    await emit(PROJECT, "merge_failed", "immediate"); // sent now
    await emit(PROJECT, "merge_failed", "queued"); // pending in burst window
    expect(h.sendButlerTurn).toHaveBeenCalledTimes(1);

    // Session goes cold before the burst timer fires (exercises the flush guard).
    h.active.set(PROJECT, false);
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();

    // The collapsed summary is NOT delivered to a cold session.
    expect(h.sendButlerTurn).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing collaborator — emit never rejects, no unhandled rejection", async () => {
    h.active.set(PROJECT, true);
    // Make the preference read blow up: this throws BEFORE the cold/enable gate,
    // hitting the try/catch swallow in emitButlerSystemEvent.
    h.getPreference.mockRejectedValue(new Error("prefs DB exploded"));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // emit is synchronous/void — must not throw synchronously either.
      expect(() => emitButlerSystemEvent({ projectId: PROJECT, kind: "merge_failed", text: "boom" })).not.toThrow();
      await flushAsync();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // The error was swallowed: nothing reached the butler, and no rejection leaked.
    expect(h.sendButlerTurn).not.toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
  });
});
