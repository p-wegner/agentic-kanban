// @gate:always-run
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * #976 — no NEW commit may carry a UTF-8 BOM (`EF BB BF`) in its subject.
 *
 * 77 of this repo's 9177 commits do, and the rate was accelerating (1 in 2026-05, 8 in -06,
 * 13 in -07, 53 in -08) as more work went through builders. The cause is an agent writing the
 * message with a bare PowerShell redirect — PS 5.1's `Set-Content`/`Out-File` default to UTF-8
 * WITH BOM — and `git commit -F` does not strip it. It is invisible in every normal view, so
 * review never catches it, while anything that PATTERN-MATCHES a subject sees `﻿feat(#951)`
 * rather than `feat(#951)`. That includes this board's own `ak-<N>` history matching in the
 * hand-merged-branch reconciler and `checkAlreadyMerged`.
 *
 * **Why a pinned sha and not a total count.** A count baseline would have to be a "may only
 * shrink" number, and history only grows forward — a landed commit is not rewritable here, so
 * the 77 will never shrink and the number could only ever be a budget. Worse, a shallow clone
 * sees FEWER commits and would read as an improvement. Scanning `BASELINE..HEAD` instead asks
 * the one question that has a right answer: did anything new add one.
 *
 * The BACKSTOP is the `commit-msg` hook every worktree now gets
 * (`installCommitMsgHook`, `workspace-provision.service.ts`), which strips the BOM rather than
 * refusing the commit. This test is what catches a commit that bypassed the hook — the main
 * checkout has none, which is exactly where the board's own maintainers commit.
 */
const BASELINE_SHA = "3fdbe91f288622fbeb4819cde84636c249a58f08";
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

describe("#976: commit subjects carry no UTF-8 BOM", () => {
  it("no commit since the baseline starts its subject with EF BB BF", () => {
    // A shallow clone, or a checkout whose history predates the baseline, cannot answer this.
    // Skipping loudly beats a green that asserted nothing — and beats a red on a clone shape
    // that is not the contributor's fault.
    if (git(["cat-file", "-e", `${BASELINE_SHA}^{commit}`]) === null) {
      console.warn(`[bom-ratchet] baseline ${BASELINE_SHA.slice(0, 8)} is not in this clone — skipping`);
      return;
    }

    // NUL-separated so a subject containing a newline cannot split one record into two.
    const log = git(["log", "-z", "--format=%H %s", `${BASELINE_SHA}..HEAD`]);
    if (log === null) return; // not a git checkout at all

    const offenders = log
      .split("\0")
      .filter(Boolean)
      .filter((entry) => entry.slice(entry.indexOf(" ") + 1).startsWith("﻿"))
      .map((entry) => entry.slice(0, 8));

    expect(
      offenders,
      `commit subject(s) begin with a UTF-8 BOM. Write the message with the Bash tool's heredoc ` +
        `(or PowerShell's -Encoding utf8NoBOM), never a bare PS redirect — see #976.`,
    ).toEqual([]);
  });
});
