import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { classifyInfraRed, findGuardEdits, isGuardTestPath } from "../services/merge-train-verdict.js";
import { isInconclusiveGate } from "../services/merge-queue-train-inconclusive.js";
import { decideRegate, TARGETED_REGATE_MAX_SCRIPT_CHARS } from "../services/merge-train-targeted-regate.js";
import { runAgentFix } from "../services/merge-train-agent-fix.js";

/** #1772 - the four verdict-side rules. */
describe("verdict classifier", () => {
  const suites = (n: number) => Array.from({ length: n }, (_, i) => `packages/server/src/__tests__/s${i}.test.ts`);

  it("a SQLITE_FULL / ENOSPC signature is infra, whatever the suite count", () => {
    expect(classifyInfraRed({ passed: false, message: "SQLITE_FULL: database or disk is full", failedSuites: suites(2) })).toMatch(/SQLITE_FULL/);
    expect(classifyInfraRed({ passed: false, message: "write ENOSPC", failedSuites: suites(1) })).toMatch(/ENOSPC/);
  });

  it("> 50% of the scoped suites failing is infra; a small real red is not", () => {
    expect(classifyInfraRed({ passed: false, message: "FAIL x", failedSuites: suites(689) }, 900)).toMatch(/689 of 900/);
    expect(classifyInfraRed({ passed: false, message: "FAIL x", failedSuites: suites(3) }, 4)).toBeNull();
    expect(classifyInfraRed({ passed: false, message: "FAIL x", failedSuites: suites(30) }, 1000)).toBeNull();
  });

  it("feeds isInconclusiveGate: no shepherd for an infra red, a plain red stays red", () => {
    expect(isInconclusiveGate({ passed: false, message: "SQLITE_FULL", failedSuites: suites(3) })).toBe(true);
    expect(isInconclusiveGate({ passed: false, message: "FAIL a.test.ts", failedSuites: ["a.test.ts"] })).toBe(false);
    expect(isInconclusiveGate({ passed: true, message: "SQLITE_FULL" })).toBe(false);
    expect(isInconclusiveGate({ passed: false, timedOut: true })).toBe(true);
  });
});

describe("zero-suite red", () => {
  it("failed with 0 failing suites and no recognisable failure is inconclusive", () => {
    const message = "$ pnpm install -r\nDie Befehlszeile ist zu lang.";
    expect(classifyInfraRed({ passed: false, message, failedSuites: [] })).not.toBeNull();
    expect(isInconclusiveGate({ passed: false, message, failedSuites: [] })).toBe(true);
    expect(isInconclusiveGate({ passed: false, message: "no output at all" })).toBe(true);
  });

  it("a zero-suite red that names a real check failure stays red", () => {
    expect(isInconclusiveGate({ passed: false, message: "src/a.ts(3,1): error TS2322: nope", failedSuites: [] })).toBe(false);
  });
});

describe("targeted re-gate arg transport", () => {
  const base = { fixFiles: ["packages/server/src/a.ts"], coveredFiles: ["packages/server/src/b.ts"], gatedSha: "abc1234", fixSha: "def5678" };

  it("689 failing suites never reach the command line: full gate", () => {
    const failedSuites = Array.from({ length: 689 }, (_, i) => `packages/server/src/__tests__/s${i}.test.ts`);
    const d = decideRegate({ ...base, failedSuites });
    expect(d.mode).toBe("full");
    expect(d.mode === "full" && d.reason).toMatch(/689 failing suites/);
  });

  it("a small list stays targeted and under the cmd.exe limit", () => {
    const d = decideRegate({ ...base, failedSuites: ["packages/server/src/__tests__/s1.test.ts"] });
    expect(d.mode).toBe("targeted");
    expect(d.mode === "targeted" && d.script.length).toBeLessThan(TARGETED_REGATE_MAX_SCRIPT_CHARS);
  });

  it("a long-path list under the count bound still falls back when the script is too long", () => {
    const long = (i: number) => `packages/server/src/__tests__/${"deep-directory-name/".repeat(8)}suite-${i}.test.ts`;
    const d = decideRegate({ ...base, failedSuites: Array.from({ length: 40 }, (_, i) => long(i)) });
    expect(d.mode).toBe("full");
  });
});

describe("shepherd guard-edit refusal", () => {
  it("matches ratchet tests and @gate:always-run suites, not ordinary tests", () => {
    expect(isGuardTestPath("packages/shared/__tests__/some-ratchet.test.ts")).toBe(true);
    expect(isGuardTestPath("packages/server/src/__tests__/plain.test.ts")).toBe(false);
    expect(isGuardTestPath("packages/server/src/__tests__/plain.test.ts", "// @gate:always-run\nit()")).toBe(true);
    expect(findGuardEdits(["a.ts", "x/__tests__/foo-ratchet.test.ts"])).toEqual(["x/__tests__/foo-ratchet.test.ts"]);
  });

  describe("runAgentFix", () => {
    let repo: string;
    const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });
    beforeEach(async () => {
      repo = mkdtempSync(join(tmpdir(), "kanban-train-guard-"));
      await git(["init", "-q", "-b", "main"]);
      writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
      await git(["add", "."]);
      await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"]);
    });
    afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

    const run = (file: string) => {
      const regate = vi.fn(async () => ({ passed: true, message: "" }));
      return {
        regate,
        out: runAgentFix({
          worktree: repo, label: "train/x", baseBranch: "main", members: [{ workspaceId: "w1", branch: "f1" }],
          initialFailure: { message: "FAIL", failedSuites: ["a.test.ts"] }, caps: { maxTurns: 1, timeoutMs: 60_000, costCapUsd: 2 }, regate,
          runAgent: async ({ worktree }) => {
            mkdirSync(join(worktree, "__tests__"), { recursive: true });
            writeFileSync(join(worktree, file), "x\n", "utf8");
            return { sessionId: "s" };
          },
        }),
      };
    };

    it("an edited ratchet fails the attempt with 'shepherd edited a guard' and never re-gates", async () => {
      const { out, regate } = run("__tests__/widen-ratchet.test.ts");
      const res = await out;
      expect(res.attempt.verdict).toBe("agent_fix_red");
      expect(res.attempt.failureHead).toMatch(/shepherd edited a guard/);
      expect(res.fixedTrainSha).toBeUndefined();
      expect(regate).not.toHaveBeenCalled();
    });

    it("an ordinary edit is re-gated as before", async () => {
      const { out, regate } = run("fix.txt");
      const res = await out;
      expect(res.attempt.verdict).toBe("agent_fix_green");
      expect(regate).toHaveBeenCalledTimes(1);
    });
  });
});
