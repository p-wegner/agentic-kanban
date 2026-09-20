import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { installCommitMsgHook, buildCommitMsgHookScript } from "../services/workspace-provision.service.js";

/**
 * #976 — the `commit-msg` hook every worktree now gets — and #1214, which is the reason it
 * ever RUNS in one.
 *
 * Two jobs in the one hook git allows per repository: strip a leading UTF-8 BOM (always), and
 * the TDD AC-test gate (only when the workspace asked for it).
 *
 * Both halves are asserted by RUNNING git, not by matching the script's text: #976 passed its
 * own suite for months against a fixture whose `.git` was a plain directory, while in a REAL
 * linked worktree `.git` is a file, the install threw into a swallowed catch, and not one
 * builder commit was ever checked. A substring assertion cannot tell those apart; a commit can.
 */
const tempDirs: string[] = [];
const IDENTITY = ["-c", "user.name=Hook Test", "-c", "user.email=hook@test.invalid"];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A real repository with one commit — the only fixture that can prove anything here. */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ak-commit-msg-hook-"));
  tempDirs.push(dir);
  await gitExec(["init", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await gitExec(["add", "seed.txt"], { cwd: dir });
  await gitExec([...IDENTITY, "commit", "-m", "seed"], { cwd: dir });
  return dir;
}

/** A linked worktree of `repo` — where `.git` is a FILE and hooks resolve from the common dir. */
async function addWorktree(repo: string, name: string): Promise<string> {
  const path = join(repo, "..", `${name}-${Date.now()}`);
  tempDirs.push(path);
  const res = await gitExec(["worktree", "add", "-b", name, path], { cwd: repo });
  expect(res.code, res.stderr).toBe(0);
  return path;
}

/** Commit through git itself, with the raw message bytes the hook is supposed to fix. */
async function commitBytes(cwd: string, bytes: Buffer): Promise<{ code: number | null; subject: string }> {
  const msgPath = join(cwd, "msg.txt");
  writeFileSync(msgPath, bytes);
  writeFileSync(join(cwd, `file-${Math.random().toString(36).slice(2)}.txt`), "x\n");
  await gitExec(["add", "-A"], { cwd });
  const commit = await gitExec([...IDENTITY, "commit", "-F", msgPath], { cwd });
  const subject = await gitExec(["log", "-1", "--format=%s"], { cwd });
  return { code: commit.code, subject: subject.stdout.replace(/\r?\n$/, "") };
}

/** Run the hook script the way git does — `sh <hook> <message-file>`. */
function runHook(hookPath: string, messageBytes: Buffer): { message: Buffer; exitCode: number } {
  const msgPath = `${hookPath}.msg`;
  writeFileSync(msgPath, messageBytes);
  let exitCode = 0;
  try {
    execFileSync("sh", [hookPath, msgPath], { encoding: "utf8", windowsHide: true });
  } catch (err) {
    exitCode = (err as { status?: number }).status ?? 1;
  }
  return { message: readFileSync(msgPath), exitCode };
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe("#1214: the hook is installed where git runs it FOR THAT WORKTREE", () => {
  it("points a linked worktree's core.hooksPath at an existing commit-msg", async () => {
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, "wt-hooks-path");

    const result = await installCommitMsgHook(worktree, { tddMode: false });

    expect(result.reason).toBeUndefined();
    expect(result.installed).toBe(true);
    const configured = await gitExec(["config", "--worktree", "--get", "core.hooksPath"], { cwd: worktree });
    expect(configured.code).toBe(0);
    const hooksDir = configured.stdout.trim();
    expect(hooksDir).not.toBe("");
    expect(existsSync(join(resolve(worktree, hooksDir), "commit-msg"))).toBe(true);
  });

  it("strips the BOM from a REAL commit made in that worktree — the #1205 failure", async () => {
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, "wt-bom");
    await installCommitMsgHook(worktree, { tddMode: false });

    const { code, subject } = await commitBytes(
      worktree,
      Buffer.concat([BOM, Buffer.from("fix(#1214): subject\n\nbody\n", "utf8")]),
    );

    expect(code).toBe(0);
    expect(Buffer.from(subject, "utf8").subarray(0, 3).equals(BOM)).toBe(false);
    expect(subject).toBe("fix(#1214): subject");
  });

  it("is idempotent — a second install leaves one usable hook and one hooksPath", async () => {
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, "wt-idempotent");

    const first = await installCommitMsgHook(worktree, { tddMode: false });
    const second = await installCommitMsgHook(worktree, { tddMode: false });

    expect(second.installed).toBe(true);
    expect(second.path).toBe(first.path);
    const configured = await gitExec(["config", "--worktree", "--get-all", "core.hooksPath"], { cwd: worktree });
    expect(configured.stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
  });

  it("writes the TDD-gate variant when the workspace asked for it, scoped to that worktree", async () => {
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, "wt-tdd");

    const result = await installCommitMsgHook(worktree, { tddMode: true });

    expect(result.installed).toBe(true);
    expect(readFileSync(result.path, "utf-8")).toContain("TDD mode: write failing AC tests first.");
    // A commit that is neither the AC test nor preceded by one is what the gate exists to refuse.
    const { code } = await commitBytes(worktree, Buffer.from("feat(#1214): implementation first\n", "utf8"));
    expect(code).not.toBe(0);
  });

  it("leaves the MAIN checkout on its own .git/hooks, with no core.hooksPath (unchanged behaviour)", async () => {
    const repo = await makeRepo();

    const result = await installCommitMsgHook(repo, { tddMode: false });

    expect(result.installed).toBe(true);
    expect(result.path).toBe(join(repo, ".git", "hooks", "commit-msg"));
    const configured = await gitExec(["config", "--get", "core.hooksPath"], { cwd: repo });
    expect(configured.stdout.trim()).toBe("");
    const { code, subject } = await commitBytes(repo, Buffer.concat([BOM, Buffer.from("chore: main checkout\n", "utf8")]));
    expect(code).toBe(0);
    expect(subject).toBe("chore: main checkout");
  });

  it("reports a reason instead of throwing when the path is not a git worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-commit-msg-hook-nonrepo-"));
    tempDirs.push(dir);

    const result = await installCommitMsgHook(dir, { tddMode: false });

    expect(result.installed).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("#976: the hook script itself strips a UTF-8 BOM", () => {
  it("is written with an LF shebang, which a CRLF one would not be", () => {
    const script = buildCommitMsgHookScript({ tddMode: false });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).not.toContain("\r\n");
  });

  it("removes the BOM and leaves the rest of the message byte-identical", async () => {
    const repo = await makeRepo();
    const { path: hookPath } = await installCommitMsgHook(repo, { tddMode: false });
    const body = Buffer.from("feat(#976): subject\n\nbody line\n", "utf8");

    const { message, exitCode } = runHook(hookPath, Buffer.concat([BOM, body]));

    expect(exitCode).toBe(0);
    expect(message.equals(body)).toBe(true);
  });

  it("leaves a message WITHOUT a BOM untouched", async () => {
    const repo = await makeRepo();
    const { path: hookPath } = await installCommitMsgHook(repo, { tddMode: false });
    const body = Buffer.from("fix(#976): already clean\n", "utf8");

    const { message, exitCode } = runHook(hookPath, body);

    expect(exitCode).toBe(0);
    expect(message.equals(body)).toBe(true);
  });

  it("a NON-TDD hook accepts any subject — it is a stripper, not a gate", async () => {
    const repo = await makeRepo();
    const { path: hookPath } = await installCommitMsgHook(repo, { tddMode: false });

    const { exitCode } = runHook(hookPath, Buffer.from("chore: whatever\n", "utf8"));

    expect(exitCode).toBe(0);
  });
});
