/**
 * #1110 — the base-health sweep's own targeted flake retry, the twin of the pre-merge gate's
 * #894 retry (`verify-retry-strategies.test.ts`). Measured: a load-shaped failure in
 * `monitor-file-contention.test.ts` reded a 41-minute sweep and blocked `pnpm promote` outright,
 * while the same suite passed 21/21 minutes later on an idle box. `runRetry` is injected so this
 * exercises the decision without a real clone/install/verify chain.
 *
 * #1242 follow-up — vitest 4 prints its `FAIL` summary lines on STDERR and the runner's
 * `[test:mine] <pkg>:` headers on STDOUT. `combined` is built as `stderr + "\n" + stdout`
 * (mirroring the real caller), so on vitest-4-shaped output every FAIL line precedes every
 * header and the OLD header-based parse attributed nothing, refusing every retry. The suites
 * below are therefore split across stderr/stdout exactly like a real run, and
 * `resolveRedProbeOutcome` is exercised with an injected `classifySuites` standing in for
 * `classifyFailedSuites(workingDir, …)` (disk attribution), the same seam
 * `verify-retry-strategies.ts` uses.
 */
import { describe, expect, it } from "vitest";
import { resolveRedProbeOutcome, type RetryRunResult } from "../services/base-branch-health.service.js";
import type { FailedSuite } from "../services/verify-flake-retry.js";
import type { FailedSuiteClassification } from "../services/verify-failed-suites.js";

const FLAKY_STDERR = ` FAIL  src/__tests__/monitor-file-contention.test.ts > one\n Test Files  1 failed | 761 passed (762)`;
const FLAKY_STDOUT = `[test:mine] server: node vitest run`;
// #1242 follow-up: FAIL on stderr, header on stdout — `combined` is `stderr + "\n" + stdout`.
const FLAKY_OUTPUT = `${FLAKY_STDERR}\n${FLAKY_STDOUT}`;

const BROAD_STDERR = Array.from({ length: 8 }, (_, i) => ` FAIL  src/__tests__/suite-${i}.test.ts > one`).join("\n");
const BROAD_OUTPUT = `${BROAD_STDERR}\n[test:mine] server: node vitest run`;

const GUARD_STDERR = ` FAIL  src/__tests__/example-invariant.test.ts > one`;
const GUARD_OUTPUT = `${GUARD_STDERR}\n[test:mine] server: node vitest run`;

const pass: RetryRunResult = { exitCode: 0, stdout: "", stderr: "" };
const fail = (stdout = FLAKY_OUTPUT): RetryRunResult => ({ exitCode: 1, stdout, stderr: "" });

/** Stands in for `classifyFailedSuites(workingDir, …)`: places every unlabelled suite under `server`. */
function classifyUnderServer(suites: readonly FailedSuite[], guardFiles: readonly string[] = []): FailedSuiteClassification {
  const files = suites.map((s) => `packages/server/${s.file}`);
  const guardSuites = files.filter((f) => guardFiles.some((g) => f.endsWith(g)));
  return { files, guardSuites, guardFailure: files.length > 0 && guardSuites.length === files.length };
}

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
    nowMs: 1_000 + 5_000,
    workingDir: "/probe/clone",
    classifySuites: (suites: FailedSuite[]) => classifyUnderServer(suites),
    runRetry: async (retryScopeEnv: string) => {
      calls.retry++;
      scopes.push(retryScopeEnv);
      return pass;
    },
    ...overrides,
  };
  return { input, calls, scopes };
}

describe("resolveRedProbeOutcome (#1110, #1242 follow-up)", () => {
  it("records a plain red without retrying when nothing looks attributable", async () => {
    const h = harness({ combined: "some opaque tsc crash with no suite names", scoped: true });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(out.flaky).toBeUndefined();
    expect(h.calls.retry).toBe(0);
  });

  it("attributes and clears a vitest-4-shaped (stderr-first) load-induced failure with ONE targeted re-run, GREEN + flaky: true, and records retried", async () => {
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
    // #1242 follow-up — the sweep names exactly the one retried suite.
    expect(out.retried).toEqual(["packages/server/src/__tests__/monitor-file-contention.test.ts"]);
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
    expect(out.retried).toEqual(["packages/server/src/__tests__/monitor-file-contention.test.ts"]);
    expect(retries).toBe(1);
  });

  it("never retries a broad failure — that reads as a regression, not contention", async () => {
    const h = harness({ combined: BROAD_OUTPUT });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(h.calls.retry).toBe(0);
    expect(out.retried).toBeUndefined();
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

  it("refuses a retry on a deterministic guard/ratchet failure, even attributed and narrow (#1230)", async () => {
    const h = harness({
      combined: GUARD_OUTPUT,
      classifySuites: (suites: FailedSuite[]) => classifyUnderServer(suites, ["example-invariant.test.ts"]),
    });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(out.flaky).toBeUndefined();
    expect(h.calls.retry).toBe(0);
    expect(out.retried).toBeUndefined();
  });

  it("falls back to header-only (unattributed) behaviour when no workingDir/classifySuites is given", async () => {
    // No workingDir and no classifySuites injected: the stderr-first FAIL line still cannot be
    // placed by a package header, so this must decline exactly as before the fix — never throw
    // and never misattribute.
    const h = harness({ workingDir: undefined, classifySuites: undefined });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(h.calls.retry).toBe(0);
  });

  it("keeps the runner's stderr verdict and names the full log when every visible suite passed (#1303)", async () => {
    // The rc/20261004-3 shape: stdout ends in a later package's PASSING summary, the runner's
    // own verdict is on stderr, and `combined` (stderr first) tails to passing lines only.
    const stdout = Array.from({ length: 60 }, (_, i) => ` ✓ src/lib/s${i}.test.ts (2 tests) 4ms`).join("\n")
      + "\n Test Files  202 passed (202)\n[gate:step] name=tests seconds=841 scope=full";
    const stderr = "[test:mine] tree drift: packages/server/src/generated.json modified by the run\n"
      + "[test:mine] One or more packages had failing tests.";
    const logged: string[] = [];
    const h = harness({
      combined: `${stderr}\n${stdout}`,
      stdout,
      stderr,
      summarizeFailure: (o, e) => {
        logged.push(`${e}\n${o}`);
        return `${o.slice(-200)}\n[full verify log: /tmp/kanban-verify-base-health.log]`;
      },
    });
    const out = await resolveRedProbeOutcome(h.input);
    expect(out.outcome).toBe("red");
    expect(out.message).toContain("tree drift: packages/server/src/generated.json");
    expect(out.message).toContain("One or more packages had failing tests");
    expect(out.message).toContain("[full verify log: /tmp/kanban-verify-base-health.log]");
    // The FULL output reached the log writer, not a tail of it.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("s0.test.ts");
  });

  it("a crashed vitest worker gets ONE retry of exactly the file it never reported (#1309)", async () => {
    const stdout = [
      "[test:mine] server: node vitest run --maxWorkers=4",
      " ✓ src/__tests__/one.test.ts (3 tests) 5ms",
      "Error: [vitest-pool]: Worker forks emitted error.",
      "Caused by: Error: Worker exited unexpectedly",
      " Test Files  1 passed (2)",
    ].join("\n");
    const h = harness({
      combined: stdout,
      stdout,
      stderr: "",
      listTests: () => ["src/__tests__/one.test.ts", "src/__tests__/project-relocate.service.test.ts"],
    });
    const out = await resolveRedProbeOutcome(h.input);
    expect(h.calls.retry).toBe(1);
    expect(h.scopes).toEqual(["server:src/__tests__/project-relocate.service.test.ts"]);
    expect(out.outcome).toBe("green");
    expect(out.flaky).toBe(true);
    expect(out.message).toContain("left unreported by a crashed vitest worker");
    expect(out.retried).toEqual(["packages/server/src/__tests__/project-relocate.service.test.ts"]);

    const again = harness({
      combined: stdout,
      stdout,
      stderr: "",
      listTests: () => ["src/__tests__/one.test.ts", "src/__tests__/project-relocate.service.test.ts"],
      runRetry: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });
    expect((await resolveRedProbeOutcome(again.input)).outcome).toBe("red");
  });
});
