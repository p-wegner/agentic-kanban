import { describe, expect, it, vi } from "vitest";
import {
  findBackgroundWaitPhrase,
  followUpOnBackgroundWait,
  resetBackgroundWaitFollowUps,
} from "../startup/exit/background-wait-exit.js";
import { buildTicketContextMarkdown } from "@agentic-kanban/shared/lib/ticket-context";

describe("findBackgroundWaitPhrase (#1557)", () => {
  it("flags #1553's final message", () => {
    expect(findBackgroundWaitPhrase(
      "The snapshot regeneration and the time-zone checks are still running in the background. I'm waiting for the monitor to report.",
    )).not.toBeNull();
  });
  it("leaves a finished summary alone", () => {
    expect(findBackgroundWaitPhrase("Done. Committed abc123; all tests pass.")).toBeNull();
    expect(findBackgroundWaitPhrase(null)).toBeNull();
  });
});

describe("followUpOnBackgroundWait", () => {
  const waiting = async () => "Still running in the background, waiting for the monitor.";
  it("sends a follow-up turn, capped", async () => {
    resetBackgroundWaitFollowUps("w1");
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = { sendBuilderTurn: send, readFinalMessage: waiting, cap: 2 };
    expect(await followUpOnBackgroundWait(deps, { workspaceId: "w1", sessionId: "s" })).toBe(true);
    expect(await followUpOnBackgroundWait(deps, { workspaceId: "w1", sessionId: "s" })).toBe(true);
    expect(await followUpOnBackgroundWait(deps, { workspaceId: "w1", sessionId: "s" })).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("does nothing for an ordinary final message", async () => {
    resetBackgroundWaitFollowUps("w2");
    const send = vi.fn();
    expect(await followUpOnBackgroundWait({ sendBuilderTurn: send, readFinalMessage: async () => "All done." }, { workspaceId: "w2", sessionId: "s" })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("builder prompt", () => {
  it("says the session is one-shot", () => {
    const md = buildTicketContextMarkdown({ title: "t", description: "d" } as never);
    expect(md).toContain("This session is one-shot");
  });
});
