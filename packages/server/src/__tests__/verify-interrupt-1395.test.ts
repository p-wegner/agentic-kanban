/**
 * #1395 — an interrupted verify says who interrupted it and is re-queued (held), never a red gate;
 * a `warn` line is never a failing suite; concurrent verify jobs do not share a log file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ResolveVerifyOutcomeInput, resolveVerifyOutcome } from "../services/verify-retry-strategies.js";
import { parseArchOffenders } from "../services/verify-failed-suites.js";
import { beginMergeGateRun, endMergeGateRun, requestMergeGateCancellation, resetMergeCancellation } from "../services/merge-cancellation.js";
import { verifyLogPath } from "../services/verify-failure-summary.js";

afterEach(() => {
  resetMergeCancellation();
  vi.restoreAllMocks();
});

function input(signal: AbortSignal, overrides: Partial<ResolveVerifyOutcomeInput> = {}): ResolveVerifyOutcomeInput {
  return {
    result: { exitCode: 130, stdout: "", stderr: "", aborted: true },
    runVerify: async () => ({ exitCode: 0 }),
    runVerifyWithRetryScope: async () => ({ exitCode: 0 }),
    getInstallCommand: async () => null,
    runInstall: async () => {},
    looksLikeMissingDeps: () => false,
    scoped: true,
    verifyTimeoutMs: 1000,
    projectId: "p",
    workspaceId: "ws-1",
    summarize: () => "SHOULD NOT BE USED",
    log: () => {},
    signal,
    ...overrides,
  };
}

describe("cancelled verify (#1395)", () => {
  it("reports an aborted run as held with the interrupter's reason, not as a failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = beginMergeGateRun("ws-1");
    beginMergeGateRun("ws-1"); // supersedes the first
    expect(first.aborted).toBe(true);
    const out = await resolveVerifyOutcome(input(first));
    expect(out.failure?.held).toBe(true);
    expect(out.failure?.message).toContain("CANCELLED");
    expect(out.failure?.message).toContain("superseded by a newer pre-merge gate run");
    expect(out.failure?.message).not.toContain("exit 130");
  });

  it("names the operator cancel as the reason and logs who/why", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const signal = beginMergeGateRun("ws-2");
    expect(requestMergeGateCancellation("ws-2")).toBe(true);
    expect(String(signal.reason)).toContain("merge/cancel");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ws-2"));
  });

  it("a superseded run settling does not unregister its successor", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = beginMergeGateRun("ws-3");
    beginMergeGateRun("ws-3");
    endMergeGateRun("ws-3", first);
    expect(requestMergeGateCancellation("ws-3")).toBe(true);
  });
});

describe("failing-check extractor (#1395)", () => {
  it("never reports a dependency-cruiser `warn` line as a failing file", () => {
    const out = [
      "[god-module gate] file(s) over the ceiling:",
      "  packages/server/src/big.ts",
      "  warn startup-bypasses-repositories: packages/server/src/startup/x.ts → packages/server/src/db/index.ts",
    ].join("\n");
    expect(parseArchOffenders(out)).toEqual(["packages/server/src/big.ts"]);
  });

  it("names nothing when only warn lines follow the header", () => {
    const out = ["[god-module gate] FAILED", "  warn startup-bypasses-repositories: a.ts → b.ts"].join("\n");
    expect(parseArchOffenders(out)).toEqual([]);
  });
});

describe("verify log path (#1395)", () => {
  it("gives the implement-exit check its own file", () => {
    expect(verifyLogPath("ws-1-implement-exit")).not.toBe(verifyLogPath("ws-1"));
  });
});
