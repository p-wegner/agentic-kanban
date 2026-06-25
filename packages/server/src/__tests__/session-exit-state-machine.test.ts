import { describe, it, expect } from "vitest";
import {
  classifySessionExit,
  extractCapturedStderr,
  ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS,
  type SessionExitContext,
} from "../services/session-manager/session-exit-state-machine.js";
import type { ProviderUsageLimit } from "../services/agent-provider/provider-exit-behavior.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

/**
 * GATE for #910: the exit state machine's `classify` phase encodes the ORDERING
 * invariant that used to live tangled inside the 225-line lifecycle closure —
 *   stopped > usage-limit > launch-failure > completed
 * and the launch-failure window logic. These are pure unit tests over the phase
 * function, including the out-of-order / boundary event sequences that the closure
 * could not test (e.g. a usage limit that ALSO looks like a fast launch failure
 * must classify as usage-limit, not be swallowed by the window).
 */

/** A SessionExitContext with healthy-completion defaults; override per case. */
function ctx(over: Partial<SessionExitContext> = {}): SessionExitContext {
  return {
    exitCode: 0,
    durationMs: 60_000, // well past the launch-failure window by default
    hadSubstantiveOutput: true,
    stoppedByUser: false,
    usageLimit: null,
    planText: null,
    capturedStderr: "",
    ...over,
  };
}

const codexLimit: ProviderUsageLimit = { kind: "codex", message: "you've hit your usage limit for X", retryAfter: "Jun 6th" };
const claudeLimit: ProviderUsageLimit = { kind: "claude", message: "Claude usage limit reached", retryAfter: null };

describe("classifySessionExit — priority ordering", () => {
  it("routes a user-stopped exit to 'stopped' even with substantive output and a clean code", () => {
    expect(classifySessionExit(ctx({ stoppedByUser: true })).phase).toBe("stopped");
  });

  it("user-stop WINS over a usage limit (the explicit stop must never be reclassified)", () => {
    const route = classifySessionExit(ctx({ stoppedByUser: true, usageLimit: codexLimit, exitCode: 1, durationMs: 500 }));
    expect(route.phase).toBe("stopped");
  });

  it("user-stop WINS over a launch failure", () => {
    const route = classifySessionExit(ctx({ stoppedByUser: true, hadSubstantiveOutput: false, durationMs: 500, exitCode: 1 }));
    expect(route.phase).toBe("stopped");
  });

  it("usage-limit WINS over the launch-failure window (a fast quota hit is not a plain crash)", () => {
    // Within the window AND zero output AND non-zero exit — but a usage limit was hit.
    const route = classifySessionExit(ctx({ usageLimit: codexLimit, hadSubstantiveOutput: false, durationMs: 500, exitCode: 1 }));
    expect(route.phase).toBe("usage-limit");
    if (route.phase === "usage-limit") {
      expect(route.usageLimit).toBe(codexLimit);
    }
  });
});

describe("classifySessionExit — usage-limit effectiveExitCode", () => {
  it("keeps a real non-zero exit code", () => {
    const route = classifySessionExit(ctx({ usageLimit: claudeLimit, exitCode: 3 }));
    expect(route.phase === "usage-limit" && route.effectiveExitCode).toBe(3);
  });

  it("coerces a 0 exit code to 1 (a rate-limited run is a failure, not success)", () => {
    const route = classifySessionExit(ctx({ usageLimit: claudeLimit, exitCode: 0 }));
    expect(route.phase === "usage-limit" && route.effectiveExitCode).toBe(1);
  });

  it("coerces a null exit code to 1", () => {
    const route = classifySessionExit(ctx({ usageLimit: claudeLimit, exitCode: null }));
    expect(route.phase === "usage-limit" && route.effectiveExitCode).toBe(1);
  });
});

describe("classifySessionExit — launch-failure detection", () => {
  it("classifies a fast zero-output clean exit as a zero-output launch failure (#909 class)", () => {
    const route = classifySessionExit(ctx({ hadSubstantiveOutput: false, durationMs: 1_000, exitCode: 0 }));
    expect(route.phase).toBe("launch-failure");
    if (route.phase === "launch-failure") {
      expect(route.isZeroOutput).toBe(true);
      expect(route.isNonZeroExit).toBe(false);
      expect(route.effectiveExitCode).toBe(1); // zero-output crash → forced to 1
    }
  });

  it("classifies a fast non-zero exit WITH error text as a model-error launch failure (#699)", () => {
    const route = classifySessionExit(ctx({
      hadSubstantiveOutput: true,
      durationMs: 5_000,
      exitCode: 1,
      planText: "There is an issue with the selected model",
    }));
    expect(route.phase).toBe("launch-failure");
    if (route.phase === "launch-failure") {
      expect(route.isZeroOutput).toBe(false);
      expect(route.isNonZeroExit).toBe(true);
      expect(route.effectiveExitCode).toBe(1);
      expect(route.errorText).toBe("There is an issue with the selected model");
    }
  });

  it("falls back to captured stderr for the error text when there is no plan text", () => {
    const route = classifySessionExit(ctx({
      hadSubstantiveOutput: false,
      durationMs: 800,
      exitCode: 2,
      capturedStderr: "spawn auth error",
    }));
    expect(route.phase).toBe("launch-failure");
    if (route.phase === "launch-failure") {
      expect(route.effectiveExitCode).toBe(2);
      expect(route.errorText).toBe("spawn auth error");
    }
  });

  it("treats a null exit code with zero output inside the window as a zero-output failure", () => {
    const route = classifySessionExit(ctx({ hadSubstantiveOutput: false, durationMs: 500, exitCode: null }));
    expect(route.phase).toBe("launch-failure");
    if (route.phase === "launch-failure") {
      expect(route.isZeroOutput).toBe(true);
      expect(route.isNonZeroExit).toBe(false); // null is NOT a non-zero exit
      expect(route.effectiveExitCode).toBe(1);
    }
  });
});

describe("classifySessionExit — boundary of the launch-failure window", () => {
  it("a zero-output exit EXACTLY at the window edge is still a launch failure (<=)", () => {
    const route = classifySessionExit(ctx({ hadSubstantiveOutput: false, durationMs: ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS, exitCode: 0 }));
    expect(route.phase).toBe("launch-failure");
  });

  it("a zero-output exit ONE ms past the window is a completed run, not a failure", () => {
    const route = classifySessionExit(ctx({ hadSubstantiveOutput: false, durationMs: ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS + 1, exitCode: 0 }));
    expect(route.phase).toBe("completed");
  });

  it("a non-zero exit PAST the window with substantive output is a completed run (real work, then crash)", () => {
    const route = classifySessionExit(ctx({ hadSubstantiveOutput: true, durationMs: 120_000, exitCode: 1 }));
    expect(route.phase).toBe("completed");
    expect(route.phase === "completed" && route.exitCode).toBe(1);
  });
});

describe("classifySessionExit — completed", () => {
  it("a clean exit with substantive output past the window is completed", () => {
    const route = classifySessionExit(ctx());
    expect(route.phase).toBe("completed");
    expect(route.phase === "completed" && route.exitCode).toBe(0);
  });

  it("substantive output INSIDE the window with a clean exit is completed (fast but real)", () => {
    const route = classifySessionExit(ctx({ durationMs: 2_000, exitCode: 0, hadSubstantiveOutput: true }));
    expect(route.phase).toBe("completed");
  });
});

describe("extractCapturedStderr", () => {
  const msg = (type: string, data: string | null): AgentOutputMessage => ({ type, data } as unknown as AgentOutputMessage);

  it("concatenates and trims only stderr messages", () => {
    const messages = [
      msg("stdout", "hello"),
      msg("stderr", "  err1 "),
      msg("system", "ignored"),
      msg("stderr", "err2  "),
    ];
    expect(extractCapturedStderr(messages)).toBe("err1 err2");
  });

  it("returns empty string when there is no stderr", () => {
    expect(extractCapturedStderr([msg("stdout", "x")])).toBe("");
  });

  it("tolerates null data on stderr messages", () => {
    expect(extractCapturedStderr([msg("stderr", null), msg("stderr", "real")])).toBe("real");
  });
});
