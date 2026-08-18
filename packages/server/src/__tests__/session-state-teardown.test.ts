// @gate:always-run — reads session-manager/types.ts off disk to compare the teardown
// list against the state shape; imports the module but asserts on its SOURCE.
//
// #543. The per-session teardown was a hand-maintained delete-list repeated at several
// call sites, and the copies had drifted: `cleanupStaleSession` cleared 14 members while
// `notifyExternalExit` cleared 19, so a stale-session cleanup leaked every buffered
// message of that session for the lifetime of the process.
//
// One function fixes today's drift. This test is what stops tomorrow's: adding a member to
// `SessionState` without deciding whether it needs tearing down fails here, rather than
// leaking silently until someone profiles the heap.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionState, teardownSessionState, type SessionState } from "../services/session-manager/types.js";

const TYPES_SRC = join(import.meta.dirname!, "..", "services", "session-manager", "types.ts");

/**
 * Members teardown deliberately leaves alone, each with the reason. A new member must be
 * added to `teardownSessionState` or to this list — the test forces the choice.
 */
const INTENTIONALLY_KEPT: Record<string, string> = {
  subscribers: "WebSocket listeners have their own unsubscribe lifecycle",
  sessionExitHandled: "duplicate-exit guard; must outlive teardown at the external-exit site",
  workspaceAutoResumeCount: "keyed by workspace, not session",
  workspaceStaleResumeRecoveryCount: "keyed by workspace, not session",
};

describe("teardownSessionState (#543)", () => {
  it("covers every session-keyed member of SessionState", () => {
    const src = readFileSync(TYPES_SRC, "utf-8");
    const body = src.slice(src.indexOf("export function createSessionState"));
    const members = [...body.matchAll(/^\s{4}(\w+): new (?:Map|Set)\(\),$/gm)].map((m) => m[1]);
    expect(members.length).toBeGreaterThan(15); // the scrape still finds the shape

    const teardown = src.slice(src.indexOf("export function teardownSessionState"));
    const cleared = new Set([...teardown.matchAll(/state\.(\w+)\.delete\(sessionId\)/g)].map((m) => m[1]));

    const uncovered = members.filter((m) => !cleared.has(m) && !(m in INTENTIONALLY_KEPT));
    expect(uncovered, `SessionState members neither torn down nor listed as intentionally kept: ${uncovered.join(", ")}`)
      .toEqual([]);
  });

  it("actually empties the state it claims to clear", () => {
    // The source scan above proves coverage; this proves the calls work on a real state.
    const state: SessionState = createSessionState();
    const sessionId = "s1";
    state.messageBuffer.set(sessionId, [{ type: "stdout", sessionId, data: "x" } as never]);
    state.sessionContexts.set(sessionId, { projectId: "p", issueId: "i" } as never);
    state.turnStates.set(sessionId, "processing");
    state.stoppedByUser.add(sessionId);
    state.sessionSubstantiveOutput.add(sessionId);
    state.sessionExitPlanModeDenied.add(sessionId);
    state.sessionFinalText.set(sessionId, "final");
    state.dbWriteBuffer.set(sessionId, [] as never);

    teardownSessionState(state, sessionId);

    expect(state.messageBuffer.has(sessionId)).toBe(false);
    expect(state.sessionContexts.has(sessionId)).toBe(false);
    expect(state.turnStates.has(sessionId)).toBe(false);
    expect(state.stoppedByUser.has(sessionId)).toBe(false);
    expect(state.sessionSubstantiveOutput.has(sessionId)).toBe(false);
    expect(state.sessionExitPlanModeDenied.has(sessionId)).toBe(false);
    expect(state.sessionFinalText.has(sessionId)).toBe(false);
    expect(state.dbWriteBuffer.has(sessionId)).toBe(false);
  });

  it("leaves the workspace-keyed counters and subscribers alone", () => {
    const state: SessionState = createSessionState();
    state.workspaceAutoResumeCount.set("ws1", 2);
    state.workspaceStaleResumeRecoveryCount.set("ws1", 1);
    state.sessionExitHandled.add("s1");
    state.subscribers.set("s1", new Set() as never);

    teardownSessionState(state, "s1");

    // Clearing these would reset the loop bounds they exist to enforce, and disconnect a
    // client that is still attached.
    expect(state.workspaceAutoResumeCount.get("ws1")).toBe(2);
    expect(state.workspaceStaleResumeRecoveryCount.get("ws1")).toBe(1);
    expect(state.sessionExitHandled.has("s1")).toBe(true);
    expect(state.subscribers.has("s1")).toBe(true);
  });
});
