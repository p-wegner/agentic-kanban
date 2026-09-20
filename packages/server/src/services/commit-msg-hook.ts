/**
 * The worktree `commit-msg` hook: BOM-stripping backstop + the optional TDD gate.
 *
 * Split out of `workspace-provision.service.ts` (#1214 follow-up) purely to keep that file
 * under the god-module ceiling — this is a self-contained unit (build the script, install it,
 * report the verdict) with exactly two external callers: `workspace-create.service.ts` at
 * provisioning time and `startup/commit-msg-hook-backfill.ts`'s sweep for worktrees that
 * predate #1214. Nothing here depends on `createWorkspaceProvisionService`'s closure.
 */

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve as resolvePath, join, sep } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded, execErrorMessage } from "@agentic-kanban/shared/lib/exec-result";

/**
 * Install the worktree's `commit-msg` hook.
 *
 * TWO jobs in ONE hook, because git allows exactly one `commit-msg` per repository and the TDD
 * gate already owned the file:
 *
 * 1. **Strip a leading UTF-8 BOM from the subject (#976).** 77 of this repo's commits carry
 *    `EF BB BF` as the first bytes of the SUBJECT, and the rate is accelerating (1 in May, 53 in
 *    August) as more work goes through builders. The cause is an agent writing the message with
 *    a bare PowerShell redirect — PS 5.1's `Set-Content`/`Out-File` default to UTF-8 WITH BOM —
 *    and `git commit -F` does not strip it. It is invisible in every normal view, so nobody
 *    catches it in review, while anything that PATTERN-MATCHES a subject sees `﻿feat(#951)`
 *    instead of `feat(#951)` — including this board's own `ak-<N>` history matching in the
 *    hand-merged-branch reconciler and `checkAlreadyMerged`.
 *
 *    It STRIPS rather than rejects: the message is already correct in intent, and failing the
 *    commit would cost a builder a turn over a byte it cannot see. Documentation (the ticket
 *    context and the root CLAUDE.md) is the prevention half; this is the backstop.
 *
 * 2. **The TDD gate**, only when the workspace asked for it — unchanged behaviour.
 */
export function buildCommitMsgHookScript(opts: { tddMode: boolean }): string {
  // `sed -i` is avoided: Git for Windows' sed rewrites the file in place with a temp rename
  // that trips on the .git directory's permissions often enough to be a real flake source.
  const bomStrip = `#!/bin/sh
# #976 - strip a leading UTF-8 BOM from the commit message. A bare PowerShell redirect writes
# one, \`git commit -F\` keeps it, and it is invisible in every normal view.
if [ -f "$1" ]; then
  first=$(head -c 3 "$1" | od -An -tx1 | tr -d '[:space:]')
  if [ "$first" = "efbbbf" ]; then
    tail -c +4 "$1" > "$1.nobom" && mv "$1.nobom" "$1"
    echo "[commit-msg] stripped a UTF-8 BOM from the commit message (#976)" >&2
  fi
fi
`;
  const tddGate = `
# TDD mode: ensure AC test commit comes before implementation commits.
MSG=$(cat "$1")
# If this commit is the AC test commit, allow it.
if echo "$MSG" | grep -qE '^test: AC for #[0-9]+'; then
  exit 0
fi
# Check if an AC test commit already exists on this branch.
if git log --oneline | grep -qE ' test: AC for #[0-9]+'; then
  exit 0
fi
echo "TDD mode: write failing AC tests first." >&2
echo "  Commit your tests with: git commit -m 'test: AC for #<issue-number>'" >&2
exit 1
`;
  return opts.tddMode ? bomStrip + tddGate : `${bomStrip}exit 0
`;
}

/** What {@link installCommitMsgHook} did, so the caller can log a verdict rather than assume one. */
export interface CommitMsgHookInstall {
  installed: boolean;
  /** The hook file the install targeted — written when `installed`, intended when not. */
  path: string;
  /** Why nothing was installed. Absent on success. */
  reason?: string;
}

/**
 * Install the `commit-msg` hook WHERE GIT WILL RUN IT for this particular worktree (#1214).
 *
 * #976 wrote the script to `<worktree>/.git/hooks/commit-msg`, which is correct for a main
 * checkout and a no-op everywhere else: in a linked worktree `.git` is a FILE
 * (`gitdir: <main>/.git/worktrees/<name>`), so the `mkdirSync` failed, the error was swallowed,
 * and every builder — the population the BOM commits actually come from — committed with no
 * backstop at all. The TDD gate riding on the same hook was inert there too.
 *
 * So the git-dir is ASKED for (`rev-parse --git-dir`) instead of assumed. For a main checkout
 * that answers `.git` and the behaviour is unchanged, hooks resolving the normal way. For a
 * linked worktree it answers the per-worktree admin dir, whose `hooks/` git would otherwise
 * ignore — hooks resolve from the COMMON dir — so `core.hooksPath` is pointed at it via
 * `--worktree`, which needs `extensions.worktreeConfig` on the repo. That keeps the TDD-gate
 * variant scoped to the workspace that asked for it and leaves the main checkout's own hooks
 * untouched, which a shared `core.hooksPath` would not.
 *
 * Best-effort by contract: provisioning must never fail over a hook, so every failure returns a
 * reason for the caller to WARN with rather than throwing or going silent.
 */
export async function installCommitMsgHook(
  worktreePath: string,
  opts: { tddMode: boolean },
): Promise<CommitMsgHookInstall> {
  const fallbackPath = join(worktreePath, ".git", "hooks", "commit-msg");
  try {
    const dir = await resolveWorktreeGitDir(worktreePath);
    if (!dir) return { installed: false, path: fallbackPath, reason: `not a git worktree: ${worktreePath}` };

    const hooksDir = join(dir.gitDir, "hooks");
    const hookPath = join(hooksDir, "commit-msg");
    mkdirSync(hooksDir, { recursive: true });
    // Explicit LF and no BOM: this is a `#!/bin/sh` script, and a CRLF shebang line is not
    // executable. `writeFileSync` writes the bytes it is given, so the script's own newlines are
    // what lands — but it is worth saying, in the one file whose whole job is byte hygiene.
    writeFileSync(hookPath, buildCommitMsgHookScript(opts), { encoding: "utf-8" });
    try {
      chmodSync(hookPath, 0o755);
    } catch {
      // chmod is a no-op on Windows; Git for Windows runs the hook through its own sh regardless.
    }

    if (!dir.isMainCheckout) {
      const pointed = await pointWorktreeHooksPath(worktreePath, hooksDir);
      if (pointed) return { installed: false, path: hookPath, reason: pointed };
    }
    return { installed: true, path: hookPath };
  } catch (err) {
    return { installed: false, path: fallbackPath, reason: errorMessage(err) };
  }
}

/**
 * {@link installCommitMsgHook} plus the log line the provisioning path owes the operator.
 *
 * Separate from the install itself because the BACKFILL sweep (#1214) installs into many
 * worktrees in one pass and reports counts once — a per-worktree line there would be the
 * noise that makes a log stop being read.
 */
export async function installAndReportCommitMsgHook(
  worktreePath: string,
  opts: { tddMode: boolean },
): Promise<CommitMsgHookInstall> {
  const result = await installCommitMsgHook(worktreePath, opts);
  if (result.installed) {
    console.log(
      `[workspace-provision] commit-msg hook installed at ${result.path}` +
        (opts.tddMode ? " (TDD gate + BOM strip)" : " (BOM strip)"),
    );
  } else {
    console.warn(
      `[workspace-provision] commit-msg hook NOT installed for ${worktreePath}: ${result.reason ?? "unknown reason"}`,
    );
  }
  return result;
}

/** The git-dir git itself uses for `worktreePath`, plus whether that is a main checkout. */
async function resolveWorktreeGitDir(
  worktreePath: string,
): Promise<{ gitDir: string; isMainCheckout: boolean } | null> {
  const res = await gitExec(["rev-parse", "--git-dir"], { cwd: worktreePath });
  if (!execSucceeded(res)) return null;
  const raw = res.stdout.trim();
  if (!raw) return null;
  const gitDir = resolvePath(worktreePath, raw);
  // A main checkout answers `.git` (relative) — a linked worktree answers
  // `<main>/.git/worktrees/<name>`, which never resolves to the worktree's own `.git`.
  return { gitDir, isMainCheckout: gitDir === resolvePath(worktreePath, ".git") };
}

/**
 * Point this worktree — and only this worktree — at its own `hooks/`. Returns null on success,
 * else the reason the hook will not run.
 */
async function pointWorktreeHooksPath(worktreePath: string, hooksDir: string): Promise<string | null> {
  // `--worktree` needs the extension, and enabling it is what makes an existing
  // `config.worktree` (if any) take effect — so only set it when it is not already true,
  // which is also what keeps this idempotent across every provisioning and every backfill pass.
  const current = await gitExec(["config", "--get", "extensions.worktreeConfig"], { cwd: worktreePath });
  if (current.stdout.trim() !== "true") {
    const enable = await gitExec(["config", "extensions.worktreeConfig", "true"], { cwd: worktreePath });
    if (!execSucceeded(enable)) return `could not enable extensions.worktreeConfig: ${execErrorMessage(enable)}`;
  }
  // Forward slashes: git config escapes backslashes in values, and a Windows path round-trips
  // through that layer more reliably as a POSIX-shaped one, which git accepts everywhere.
  const value = hooksDir.split(sep).join("/");
  const set = await gitExec(["config", "--worktree", "core.hooksPath", value], { cwd: worktreePath });
  if (!execSucceeded(set)) return `could not set core.hooksPath: ${execErrorMessage(set)}`;
  return null;
}
