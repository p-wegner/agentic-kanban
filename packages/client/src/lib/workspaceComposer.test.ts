import { describe, it, expect } from "vitest";
import { composerState, type ComposerSessionState } from "./workspaceComposer.js";

function state(over: Partial<ComposerSessionState> = {}): ComposerSessionState {
  return {
    isSessionAlive: false,
    isWaitingForInput: false,
    actionLoading: false,
    prompt: "",
    ...over,
  };
}

describe("composerState", () => {
  it("is idle with a Send button when no session is live", () => {
    const c = composerState(state({ prompt: "hi" }));
    expect(c.mode).toBe("idle");
    expect(c.action).toBe("launch");
    expect(c.primaryLabel).toBe("Send");
    expect(c.showStop).toBe(false);
    expect(c.primaryEnabled).toBe(true);
  });

  it("sends a turn when the agent is waiting for input", () => {
    const c = composerState(state({ isSessionAlive: true, isWaitingForInput: true, prompt: "go on" }));
    expect(c.mode).toBe("awaiting-input");
    expect(c.action).toBe("send-turn");
    expect(c.showStop).toBe(true);
  });

  it("keeps the input typable while the agent is working (#970)", () => {
    // The whole point of the ticket: the box used to be `disabled` here, so it
    // was never usable in practice.
    const c = composerState(state({ isSessionAlive: true, prompt: "" }));
    expect(c.mode).toBe("working");
    expect(c.inputEnabled).toBe(true);
  });

  it("never lets the primary action be destructive (#970)", () => {
    // Ctrl+Enter / the primary button used to call stop while a turn ran.
    for (const s of [
      state({ isSessionAlive: true, prompt: "x" }),
      state({ isSessionAlive: true, isWaitingForInput: true, prompt: "x" }),
      state({ prompt: "x" }),
    ]) {
      const c = composerState(s);
      expect(["queue", "send-turn", "launch"]).toContain(c.action);
    }
  });

  it("offers Stop as a separate control beside the primary action", () => {
    const c = composerState(state({ isSessionAlive: true, prompt: "x" }));
    expect(c.showStop).toBe(true);
    expect(c.action).toBe("queue");
  });

  it("queues a draft while working, then reports it as queued", () => {
    const armed = composerState(state({ isSessionAlive: true, prompt: "later", queued: false }));
    expect(armed.primaryLabel).toBe("Queue");
    expect(armed.primaryEnabled).toBe(true);

    const held = composerState(state({ isSessionAlive: true, prompt: "later", queued: true }));
    expect(held.primaryLabel).toBe("Queued");
    // Already armed — clicking again would do nothing.
    expect(held.primaryEnabled).toBe(false);
    expect(held.hint).toMatch(/Queued/);
  });

  it("disables the primary action on empty input or while an action is loading", () => {
    expect(composerState(state({ prompt: "   " })).primaryEnabled).toBe(false);
    expect(composerState(state({ prompt: "x", actionLoading: true })).primaryEnabled).toBe(false);
  });

  it("only hints while a turn is running", () => {
    expect(composerState(state({ prompt: "x" })).hint).toBeNull();
    expect(composerState(state({ isSessionAlive: true, isWaitingForInput: true })).hint).toBeNull();
    expect(composerState(state({ isSessionAlive: true })).hint).not.toBeNull();
  });
});
