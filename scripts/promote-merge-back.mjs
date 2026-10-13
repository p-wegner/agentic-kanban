// The post-promotion merge-back of a release candidate into the base branch (#1436).
//
// Plain `.mjs`, deps injected, so the healed-rc path is testable without a board or a repo.
// Outcomes: "nothing" (rc tip already in base), "merged" (direct no-ff merge, then a base re-probe),
// "workspace" (the merge conflicted / the checkout was unfit; the board opened a merge-back
// workspace), "failed" (nothing worked: the caller must fail loudly and mark the project).

/**
 * @param {{
 *   rcBranch: string, baseBranch: string, tag: string,
 *   git: (args: string[]) => { code: number, stdout: string, stderr: string },
 *   requestWorkspace: () => Promise<{ issueNumber?: number, workspaceId?: string, created?: boolean } | null>,
 *   reprobe: () => Promise<boolean>,
 *   markAttention: (reason: string) => Promise<void>,
 *   log: (line: string) => void,
 * }} d  `git` runs in the main checkout.
 */
export async function mergeBackRc(d) {
  const { rcBranch, baseBranch, tag, git, log } = d;
  if (git(["merge-base", "--is-ancestor", rcBranch, baseBranch]).code === 0) {
    log(`[promote] rc: ${rcBranch} is promoted as ${tag}. Its tip is already in ${baseBranch} (nothing was healed on it) — no merge-back needed.`);
    return { outcome: "nothing" };
  }
  const count = Number(git(["rev-list", "--count", `${baseBranch}..${rcBranch}`]).stdout) || 0;
  const direct = tryDirectMerge(git, rcBranch, baseBranch, tag);
  if (direct.ok) {
    log(`[promote] rc: ${rcBranch} is promoted as ${tag}. merged back ${count} commit(s) into ${baseBranch} @ ${direct.sha}`);
    let probed = false;
    try {
      probed = await d.reprobe();
    } catch {
      probed = false;
    }
    log(probed ? `[promote] rc: ${baseBranch} re-probe requested` : `[promote] rc: could not request a ${baseBranch} re-probe — the nightly sweep will pick it up`);
    return { outcome: "merged", count, sha: direct.sha };
  }
  log(`[promote] rc: direct merge-back of ${rcBranch} into ${baseBranch} not possible (${direct.reason}) — asking the board for a merge-back workspace`);
  const ws = await d.requestWorkspace().catch(() => null);
  if (ws) {
    log(`[promote] rc: Merge-back #${ws.issueNumber ?? "?"} on workspace ${ws.workspaceId}${ws.created ? "" : " (already open)"} — the board lands it into ${baseBranch} and closes the heal tickets.`);
    return { outcome: "workspace", count };
  }
  const reason = `${rcBranch} (${tag}) carries ${count} commit(s) not in ${baseBranch} and the merge-back failed: ${direct.reason}`;
  log(`[promote] !!! MERGE-BACK FAILED: ${reason}. By hand: git merge --no-ff ${rcBranch} on ${baseBranch}.`);
  await d.markAttention(reason).catch(() => {});
  return { outcome: "failed", count, reason };
}

function tryDirectMerge(git, rcBranch, baseBranch, tag) {
  const head = git(["symbolic-ref", "--short", "HEAD"]);
  if (head.code !== 0 || head.stdout !== baseBranch) return { ok: false, reason: `main checkout is on ${head.stdout || "a detached HEAD"}, not ${baseBranch}` };
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.stdout) return { ok: false, reason: "main checkout has uncommitted tracked changes" };
  const merged = git(["merge", "--no-ff", rcBranch, "-m", `Merge ${rcBranch} (${tag}) back into ${baseBranch}`]);
  if (merged.code !== 0) {
    git(["merge", "--abort"]);
    return { ok: false, reason: `merge conflicted: ${(merged.stderr || merged.stdout).split("\n")[0]}` };
  }
  return { ok: true, sha: git(["rev-parse", "--short", "HEAD"]).stdout };
}
