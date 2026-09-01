import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceProvisionService } from "../services/workspace-provision.service.js";
import type { Database } from "../db/index.js";
import type { GitService } from "../services/workspace-internals.js";

/**
 * #976 — the `commit-msg` hook every worktree now gets.
 *
 * Two jobs in the one hook git allows per repository: strip a leading UTF-8 BOM (always), and
 * the TDD AC-test gate (only when the workspace asked for it). Before this, the hook existed
 * ONLY in TDD mode, so the overwhelming majority of builder worktrees had none — which is why
 * 77 commits carry `EF BB BF` in their subject.
 *
 * The BOM half is asserted by RUNNING the script, not by matching its text: the whole failure
 * mode here is bytes that no rendered view shows, so a substring assertion could pass on a hook
 * that does nothing.
 */
const tempDirs: string[] = [];

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-commit-msg-hook-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

function install(worktree: string, tddMode: boolean): string {
  const provision = createWorkspaceProvisionService({
    database: {} as unknown as Database,
    gitService: {} as GitService,
  });
  provision.installCommitMsgHook(worktree, { tddMode });
  return join(worktree, ".git", "hooks", "commit-msg");
}

/** Run the hook the way git does — `sh <hook> <message-file>` — and return the resulting bytes. */
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("#976: the commit-msg hook strips a UTF-8 BOM", () => {
  it("is installed for a NON-TDD worktree too — the case that produced all 77 BOM commits", () => {
    const worktree = makeWorktree();
    const hookPath = install(worktree, false);
    expect(existsSync(hookPath)).toBe(true);
  });

  it("removes the BOM and leaves the rest of the message byte-identical", () => {
    const worktree = makeWorktree();
    const hookPath = install(worktree, false);
    const body = Buffer.from("feat(#976): subject\n\nbody line\n", "utf8");

    const { message, exitCode } = runHook(hookPath, Buffer.concat([BOM, body]));

    expect(exitCode).toBe(0);
    expect(message.equals(body)).toBe(true);
  });

  it("leaves a message WITHOUT a BOM untouched", () => {
    const worktree = makeWorktree();
    const hookPath = install(worktree, false);
    const body = Buffer.from("fix(#976): already clean\n", "utf8");

    const { message, exitCode } = runHook(hookPath, body);

    expect(exitCode).toBe(0);
    expect(message.equals(body)).toBe(true);
  });

  it("keeps the TDD gate when TDD mode is on, and still strips the BOM first", () => {
    const worktree = makeWorktree();
    const hookPath = install(worktree, true);
    const body = Buffer.from("test: AC for #976\n", "utf8");

    const { message, exitCode } = runHook(hookPath, Buffer.concat([BOM, body]));

    // The AC-test subject is what the gate allows — and it only matches once the BOM is gone,
    // which is the ordering this asserts: a BOM ahead of `test:` would fail the `^test:` anchor.
    expect(exitCode).toBe(0);
    expect(message.equals(body)).toBe(true);
  });

  it("a NON-TDD hook accepts any subject — it is a stripper, not a gate", () => {
    const worktree = makeWorktree();
    const hookPath = install(worktree, false);

    const { exitCode } = runHook(hookPath, Buffer.from("chore: whatever\n", "utf8"));

    expect(exitCode).toBe(0);
  });
});
