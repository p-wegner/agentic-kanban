import { describe, it, expect } from "vitest";
import {
  detectAgentStall,
  DEFAULT_STALL_THRESHOLD_SEC,
  DEFAULT_LOOP_WINDOW,
} from "./detectAgentStall.js";

// Fixed injected clock so every case is deterministic (time-dependent-tests rule).
const NOW = 1_700_000_000_000;
const secAgo = (s: number) => NOW - s * 1000;

describe("detectAgentStall", () => {
  it("returns ok for a healthy active agent with recent activity", () => {
    const signal = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(5),
      recentTools: ["Read a.ts", "Edit b.ts", "Bash npm test"],
      now: NOW,
    });
    expect(signal.state).toBe("ok");
    expect(signal.idleSec).toBe(5);
    expect(signal.repeatedTool).toBeUndefined();
  });

  it("flags stalled when idle >= threshold for a running agent", () => {
    const signal = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(300),
      thresholdSec: DEFAULT_STALL_THRESHOLD_SEC,
      now: NOW,
    });
    expect(signal.state).toBe("stalled");
    expect(signal.idleSec).toBe(300);
  });

  it("flags stalled for a 'fixing' agent too", () => {
    const signal = detectAgentStall({
      status: "fixing",
      lastActivityAt: secAgo(500),
      now: NOW,
    });
    expect(signal.state).toBe("stalled");
  });

  it("honors the threshold boundary exactly (>= is stalled, one second under is ok)", () => {
    const threshold = 240;
    const atBoundary = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(threshold),
      thresholdSec: threshold,
      now: NOW,
    });
    expect(atBoundary.state).toBe("stalled");

    const justUnder = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(threshold - 1),
      thresholdSec: threshold,
      now: NOW,
    });
    expect(justUnder.state).toBe("ok");
  });

  it("honors a custom (non-default) threshold from the setting", () => {
    const signal = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(90),
      thresholdSec: 60,
      now: NOW,
    });
    expect(signal.state).toBe("stalled");
    // Same idle would be ok under the default 240s threshold.
    expect(
      detectAgentStall({ status: "active", lastActivityAt: secAgo(90), now: NOW }).state,
    ).toBe("ok");
  });

  it("flags looping when the last K tool calls are identical", () => {
    const signal = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(2),
      recentTools: ["Edit x.ts", "Read x.ts", "Read x.ts", "Read x.ts", "Read x.ts"],
      now: NOW,
    });
    expect(signal.state).toBe("looping");
    expect(signal.repeatedTool).toBe("Read x.ts");
    expect(signal.repeatCount).toBe(4);
  });

  it("counts the full trailing identical run for repeatCount", () => {
    const signal = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(1),
      recentTools: Array.from({ length: 6 }, () => "Bash git status"),
      now: NOW,
    });
    expect(signal.state).toBe("looping");
    expect(signal.repeatCount).toBe(6);
  });

  it("does not flag looping with fewer than loopWindow identical calls", () => {
    const signal = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(2),
      recentTools: ["Read x.ts", "Read x.ts", "Read x.ts"], // only 3, window is 4
      now: NOW,
    });
    expect(signal.state).toBe("ok");
  });

  it("does not flag looping when the trailing calls differ", () => {
    const signal = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(2),
      recentTools: ["Read x.ts", "Read x.ts", "Read x.ts", "Edit x.ts"],
      now: NOW,
    });
    expect(signal.state).toBe("ok");
  });

  it("respects a custom loopWindow", () => {
    const tools = ["Read x.ts", "Read x.ts"];
    expect(detectAgentStall({ status: "active", lastActivityAt: secAgo(1), recentTools: tools, loopWindow: 2, now: NOW }).state).toBe("looping");
    expect(detectAgentStall({ status: "active", lastActivityAt: secAgo(1), recentTools: tools, now: NOW }).state).toBe("ok");
  });

  it("stalled takes precedence over looping when both apply", () => {
    const signal = detectAgentStall({
      status: "active",
      lastActivityAt: secAgo(600),
      recentTools: ["Read x.ts", "Read x.ts", "Read x.ts", "Read x.ts"],
      now: NOW,
    });
    expect(signal.state).toBe("stalled");
  });

  it("never flags a non-live status (reviewing/idle/closed) even when idle or looping", () => {
    for (const status of ["reviewing", "idle", "closed", "blocked", "error"]) {
      const signal = detectAgentStall({
        status,
        lastActivityAt: secAgo(9999),
        recentTools: ["Read x.ts", "Read x.ts", "Read x.ts", "Read x.ts"],
        now: NOW,
      });
      expect(signal.state).toBe("ok");
    }
  });

  it("returns ok with idleSec 0 when lastActivityAt is unknown", () => {
    const signal = detectAgentStall({ status: "active", now: NOW });
    expect(signal.state).toBe("ok");
    expect(signal.idleSec).toBe(0);
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_STALL_THRESHOLD_SEC).toBe(240);
    expect(DEFAULT_LOOP_WINDOW).toBe(4);
  });
});
