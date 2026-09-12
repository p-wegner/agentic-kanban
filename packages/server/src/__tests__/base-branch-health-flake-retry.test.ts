/**
 * #1110 — the base-health sweep's own targeted flake retry, the twin of the pre-merge gate's
 * #894 retry (`verify-retry-strategies.test.ts`). Measured: a load-shaped failure in
 * `monitor-file-contention.test.ts` reded a 41-minute sweep and blocked `pnpm promote` outright,
 * while the same suite passed 21/21 minutes later on an idle box. `runRetry` is injected so this
 * exercises the decision without a real clone/install/verify chain.
 */
import { describe, expect, it } from "vitest";
import { resolveRedProbeOutcome, type RetryRunResult } from "../services/base-branch-health.service.js";

const FLAKY_OUTPUT = `
[test:mine] server: node vitest run
 FAIL  src/__tests__/monitor-file-contention.test.ts > one
 Test Files  1 failed | 761 passed (762)
`;

const BROAD_OUTPUT = Array.from({ length: 8 }, (_, i) => `
[test:mine] server: node vitest run
 FAIL  src/__tests__/suite-${i}.test.ts > one`).join("\n");

const pass: RetryRunResult = { exitCode: 0, stdout: "", stderr: "" };
const fail = (stdout = FLAKY_OUTPUT): RetryRunResult => ({ exitCode: 1, stdout, stderr: "" });

function harness(overrides: Partial<Parameters<typeof resolveRedProbeOutcome>[0]> = {}) {
  const calls = { retry: 0 };
  const scopes: string[] = [];
  const input = {
    projectId: "proj-1",
    sha: "deadbeef",
    branch: "master",
    exitCode: 1,
    combined: FLAKY_OUTPUT,
    startedAt: 1_000,
    scoped: true,
    now: () => 1_000 + 5_000,
    runRetry: async (retryScopeEnv: string) => {
      calls.retry++;
      scopes.push(retryScopeEnv);
      return pass;
    },
    ...overrides,
  };
  return { input, calls, scopes };
}

describe("resolveRedProbeOutcome (#1110)", () => {
  it("records a plain red without retrying when nothing looks attributable", async () => {
    const h = harness({ combined: "some opaque tsc crash with no suite names", scoped: true });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(out.flaky).toBeUndefined();
    expect(h.calls.retry).toBe(0);
  });

  it("clears a load-induced failure with ONE targeted re-run and records GREEN, flaky: true", async () => {
    const h = harness();
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("green");
    expect(out.flaky).toBe(true);
    expect(out.failedSuites).toEqual([]);
    expect(h.calls.retry).toBe(1);
    expect(h.scopes).toEqual(["server:src/__tests__/monitor-file-contention.test.ts"]);
    // A level may only weaken verification VISIBLY — the retry must be named in the message.
    expect(out.message).toMatch(/passed on a targeted re-run/);
    expect(out.message).toContain("monitor-file-contention.test.ts");
    // durationMs reflects the retry too, not just the first (failed) run.
    expect(out.durationMs).toBe(5_000);
  });

  it("records a real red when the same suite(s) fail again on the narrow re-run — and does not retry a third time", async () => {
    let retries = 0;
    const h = harness({ runRetry: async () => { retries++; return fail(); } });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(out.flaky).toBeUndefined();
    expect(out.message).toMatch(/failed again on a targeted re-run/);
    expect(out.message).toMatch(/this is a real failure, not machine load/);
    expect(retries).toBe(1);
  });

  it("never retries a broad failure — that reads as a regression, not contention", async () => {
    const h = harness({ combined: BROAD_OUTPUT });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(h.calls.retry).toBe(0);
  });

  it("never retries when the project's verify_script does not honour a suite scope", async () => {
    const h = harness({ scoped: false });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(h.calls.retry).toBe(0);
  });

  it("declines a retry that itself times out, since a timeout carries no verdict either way", async () => {
    const h = harness({ runRetry: async () => ({ ...fail(), timedOut: true }) });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(out.flaky).toBeUndefined();
  });
});
