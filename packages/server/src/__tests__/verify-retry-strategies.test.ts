/**
 * #894 — the retry ORCHESTRATION, as opposed to `verify-flake-retry.test.ts`, which pins the
 * classifier that decides whether a retry is warranted at all.
 *
 * The property worth pinning hardest is the one the ticket exists for: the gate ran a full
 * 7,183-test suite fifteen times on one workspace and merged zero times, because each full run
 * was itself the machine load that made the next one flake. So every case here counts CALLS,
 * not just verdicts — a retry path that can iterate would recreate the bug it was written to
 * fix, and would still look correct if we only asserted the final pass/fail.
 */
import { describe, expect, it, vi } from "vitest";
import { type ResolveVerifyOutcomeInput, resolveVerifyOutcome } from "../services/verify-retry-strategies.js";

const FLAKY_OUTPUT = `
[test:mine] server: node vitest run
 FAIL  src/__tests__/a.test.ts > one
 Test Files  1 failed | 761 passed (762)
`;

const pass = { exitCode: 0, stdout: "", stderr: "" };
const fail = (stdout = FLAKY_OUTPUT) => ({ exitCode: 1, stdout, stderr: "" });

function harness(overrides: Partial<ResolveVerifyOutcomeInput> = {}) {
  const calls = { verify: 0, scopedVerify: 0, install: 0 };
  const scopes: string[] = [];
  const input: ResolveVerifyOutcomeInput = {
    result: fail(),
    runVerify: async () => {
      calls.verify++;
      return fail();
    },
    runVerifyWithRetryScope: async (scope) => {
      calls.scopedVerify++;
      scopes.push(scope);
      return pass;
    },
    getInstallCommand: async () => null,
    runInstall: async () => {
      calls.install++;
    },
    looksLikeMissingDeps: () => false,
    scoped: true,
    verifyTimeoutMs: 900_000,
    projectId: "proj-1",
    workspaceId: "ws-1",
    summarize: (stdout, stderr) => `${stdout}${stderr}`.slice(0, 40),
    log: () => {},
    ...overrides,
  };
  return { input, calls, scopes };
}

describe("resolveVerifyOutcome", () => {
  it("passes a green first run straight through, retrying nothing", async () => {
    const h = harness({ result: pass });
    const out = await resolveVerifyOutcome(h.input);
    expect(out.failure).toBeNull();
    expect(h.calls).toEqual({ verify: 0, scopedVerify: 0, install: 0 });
  });

  it("clears a load-induced failure with ONE targeted re-run, and says so", async () => {
    const h = harness();
    const out = await resolveVerifyOutcome(h.input);
    expect(out.failure).toBeNull();
    expect(h.calls.scopedVerify).toBe(1);
    expect(h.scopes).toEqual(["server:src/__tests__/a.test.ts"]);
    // A level may only weaken verification VISIBLY — a merge cleared by a second, narrower
    // run must never read as a plain pass.
    expect(out.flakeRetryNote).toMatch(/PASSED on a targeted re-run/);
    expect(out.flakeRetryNote).toContain("src/__tests__/a.test.ts");
  });

  it("calls the same failure REAL when the narrow re-run fails too — and does not try a third time", async () => {
    const h = harness({ runVerifyWithRetryScope: async () => fail() });
    const out = await resolveVerifyOutcome(h.input);
    expect(out.failure?.message).toMatch(/this is a real failure, not machine load/);
    // The second failure happened nearly alone on the box, so the message must not simply
    // repeat the first verdict as if nothing further had been learned.
    expect(out.failure?.message).toMatch(/failed again on a targeted re-run/);
    expect(h.calls.verify).toBe(0);
  });

  it("never retries more than once per strategy, even when every run fails", async () => {
    // The #894 failure mode in miniature: both strategies fire on the same run.
    let scoped = 0;
    const h = harness({
      looksLikeMissingDeps: () => true,
      getInstallCommand: async () => "pnpm install -r",
      runVerifyWithRetryScope: async () => {
        scoped++;
        return fail();
      },
    });
    const out = await resolveVerifyOutcome(h.input);
    expect(out.failure).not.toBeNull();
    expect({ ...h.calls, scopedVerify: scoped }).toEqual({ verify: 1, scopedVerify: 1, install: 1 });
  });

  it("runs the install retry when the failure looks like missing deps (#169)", async () => {
    const h = harness({
      looksLikeMissingDeps: () => true,
      getInstallCommand: async () => "pnpm install -r",
      runVerify: async () => pass,
    });
    const out = await resolveVerifyOutcome(h.input);
    expect(out.failure).toBeNull();
    expect(h.calls.install).toBe(1);
    // The flake retry must not also fire — the run is already green.
    expect(h.calls.scopedVerify).toBe(0);
  });

  it("skips the install retry for a project with no install command configured", async () => {
    const h = harness({ looksLikeMissingDeps: () => true, getInstallCommand: async () => "  " });
    await resolveVerifyOutcome(h.input);
    expect(h.calls.install).toBe(0);
    expect(h.calls.verify).toBe(0);
  });

  it("says the install retry happened when the code still fails afterwards", async () => {
    const h = harness({
      looksLikeMissingDeps: () => true,
      getInstallCommand: async () => "pnpm install -r",
      // A failure the flake classifier refuses (nothing nameable), so we land on the plain path.
      runVerify: async () => ({ exitCode: 1, stdout: "error TS2345: ...", stderr: "" }),
    });
    const out = await resolveVerifyOutcome(h.input);
    expect(out.failure?.message).toMatch(/retried once after an auto-install; still failing/);
  });

  it("reports a timeout as INCONCLUSIVE and retries nothing — a wall-clock kill is not a red gate (#192)", async () => {
    const h = harness({ result: { exitCode: 1, stdout: FLAKY_OUTPUT, stderr: "", timedOut: true } });
    const out = await resolveVerifyOutcome(h.input);
    expect(out.failure?.timedOut).toBe(true);
    expect(out.failure?.message).toMatch(/inconclusive/);
    expect(out.failure?.message).toContain("verify_timeout_ms_proj-1");
    expect(h.calls).toEqual({ verify: 0, scopedVerify: 0, install: 0 });
  });

  it("reports a timeout that struck only AFTER the install retry, naming it", async () => {
    const h = harness({
      looksLikeMissingDeps: () => true,
      getInstallCommand: async () => "pnpm install -r",
      runVerify: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true }),
    });
    const out = await resolveVerifyOutcome(h.input);
    expect(out.failure?.timedOut).toBe(true);
    expect(out.failure?.message).toMatch(/after an auto-install retry/);
  });

  it("does not attempt a targeted re-run for a project whose verify_script cannot scope", async () => {
    // gradlew/pytest/mvn ignore KANBAN_RETRY_TEST_FILES, so the "targeted" re-run would be a
    // second FULL build — the 44-minute operation this feature exists to avoid.
    const h = harness({ scoped: false });
    const out = await resolveVerifyOutcome(h.input);
    expect(h.calls.scopedVerify).toBe(0);
    expect(out.failure?.message).toMatch(/verify_script failed \(exit 1\)/);
  });

  it("tags its default log line so it is greppable by subsystem (#616)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({ log: undefined });
      await resolveVerifyOutcome(h.input);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[pre-merge-gate]"));
    } finally {
      warn.mockRestore();
    }
  });
});
