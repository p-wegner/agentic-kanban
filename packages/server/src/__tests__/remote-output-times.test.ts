import { describe, it, expect } from "vitest";
import { listRemoteOutputTimes } from "../services/agent-remote-detached.js";
import type { RemoteSession } from "../services/agent-remote.types.js";

describe("listRemoteOutputTimes (#1392)", () => {
  it("lists only sessions that have produced output", () => {
    const base = { workerId: "w", onOutput: () => {}, stdinOpen: false } as RemoteSession;
    const sessions = new Map<string, RemoteSession>([
      ["a", { ...base, lastOutputAtMs: 123 }],
      ["b", { ...base }],
    ]);
    expect([...listRemoteOutputTimes(sessions)]).toEqual([["a", 123]]);
  });
});
