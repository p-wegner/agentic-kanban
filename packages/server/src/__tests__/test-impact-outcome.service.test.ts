import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRecordArgs,
  emptyChangeSetReason,
  gateRanScope,
  parseSelection,
  recordGateOutcome,
  recordVerifyGateOutcome,
  IMPACT_TOOL_RELATIVE_PATH,
  OUTCOMES_RELATIVE_PATH,
  type RunImpactCommand,
} from "../services/test-impact-outcome.service.js";
import type { GateTierInfo } from "../services/pre-merge-gate-tier.js";

/**
 * #954 — the gate records each run into the test-impact ledger so the selection heuristic has a
 * MEASURED miss rate instead of a reasoned guess.
 *
 * The two properties worth pinning are the ones that silently produce a useless ledger rather than
 * a visible failure: whether a row correctly says WHAT RAN (only a full-scope run can witness a
 * miss), and whether the recording can ever disturb a gate verdict (it must not, on any path).
 */

const tierInfo = (over: Partial<GateTierInfo> = {}): GateTierInfo => ({
  strategy: "full",
  packageScoped: false,
  fileScoped: false,
  changedFileCount: 3,
  guardSuiteCount: 66,
  maxWorkers: 4,
  ...over,
});

/** A worktree with the skill materialized into it, plus a separate "main checkout". */
function makeRepos(): { worktree: string; main: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ak-ti-outcome-"));
  const worktree = join(root, "worktree");
  const main = join(root, "main");
  mkdirSync(join(worktree, ".claude", "skills", "test-impact", "tools"), { recursive: true });
  mkdirSync(main, { recursive: true });
  writeFileSync(join(worktree, IMPACT_TOOL_RELATIVE_PATH), "// stub\n");
  return { worktree, main, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const selectionJson = (tier: string, tests: string[], changed: string[] = ["packages/server/src/services/x.ts"]) =>
  JSON.stringify({ tier, changed, selected: tests.map((test) => ({ test, score: 1 })) });

/** Records the argv of each spawn, and replies with a scripted stdout per subcommand. */
function fakeRunner(replies: {
  select?: { exitCode?: number; stdout?: string; stderr?: string };
  record?: { exitCode?: number; stdout?: string; stderr?: string };
}): { run: RunImpactCommand; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunImpactCommand = async ({ args }) => {
    calls.push(args);
    const reply = args[1] === "select" ? replies.select : replies.record;
    return {
      exitCode: reply?.exitCode ?? 0,
      stdout: reply?.stdout ?? "",
      stderr: reply?.stderr ?? "",
    };
  };
  return { run, calls };
}

describe("gateRanScope", () => {
  it("reports full when the tier narrowed nothing", () => {
    expect(gateRanScope(tierInfo())).toBe("full");
    // A `scoped` STRATEGY that performed no narrowing is still a full run. Reporting it as
    // scoped would understate the observation and, worse, drop it out of the witness set — the
    // very rows the miss rate is computed from.
    expect(gateRanScope(tierInfo({ strategy: "scoped" }))).toBe("full");
  });

  it("reports the narrowest scope that actually applied", () => {
    expect(gateRanScope(tierInfo({ packageScoped: true }))).toBe("package-scoped");
    expect(gateRanScope(tierInfo({ packageScoped: true, fileScoped: true }))).toBe("file-scoped");
    expect(gateRanScope(tierInfo({ packageScoped: true, fileScoped: true, guardsOnly: true }))).toBe("guards-only");
  });

  it("treats a missing tier info as full rather than inventing a narrower claim", () => {
    expect(gateRanScope(null)).toBe("full");
  });

  it("reports an impact-narrowed run as its OWN scope, never as full (#962)", () => {
    // The worst possible direction of error for the miss rate. `full` asserts that every suite
    // was observed, so any suite the heuristic ranked out would be silently treated as having
    // passed — and `impact.mjs`'s `isWitness` counts `full` rows into the DENOMINATOR, so these
    // rows would drive the rate toward a confident zero precisely on the runs where the selector
    // was actually in charge. That is the number that would promote it to default.
    expect(gateRanScope(tierInfo({ selector: "impact" }))).toBe("impact-scoped");
    // It outranks package/file scoping too: those narrowings are layered ON the impact set, so
    // naming either of them alone would still overstate what ran.
    expect(gateRanScope(tierInfo({ selector: "impact", packageScoped: true, fileScoped: true }))).toBe("impact-scoped");
  });

  it("keeps guards-only ahead of the selector, because that branch never consults it", () => {
    // `test-mine.mjs`'s KANBAN_TEST_GUARDS_ONLY branch runs the guards and exits before the
    // selector is reached, so a docs-only diff genuinely ran no impact selection.
    expect(gateRanScope(tierInfo({ selector: "impact", guardsOnly: true }))).toBe("guards-only");
  });

  it("reads an absent selector as the default, so nothing that has not opted in changes", () => {
    expect(gateRanScope(tierInfo({ selector: undefined }))).toBe("full");
    expect(gateRanScope(tierInfo({ selector: "related", packageScoped: true }))).toBe("package-scoped");
  });
});

describe("buildRecordArgs", () => {
  it("carries the verdict, both scopes and the ledger path", () => {
    const args = buildRecordArgs({
      toolPath: "/w/impact.mjs",
      outcomesPath: "/main/.test-impact/outcomes.jsonl",
      passed: false,
      selected: ["a.test.ts", "b.test.ts"],
      failedSuites: ["c.test.ts"],
      tier: "impact",
      ran: "full",
      source: "ci",
    });
    expect(args[0]).toBe("/w/impact.mjs");
    expect(args[1]).toBe("record");
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("--result")).toBe("fail");
    expect(at("--selected")).toBe("a.test.ts,b.test.ts");
    expect(at("--failed")).toBe("c.test.ts");
    expect(at("--tier")).toBe("impact");
    expect(at("--ran")).toBe("full");
    expect(at("--source")).toBe("ci");
    expect(at("--outcomes")).toBe("/main/.test-impact/outcomes.jsonl");
  });

  it("omits --selected entirely when the selection is empty", () => {
    // `record` reads an empty selection as "no selection recorded" and computes no misses from
    // it. Passing `--selected ""` would instead read as a selection of NOTHING, which makes every
    // failure look like a miss and would poison the exact number this ledger exists to produce.
    const args = buildRecordArgs({
      toolPath: "/w/impact.mjs",
      outcomesPath: "/o.jsonl",
      passed: true,
      selected: [],
      failedSuites: [],
      tier: "impact",
      ran: "full",
      source: "ci",
    });
    expect(args).not.toContain("--selected");
    expect(args).not.toContain("--failed");
    // No base given — the flag is absent rather than empty, so the tool keeps its own default.
    expect(args).not.toContain("--base");
  });

  it("carries --base when one was resolved", () => {
    const args = buildRecordArgs({
      toolPath: "/w/impact.mjs",
      outcomesPath: "/o.jsonl",
      passed: true,
      selected: ["a.test.ts"],
      failedSuites: [],
      tier: "impact",
      ran: "full",
      source: "ci",
      baseBranch: "master",
    });
    expect(args[args.indexOf("--base") + 1]).toBe("master");
  });
});

describe("parseSelection / emptyChangeSetReason", () => {
  it("reads the change set alongside the selection", () => {
    const parsed = parseSelection(selectionJson("impact", ["a.test.ts"], ["src/a.ts", "src/b.ts"]));
    expect(parsed).toMatchObject({ tier: "impact", selected: ["a.test.ts"], changed: ["src/a.ts", "src/b.ts"] });
  });

  it("reads a missing `changed` field as empty rather than assuming a diff was seen", () => {
    // An older `impact.mjs` printed no `changed`. Assuming it saw a diff is the one reading that
    // silently readmits the rows this guard exists to keep out.
    const parsed = parseSelection(JSON.stringify({ tier: "impact", selected: ["a.test.ts"] }));
    expect(parsed!.changed).toEqual([]);
  });

  it("flags an empty change set, and names whether a base was even available", () => {
    expect(emptyChangeSetReason({ changed: ["src/a.ts"], baseBranch: "master" })).toBeNull();
    expect(emptyChangeSetReason({ changed: [], baseBranch: "master" })).toContain("against master");
    expect(emptyChangeSetReason({ changed: [], baseBranch: null })).toContain("no base branch");
  });
});

describe("recordGateOutcome", () => {
  it("records a passing full-scope run against the MAIN checkout's ledger", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts", "b.test.ts"]) } });
      const result = await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
      });

      expect(result).toMatchObject({ recorded: true, tier: "impact", selectedCount: 2, ran: "full" });
      // The selection is computed in the WORKTREE (that is where the branch diff and HEAD are)…
      expect(calls[0]![1]).toBe("select");
      // …but the ledger is the main checkout's, so it survives the worktree's deletion and can
      // actually accumulate the ~50 runs a miss rate needs.
      const recordArgs = calls[1]!;
      expect(recordArgs[recordArgs.indexOf("--outcomes") + 1]).toBe(join(repos.main, OUTCOMES_RELATIVE_PATH));
      expect(recordArgs[recordArgs.indexOf("--result") + 1]).toBe("pass");
    } finally {
      repos.cleanup();
    }
  });

  it("records a failing run with the suites that failed", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts"]) } });
      const result = await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        passed: false,
        failedSuites: ["src/__tests__/z.test.ts"],
        tierInfo: tierInfo(),
        runCommand: run,
      });

      expect(result.recorded).toBe(true);
      const recordArgs = calls[1]!;
      expect(recordArgs[recordArgs.indexOf("--result") + 1]).toBe("fail");
      // This is the row that can carry a MISS: a full-scope run found `z.test.ts` failing while
      // the selection would only have picked `a.test.ts`.
      expect(recordArgs[recordArgs.indexOf("--failed") + 1]).toBe("src/__tests__/z.test.ts");
      expect(recordArgs[recordArgs.indexOf("--ran") + 1]).toBe("full");
    } finally {
      repos.cleanup();
    }
  });

  it("skips silently when the project has no test-impact skill materialized", async () => {
    const root = mkdtempSync(join(tmpdir(), "ak-ti-outcome-bare-"));
    try {
      const { run, calls } = fakeRunner({});
      const result = await recordGateOutcome({
        workingDir: root,
        repoPath: root,
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
      });
      expect(result.recorded).toBe(false);
      expect(result.reason).toContain("no test-impact tool");
      // Nothing spawned at all — the overwhelmingly common case must cost nothing.
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips when there is no worktree to compute a selection from", async () => {
    const result = await recordGateOutcome({
      workingDir: null,
      repoPath: "/main",
      passed: true,
      failedSuites: [],
      tierInfo: tierInfo(),
      runCommand: fakeRunner({}).run,
    });
    expect(result).toMatchObject({ recorded: false });
    expect(result.reason).toContain("no worktree");
  });

  it("reports a missing inventory as a lost measurement, not a failure", async () => {
    const repos = makeRepos();
    try {
      // `select` exits 2 with no inventory and 3 with an empty one.
      const { run } = fakeRunner({ select: { exitCode: 2, stderr: "[test-impact] no inventory at docs/tests/impact-map.json" } });
      const result = await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
      });
      expect(result.recorded).toBe(false);
      expect(result.reason).toContain("select exited 2");
    } finally {
      repos.cleanup();
    }
  });

  it("never throws, whatever the runner does", async () => {
    const repos = makeRepos();
    try {
      // The whole contract of this module: a measurement apparatus that can withhold a merge is
      // worse than no measurement. A runner that rejects must still resolve to a skipped result.
      const result = await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: async () => {
          throw new Error("spawn exploded");
        },
      });
      expect(result.recorded).toBe(false);
      expect(result.reason).toContain("spawn exploded");
    } finally {
      repos.cleanup();
    }
  });

  it("degrades to the worktree ledger, loudly, when the repo path is unknown", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts"]) } });
      const warnings: string[] = [];
      const result = await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: null,
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
        log: (m) => warnings.push(m),
      });
      expect(result.recorded).toBe(true);
      const recordArgs = calls[1]!;
      expect(recordArgs[recordArgs.indexOf("--outcomes") + 1]).toBe(join(repos.worktree, OUTCOMES_RELATIVE_PATH));
      // A row that will be deleted with the worktree still records, but must SAY so — silently
      // writing into a doomed ledger is how a miss rate stays permanently at "no data".
      expect(warnings.join(" ")).toContain("lost with the worktree");
    } finally {
      repos.cleanup();
    }
  });

  it("records failed suites REPO-relative, so they are comparable with the selection", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["packages/server/src/__tests__/a.test.ts"]) } });
      await recordVerifyGateOutcome({
        workspaceId: "ws-1",
        workingDir: repos.worktree,
        repoPath: repos.main,
        // vitest runs with the PACKAGE as cwd, so it names this suite `src/__tests__/z.test.ts`
        // while the inventory — and therefore `select`'s output — keys it under
        // `packages/server/…`. `record` compares the two as plain strings, so recording the
        // package-relative name would make a failure in a SELECTED suite read as a miss, and
        // every failing run would report a 100% miss rate.
        outcome: { failure: { message: "boom" }, failedSuites: [{ packageLabel: "server", file: "src/__tests__/z.test.ts" }] },
        tierInfo: tierInfo(),
        runCommand: run,
      });
      const recordArgs = calls[1]!;
      expect(recordArgs[recordArgs.indexOf("--failed") + 1]).toBe("packages/server/src/__tests__/z.test.ts");
    } finally {
      repos.cleanup();
    }
  });

  it("drops a suite it cannot attribute to a package rather than inventing a phantom miss", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["packages/server/src/__tests__/a.test.ts"]) } });
      await recordVerifyGateOutcome({
        workspaceId: "ws-1",
        workingDir: repos.worktree,
        repoPath: repos.main,
        // The same relative path exists under several packages, so an unattributed suite cannot
        // be placed. A name that can never match the selection is indistinguishable from a real
        // miss, so it must not be recorded at all.
        outcome: { failure: { message: "boom" }, failedSuites: [{ packageLabel: null, file: "src/__tests__/z.test.ts" }] },
        tierInfo: tierInfo(),
        runCommand: run,
      });
      const recordArgs = calls[1]!;
      expect(recordArgs).not.toContain("--failed");
    } finally {
      repos.cleanup();
    }
  });

  it("does not record a timed-out run at all", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts"]) } });
      const result = await recordVerifyGateOutcome({
        workspaceId: "ws-1",
        workingDir: repos.worktree,
        repoPath: repos.main,
        // A wall-clock kill is inconclusive by contract (#192/#903): it never observed the suites
        // after the cut, so it is neither a pass nor evidence the code failed. Recording it either
        // way would put a machine event into a ledger that is supposed to measure the selection.
        outcome: { failure: { timedOut: true, message: "timed out" }, failedSuites: [] },
        tierInfo: tierInfo(),
        runCommand: run,
      });
      expect(result.recorded).toBe(false);
      expect(result.reason).toContain("inconclusive");
      expect(calls).toEqual([]);
    } finally {
      repos.cleanup();
    }
  });

  it("records a pass that only came after a flake retry, with the suites that failed on the way", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts"]) } });
      const result = await recordVerifyGateOutcome({
        workspaceId: "ws-1",
        workingDir: repos.worktree,
        repoPath: repos.main,
        outcome: { failure: null, failedSuites: [{ packageLabel: "server", file: "src/__tests__/flaky.test.ts" }] },
        tierInfo: tierInfo(),
        runCommand: run,
      });
      expect(result.recorded).toBe(true);
      const recordArgs = calls[1]!;
      // The VERDICT was a pass — that is what the gate decided and what the row must say. But the
      // suite did fail on the way there, and keeping that visible is what lets a repeatedly-flaky
      // suite show up as failure history instead of being erased by the retry that cleared it.
      expect(recordArgs[recordArgs.indexOf("--result") + 1]).toBe("pass");
      expect(recordArgs[recordArgs.indexOf("--failed") + 1]).toBe("packages/server/src/__tests__/flaky.test.ts");
    } finally {
      repos.cleanup();
    }
  });

  it("passes the base branch to BOTH select and record, so the change set is the branch's own", async () => {
    // #963 — the whole defect. `impact.mjs`'s `changedFiles(base)` only reads `base...HEAD` when
    // a base is given; its other two sources (staged/unstaged, untracked) are both empty on the
    // clean, fully-committed tree a gate runs against. Without `--base` every gate row recorded
    // `changed: 0` and a selection equal to the constant always-run set.
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts"]) } });
      await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        baseBranch: "master",
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
      });
      const selectArgs = calls[0]!;
      expect(selectArgs[selectArgs.indexOf("--base") + 1]).toBe("master");
      // `record` recomputes the change set itself, so it needs the same base — otherwise the
      // ledger's own `changed` field stays empty even though `select` saw the real diff.
      const recordArgs = calls[1]!;
      expect(recordArgs[recordArgs.indexOf("--base") + 1]).toBe("master");
    } finally {
      repos.cleanup();
    }
  });

  it("omits --base entirely when the workspace has none, rather than passing an empty ref", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts"]) } });
      await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        baseBranch: "   ",
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
      });
      expect(calls[0]!).not.toContain("--base");
      expect(calls[1]!).not.toContain("--base");
    } finally {
      repos.cleanup();
    }
  });

  it("tags a row whose change set came back empty, so it cannot dilute the miss rate", async () => {
    // A gate always runs on a branch with commits against its base, so `changed: []` there does
    // not mean "a diff that touched nothing" — it means the change set was never computed. Such a
    // row records `missed: 0` for free, and 50 of them read as a confident 0% miss rate for a
    // selector that was never consulted. It still RECORDS (a dropped row is indistinguishable
    // from "the gate never ran") but under a distinct source, so `stats --json`'s `bySource`
    // separates it.
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts"], []) } });
      const warnings: string[] = [];
      const result = await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        baseBranch: "master",
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
        log: (m) => warnings.push(m),
      });
      expect(result.recorded).toBe(true);
      expect(result.changedCount).toBe(0);
      expect(result.suspectReason).toContain("empty");
      const recordArgs = calls[1]!;
      expect(recordArgs[recordArgs.indexOf("--source") + 1]).toBe("ci-nochange");
      expect(warnings.join(" ")).toContain("always-run baseline");
    } finally {
      repos.cleanup();
    }
  });

  it("records a real change set under the plain source", async () => {
    const repos = makeRepos();
    try {
      const { run, calls } = fakeRunner({ select: { stdout: selectionJson("impact", ["a.test.ts"]) } });
      const result = await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        baseBranch: "master",
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
      });
      expect(result.suspectReason).toBeUndefined();
      expect(result.changedCount).toBe(1);
      const recordArgs = calls[1]!;
      expect(recordArgs[recordArgs.indexOf("--source") + 1]).toBe("ci");
    } finally {
      repos.cleanup();
    }
  });

  it("tolerates unparseable select output instead of throwing inside the merge path", async () => {
    const repos = makeRepos();
    try {
      const { run } = fakeRunner({ select: { stdout: "not json at all" } });
      const result = await recordGateOutcome({
        workingDir: repos.worktree,
        repoPath: repos.main,
        passed: true,
        failedSuites: [],
        tierInfo: tierInfo(),
        runCommand: run,
      });
      expect(result.recorded).toBe(false);
      expect(result.reason).toContain("could not parse");
    } finally {
      repos.cleanup();
    }
  });
});
