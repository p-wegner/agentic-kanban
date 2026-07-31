// Worker-side repo provisioning for git-transport assignments (epic #184,
// phase 2 #188).
//
// The worker keeps ONE cached clone per project under its work root and carves
// a per-session git worktree out of it. The feature branch starts from
// origin/<branch> when the board already has it (resume) and from
// origin/<baseBranch> otherwise. After the agent exits the result is pushed to
// the board's incoming namespace (refs/kanban/incoming/<branch>) — never to
// refs/heads/* — and the board fast-forwards the real branch from there.
//
// Every git call goes through the sanctioned @agentic-kanban/shared git-exec
// adapter (single-spawn architecture gate).

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import type { WorkerRepoTransport } from "@agentic-kanban/shared/lib/worker-protocol";

export function defaultWorkerWorkRoot(): string {
  return join(homedir(), ".agentic-kanban", "worker");
}

/** The full clone/fetch URL for a repo transport, composed from the board host. */
export function composeGitUrl(boardUrl: string, repo: WorkerRepoTransport): string {
  const board = new URL(boardUrl);
  const scheme = board.protocol === "https:" ? "https" : "http";
  return `${scheme}://x-token:${repo.gitToken}@${board.hostname}:${repo.gitPort}/git/${repo.projectId}`;
}

export interface WorkerCheckout {
  cwd: string;
  cacheDir: string;
}

/**
 * Ensure the cached clone exists and is fresh, then create the per-session
 * worktree with the feature branch checked out. Throws with a descriptive
 * message on any git failure (surfaced to the board as assign_failed).
 */
export async function provisionWorkerCheckout(
  boardUrl: string,
  repo: WorkerRepoTransport,
  sessionId: string,
  workRoot: string = defaultWorkerWorkRoot(),
): Promise<WorkerCheckout> {
  const gitUrl = composeGitUrl(boardUrl, repo);
  const cacheDir = join(workRoot, "repos", repo.projectId);
  const checkoutDir = join(workRoot, "checkouts", sessionId);
  mkdirSync(join(workRoot, "repos"), { recursive: true });
  mkdirSync(join(workRoot, "checkouts"), { recursive: true });

  if (!existsSync(join(cacheDir, ".git"))) {
    await gitExecOrThrow(["clone", gitUrl, cacheDir], { timeout: 10 * 60 * 1000 });
  } else {
    // The token rotates per board boot — always fetch with the CURRENT url.
    await gitExecOrThrow(["fetch", gitUrl, "+refs/heads/*:refs/remotes/origin/*", "--prune"], {
      cwd: cacheDir,
      timeout: 10 * 60 * 1000,
    });
  }

  // Stale worktree from a crashed prior session with the same id — remove it.
  if (existsSync(checkoutDir)) {
    await gitExec(["worktree", "remove", "--force", checkoutDir], { cwd: cacheDir });
  }
  // A prior session for the SAME branch holds the branch name; a branch can be
  // checked out in at most one worktree, so reuse-or-recreate via a session-
  // scoped branch would diverge from the board's branch name (the push target
  // is a ref, so the LOCAL branch name is free) — use a detached-then-branch
  // form: check out the start point detached, then move to a session-local
  // branch name that can never collide.
  const localBranch = `kanban/${sessionId}`;
  const branchProbe = await gitExec(["rev-parse", "--verify", `refs/remotes/origin/${repo.branch}`], { cwd: cacheDir });
  const startPoint = branchProbe.code === 0
    ? `refs/remotes/origin/${repo.branch}`
    : `refs/remotes/origin/${repo.baseBranch}`;
  await gitExecOrThrow(["worktree", "add", "-b", localBranch, checkoutDir, startPoint], { cwd: cacheDir });

  for (const skill of repo.skills ?? []) {
    const dir = join(checkoutDir, ".claude", "skills", skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skill.content);
  }

  if (repo.setupScript?.trim()) {
    const result = await runSetupScript(checkoutDir, repo.setupScript);
    if (result.exitCode !== 0) {
      throw new Error(`setup script failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(-400)}`);
    }
  }

  return { cwd: checkoutDir, cacheDir };
}

/**
 * Push the session's work to the board's incoming ref. Force-push is correct:
 * the incoming namespace is a board-owned staging slot for exactly this
 * branch, and a relaunched session may legitimately rewrite it.
 */
export async function pushWorkerResult(
  boardUrl: string,
  repo: WorkerRepoTransport,
  checkout: WorkerCheckout,
): Promise<void> {
  const gitUrl = composeGitUrl(boardUrl, repo);
  await gitExecOrThrow(["push", "--force", gitUrl, `HEAD:${repo.incomingRef}`], {
    cwd: checkout.cwd,
    timeout: 10 * 60 * 1000,
  });
}

/** Best-effort teardown of the per-session worktree (cache clone stays). */
export async function cleanupWorkerCheckout(checkout: WorkerCheckout): Promise<void> {
  await gitExec(["worktree", "remove", "--force", checkout.cwd], { cwd: checkout.cacheDir });
}
