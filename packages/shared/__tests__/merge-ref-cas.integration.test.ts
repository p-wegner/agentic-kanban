/**
 * Regression test for ticket #980: compare-and-swap on the plumbing merge's
 * `git update-ref` target-branch advance.
 *
 * `mergeBranch` reads the target tip once (rev-parse), computes the merge with
 * plumbing (merge-tree / commit-tree), then advances the ref. Without the CAS
 * <expected-old> argument to `git update-ref`, an external commit landing on the
 * target branch inside that window was silently ORPHANED — the historical
 * "silent merge loss" class. The fix passes the previously-read tip as
 * update-ref's third argument; on CAS failure git refuses the update and
 * mergeBranch throws a typed, retryable `RefAdvanceRaceError`.
 *
 * Determinism: the test wraps the sanctioned git adapter (`git-exec.ts`) via
 * vi.mock, DELEGATING every call to the real implementation, and fires the
 * external commit right before the first `commit-tree` call — i.e. after the
 * target tip was read, before the ref advance. No new production spawn sites.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const raceState = vi.hoisted(() => ({
  beforeCommitTree: null as (() => Promise<void>) | null,
}));

vi.mock("../src/lib/git-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/git-exec.js")>();
  const fireHook = async (args: string[]) => {
    if (args[0] === "commit-tree" && raceState.beforeCommitTree) {
      const hook = raceState.beforeCommitTree;
      raceState.beforeCommitTree = null; // fire once
      await hook();
    }
  };
  return {
    ...actual,
    gitExec: async (args: string[], opts?: Parameters<typeof actual.gitExec>[1]) => {
      await fireHook(args);
      return actual.gitExec(args, opts ?? {});
    },
    gitExecOrThrow: async (args: string[], opts: Parameters<typeof actual.gitExecOrThrow>[1]) => {
      await fireHook(args);
      return actual.gitExecOrThrow(args, opts);
    },
  };
});

// Import AFTER the mock so merge.ts picks up the wrapped adapter.
import { mergeBranch, RefAdvanceRaceError } from "../src/lib/git-service.js";

/** Test-local raw git helper (test files are excluded from the single-spawn gate). */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

let repo: string;

async function writeRepoFile(relativePath: string, content: string): Promise<void> {
  const filePath = join(repo, ...relativePath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function revParse(ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", ref])).trim();
}

/**
 * Land an external commit on `main` WITHOUT touching the checked-out branch:
 * empty-tree-change commit via commit-tree + update-ref (main is not checked out).
 */
async function commitExternallyToMain(): Promise<string> {
  const tree = (await git(repo, ["rev-parse", "main^{tree}"])).trim();
  const parent = (await git(repo, ["rev-parse", "main"])).trim();
  const sha = (await git(repo, [
    "commit-tree", tree, "-p", parent, "-m", "external commit landed mid-merge",
  ])).trim();
  await git(repo, ["update-ref", "refs/heads/main", sha]);
  return sha;
}

// Git subprocess churn is slow on Windows — give every test generous headroom.
describe("#980 update-ref compare-and-swap on the plumbing merge", { timeout: 120_000 }, () => {
  beforeEach(async () => {
    raceState.beforeCommitTree = null;
    repo = await mkdtemp(join(tmpdir(), "ak-980-"));
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@t.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await writeRepoFile("src/index.js", "export const x = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "seed"]);
    await git(repo, ["branch", "-M", "main"]).catch(() => {});
    // Feature branch with its own file; leave it checked out so main is a bare ref
    // (external commits to main need no working-tree gymnastics).
    await git(repo, ["checkout", "-b", "feature/ak-980"]);
    await writeRepoFile("src/feature.js", "export const feature = true;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "feature work"]);
  });

  afterEach(async () => {
    raceState.beforeCommitTree = null;
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it("fails loudly with RefAdvanceRaceError when an external commit lands mid-merge, without orphaning it", async () => {
    let externalSha = "";
    raceState.beforeCommitTree = async () => {
      externalSha = await commitExternallyToMain();
    };

    let caught: unknown;
    try {
      await mergeBranch(repo, "feature/ak-980", "main");
    } catch (err) {
      caught = err;
    }

    // Loud, typed, retryable — never a silent success.
    expect(caught).toBeInstanceOf(RefAdvanceRaceError);
    const raceErr = caught as RefAdvanceRaceError;
    expect(raceErr.name).toBe("RefAdvanceRaceError");
    expect(raceErr.retryable).toBe(true);
    expect(raceErr.targetBranch).toBe("main");
    // CRLF-tolerant keyword assertions, not exact strings.
    expect(raceErr.message).toContain("moved during the merge");
    expect(raceErr.message).toContain("main");
    expect(raceErr.actualSha).toBe(externalSha);

    // The external commit is still the branch tip — NOT orphaned by the merge.
    expect(externalSha).not.toBe("");
    expect(await revParse("main")).toBe(externalSha);
  });

  it("retrying after the race lands both the external commit and the feature", async () => {
    raceState.beforeCommitTree = async () => {
      await commitExternallyToMain();
    };
    await expect(mergeBranch(repo, "feature/ak-980", "main")).rejects.toBeInstanceOf(RefAdvanceRaceError);

    const externalTip = await revParse("main");
    const result = await mergeBranch(repo, "feature/ak-980", "main");
    expect(result).toContain("plumbing-merge");

    // The new merge commit descends from BOTH the external commit and the feature.
    await git(repo, ["merge-base", "--is-ancestor", externalTip, "main"]);
    await git(repo, ["merge-base", "--is-ancestor", "feature/ak-980", "main"]);
  });

  it("still merges cleanly when no external commit races the ref advance", async () => {
    const featureSha = await revParse("feature/ak-980");
    const result = await mergeBranch(repo, "feature/ak-980", "main");
    expect(result).toContain("plumbing-merge");
    await git(repo, ["merge-base", "--is-ancestor", featureSha, "main"]);
  });

  it("applies the CAS on the append-only auto-resolve advance path too", async () => {
    // Build an append-only conflict on a shared hot file (the #763 shape).
    const HOT = "test/smoke.test.js";
    await git(repo, ["checkout", "main"]);
    await writeRepoFile(HOT, "// smoke tests\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "seed hot file"]);
    await git(repo, ["checkout", "-b", "feature/append-a"]);
    await writeRepoFile(HOT, "// smoke tests\ntest('a', () => {});\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "append a"]);
    await git(repo, ["checkout", "main"]);
    await writeRepoFile(HOT, "// smoke tests\ntest('main', () => {});\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "append on main"]);
    // Park HEAD elsewhere so main is a bare ref again.
    await git(repo, ["checkout", "feature/ak-980"]);

    raceState.beforeCommitTree = async () => {
      await commitExternallyToMain();
    };

    let caught: unknown;
    try {
      await mergeBranch(repo, "feature/append-a", "main", { autoResolveAppendConflicts: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RefAdvanceRaceError);
    expect((caught as Error).message).toContain("moved during the merge");
  });
});
