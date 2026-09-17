import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import type { MergeTrainAttemptDto } from "@agentic-kanban/shared/types";
import { runMergeTrain } from "../services/merge-train.service.js";

/**
 * #1189 — every `runTrainAttempt` is one node of a bisect tree, recorded in the result AND
 * handed to `onAttempt` as it finishes, so a live train exposes partial progress instead of a
 * flat `gateRejected` list after the fact. Real git underneath: the tree's `included`/`dropped`
 * per node come from real assembly.
 */
let repo: string;
const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });

async function commitOn(branch: string, file: string, content: string) {
  await git(["checkout", "-q", branch]);
  writeFileSync(join(repo, file), content, "utf8");
  await git(["add", file]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${file}`]);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-attempts-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
  // Every branch forks from MAIN — `git branch` with no start point forks from the checked-out
  // HEAD, which after `commitOn` is the previous feature branch, and f4 would carry f3's file.
  for (const n of [1, 2, 3, 4]) {
    await git(["branch", `f${n}`, "main"]);
    await commitOn(`f${n}`, `f${n}.txt`, `${n}\n`);
  }
  await git(["checkout", "-q", "main"]);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

const members = [1, 2, 3, 4].map((n) => ({ workspaceId: `w${n}`, branch: `f${n}`, issueNumber: n }));

/** A gate that is red exactly when the assembled tree contains `badFile`. */
function gateFailingFor(badFile: string, log: string[]) {
  return vi.fn(async ({ trainRef }: { trainRef: string }) => {
    log.push(`gate:${trainRef}`);
    const tree = await gitExecOrThrow(["ls-tree", "-r", "--name-only", trainRef], { cwd: repo });
    return tree.split(/\r?\n/).includes(badFile)
      ? { passed: false, message: `verify failed: ${badFile} is red\nsecond line of output` }
      : { passed: true, message: "ok" };
  });
}

describe("runMergeTrain — attempts form a bisect tree (#1189)", () => {
  it("a red batch of 4 with one bad member records root, both halves and the two leaves under the red half", async () => {
    const log: string[] = [];
    const seen: MergeTrainAttemptDto[] = [];
    const runGate = gateFailingFor("f3.txt", log);

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members,
      label: "t",
      runGate,
      closeMember: vi.fn().mockResolvedValue(undefined),
      onAttempt: async (attempt) => {
        log.push(`attempt:${attempt.label}:${attempt.verdict}`);
        seen.push(attempt);
      },
    });

    // The tree, in finish order: root (red) → first half lands → second half red → its leaves.
    expect(result.attempts.map((a) => [a.label, a.verdict])).toEqual([
      ["t", "red"],
      ["ta", "landed"],
      ["tb", "red"],
      ["tba", "red"],
      ["tbb", "landed"],
    ]);
    // Node contents: member sets halve, everything assembled (no conflicts in this fixture).
    const byLabel = Object.fromEntries(result.attempts.map((a) => [a.label, a]));
    expect(byLabel.t.members).toEqual(["w1", "w2", "w3", "w4"]);
    expect(byLabel.t.included).toEqual(["w1", "w2", "w3", "w4"]);
    expect(byLabel.t.dropped).toEqual([]);
    expect(byLabel.ta.members).toEqual(["w1", "w2"]);
    expect(byLabel.tb.members).toEqual(["w3", "w4"]);
    expect(byLabel.tba.members).toEqual(["w3"]);
    expect(byLabel.tbb.members).toEqual(["w4"]);
    // Verdict detail: a red node carries the failure head, a landed node its merge sha.
    expect(byLabel.tba.failureHead).toContain("f3.txt is red");
    expect(byLabel.tba.mergeSha).toBeUndefined();
    expect(byLabel.tbb.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(byLabel.ta.failureHead).toBeUndefined();
    // Every node gated exactly once, and the tree's sum IS the train's gate count.
    for (const a of result.attempts) {
      expect(a.gateRuns).toBe(1);
      expect(a.gateStartedAt).toMatch(/^\d{4}-/);
      expect(a.gateFinishedAt).toMatch(/^\d{4}-/);
      expect(Date.parse(a.gateFinishedAt!)).toBeGreaterThanOrEqual(Date.parse(a.gateStartedAt!));
    }
    expect(result.attempts.reduce((n, a) => n + a.gateRuns, 0)).toBe(result.gateRuns);
    expect(result.gateRuns).toBe(5);

    // `onAttempt` received the same nodes, and each one BEFORE the next gate ran — that is what
    // makes the tree live rather than a post-mortem.
    expect(seen).toEqual(result.attempts);
    const rootRecorded = log.indexOf("attempt:t:red");
    const secondGate = log.findIndex((l, i) => l.startsWith("gate:") && i > log.indexOf("gate:kanban/train/t"));
    expect(rootRecorded).toBeGreaterThan(-1);
    expect(rootRecorded).toBeLessThan(secondGate);

    // And the outcome itself is unchanged by the bookkeeping.
    expect(result.landed.map((m) => m.workspaceId).sort()).toEqual(["w1", "w2", "w4"]);
    expect(result.gateRejected.map((r) => r.member.workspaceId)).toEqual(["w3"]);
  }, 240000);

  it("an environment failure records ONE node with its own verdict and no split (#1154)", async () => {
    const onAttempt = vi.fn().mockResolvedValue(undefined);
    const runGate = vi.fn().mockResolvedValue({ passed: false, message: "Cannot find module '@playwright/test'" });

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members,
      label: "env",
      runGate,
      closeMember: vi.fn(),
      isEnvironmentFailure: (message) => /cannot find module/i.test(message),
      onAttempt,
    });

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      label: "env",
      verdict: "env_failure",
      gateRuns: 1,
      members: ["w1", "w2", "w3", "w4"],
      included: ["w1", "w2", "w3", "w4"],
      failureHead: "Cannot find module '@playwright/test'",
    });
    expect(onAttempt).toHaveBeenCalledTimes(1);
    // Nobody is blamed — the leaf is the train's, not a member's.
    expect(result.gateRejected).toEqual([]);
  }, 240000);

  it("an assembly-empty attempt is a node with no gate timestamps, and a refused landing is its own verdict (#1181)", async () => {
    // f-conflict edits a file main also changes after branching, so it conflicts with the base.
    await git(["branch", "f-conflict"]);
    await commitOn("f-conflict", "shared.txt", "branch\n");
    await commitOn("main", "shared.txt", "main\n");
    await git(["checkout", "-q", "main"]);

    const empty = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "wc", branch: "f-conflict" }],
      label: "empty",
      runGate: vi.fn(),
      closeMember: vi.fn(),
    });
    expect(empty.attempts).toHaveLength(1);
    expect(empty.attempts[0]).toMatchObject({ verdict: "assembly_empty", gateRuns: 0, gateStartedAt: null, gateFinishedAt: null, included: [] });
    expect(empty.attempts[0].dropped.map((d) => d.workspaceId)).toEqual(["wc"]);

    const refused = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: members.slice(0, 2),
      label: "veto",
      runGate: vi.fn().mockResolvedValue({ passed: true, message: "ok" }),
      closeMember: vi.fn(),
      shouldLand: async () => "row abandoned mid-gate",
    });
    expect(refused.attempts.map((a) => a.verdict)).toEqual(["land_refused"]);
    expect(refused.attempts[0].failureHead).toBe("row abandoned mid-gate");
  }, 240000);

  it("a failing onAttempt is logged and never fails the train", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runMergeTrain({
        repoPath: repo,
        baseBranch: "main",
        members: members.slice(0, 2),
        label: "boom",
        runGate: vi.fn().mockResolvedValue({ passed: true, message: "ok" }),
        closeMember: vi.fn().mockResolvedValue(undefined),
        onAttempt: async () => { throw new Error("db is away"); },
      });
      expect(result.landed).toHaveLength(2);
      expect(result.attempts.map((a) => a.verdict)).toEqual(["landed"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record attempt boom"));
    } finally {
      warn.mockRestore();
    }
  }, 240000);
});
