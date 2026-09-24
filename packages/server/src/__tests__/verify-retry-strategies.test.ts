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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // #915 — the cleared suite(s) are also returned structured, so a caller with a red-debt
    // ledger can open a `flaky` entry per suite instead of just prose in the message.
    expect(out.flakySuites).toEqual([{ packageLabel: "server", file: "src/__tests__/a.test.ts" }]);
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

  /**
   * #1242 — what the gate ACTUALLY hands the retry on this repo: vitest 4 prints its failure
   * summary on stderr and `scripts/test-mine.mjs` its package headers on stdout, so in the
   * `stderr + "\n" + stdout` text every FAIL line precedes every header. Header-based attribution
   * labels nothing, and the #894 retry declined every time (every live ledger row before #1230
   * read `source: ci-partialselection-unattributed`).
   */
  describe("vitest-4 output: FAIL lines on stderr AHEAD of the stdout package headers (#1242)", () => {
    const FLAKY = "src/__tests__/session-lifecycle.test.ts";
    const GUARD = "src/__tests__/exports-size-ratchet.test.ts";
    const AMBIGUOUS = "src/__tests__/shared-name.test.ts";
    const STDOUT = `
[test:mine] shared: node vitest run --passWithNoTests --maxWorkers=2
[test:mine] server: node vitest run --passWithNoTests --maxWorkers=2
 Test Files  1 failed | 761 passed (762)
`;
    const stderrFor = (...files: string[]) => files.map((f) => ` FAIL  ${f} > case > times out`).join("\n") + "\n";

    /** A temp worktree whose `packages/` tree holds the suites a run can name. */
    function makeWorktree(): { root: string; cleanup: () => void } {
      const root = mkdtempSync(join(tmpdir(), "ak-vrs-"));
      for (const pkg of ["client", "server", "shared"]) mkdirSync(join(root, "packages", pkg, "src", "__tests__"), { recursive: true });
      writeFileSync(join(root, "packages", "server", FLAKY), "import { it } from 'vitest';\n");
      writeFileSync(join(root, "packages", "server", GUARD), "import { it } from 'vitest';\n");
      writeFileSync(join(root, "packages", "server", AMBIGUOUS), "");
      writeFileSync(join(root, "packages", "client", AMBIGUOUS), "");
      return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }

    // The "synthetic flaky suite in a temp package": the runner is FAKED (the first run fails
    // with the real stderr/stdout shape, the scoped run passes) — spawning vitest in a temp
    // package would be a second, slower copy of the same assertion.
    it("retries exactly the named file once, and the gate note says which and why", async () => {
      const wt = makeWorktree();
      try {
        const h = harness({
          result: { exitCode: 1, stdout: STDOUT, stderr: stderrFor(FLAKY) },
          workingDir: wt.root,
        });
        const out = await resolveVerifyOutcome(h.input);
        expect(out.failure).toBeNull();
        expect(h.calls).toEqual({ verify: 0, scopedVerify: 1, install: 0 });
        expect(h.scopes).toEqual([`server:${FLAKY}`]);
        expect(out.flakySuites).toEqual([{ packageLabel: "server", file: FLAKY }]);
        expect(out.retriedSuites).toEqual([{ packageLabel: "server", file: FLAKY }]);
        expect(out.flakeRetryNote).toMatch(/PASSED on a targeted re-run/);
        expect(out.flakeRetryNote).toMatch(/retried because 1 suite\(s\) failed out of a full run/);
        // The ledger's "what failed here" still carries the parsed, unlabelled entry: attribution
        // for the retry must not erase the runner's own count.
        expect(out.failedSuites).toEqual([{ packageLabel: null, file: FLAKY }]);
      } finally {
        wt.cleanup();
      }
    });

    it("records the retried suites on the confirmed-red path too, and the message says it was retried", async () => {
      const wt = makeWorktree();
      try {
        const h = harness({
          result: { exitCode: 1, stdout: STDOUT, stderr: stderrFor(FLAKY) },
          workingDir: wt.root,
          runVerifyWithRetryScope: async () => ({ exitCode: 1, stdout: STDOUT, stderr: stderrFor(FLAKY) }),
        });
        const out = await resolveVerifyOutcome(h.input);
        expect(out.failure?.message).toMatch(/failed again on a targeted re-run/);
        expect(out.failure?.message).toMatch(/retried because/);
        expect(out.retriedSuites).toEqual([{ packageLabel: "server", file: FLAKY }]);
      } finally {
        wt.cleanup();
      }
    });

    it("does NOT retry a deterministic guard failure (#1230) — and the red message says why not", async () => {
      const wt = makeWorktree();
      try {
        const h = harness({
          result: { exitCode: 1, stdout: STDOUT, stderr: stderrFor(GUARD, FLAKY) },
          workingDir: wt.root,
        });
        const out = await resolveVerifyOutcome(h.input);
        expect(h.calls.scopedVerify).toBe(0);
        expect(out.retriedSuites).toBeUndefined();
        expect(out.failure?.message).toMatch(/no flake retry: 1 of the failing suite\(s\) are deterministic guard/);
        expect(out.failure?.message).toContain(GUARD);
        expect(out.retryReason).toMatch(/deterministic guard/);
      } finally {
        wt.cleanup();
      }
    });

    it("still refuses a suite that exists in two packages rather than guessing", async () => {
      const wt = makeWorktree();
      try {
        const h = harness({
          result: { exitCode: 1, stdout: STDOUT, stderr: stderrFor(AMBIGUOUS) },
          workingDir: wt.root,
        });
        const out = await resolveVerifyOutcome(h.input);
        expect(h.calls.scopedVerify).toBe(0);
        expect(out.failure?.message).toMatch(/no flake retry: 1 failing suite\(s\) could not be attributed/);
      } finally {
        wt.cleanup();
      }
    });

    it("without a workingDir behaves as before #1242: header-only attribution, so it declines", async () => {
      const h = harness({ result: { exitCode: 1, stdout: STDOUT, stderr: stderrFor(FLAKY) } });
      const out = await resolveVerifyOutcome(h.input);
      expect(h.calls.scopedVerify).toBe(0);
      expect(out.failure?.message).toMatch(/could not be attributed/);
    });
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
