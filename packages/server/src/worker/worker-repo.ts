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
import { writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { isBareFileName, type WorkerRepoTransport } from "@agentic-kanban/shared/lib/worker-protocol";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

export function defaultWorkerWorkRoot(): string {
  return join(homedir(), ".agentic-kanban", "worker");
}

/**
 * The clone/fetch/push URL for a repo transport — WITHOUT the token.
 *
 * The token used to be embedded (`http://x-token:<token>@host:port/...`), which
 * put it on the `git clone` command line (visible in any process listing) and
 * persisted it in the clone's `.git/config` origin URL on the worker's disk,
 * where it outlived the assignment. The credential now travels via
 * {@link gitAuthEnv} instead, so nothing durable on the worker holds it.
 */
export function composeGitUrl(boardUrl: string, repo: WorkerRepoTransport): string {
  const board = new URL(boardUrl);
  const scheme = board.protocol === "https:" ? "https" : "http";
  return `${scheme}://${board.hostname}:${repo.gitPort}/git/${repo.projectId}`;
}

/**
 * Per-invocation git auth: the assignment token as an HTTP Authorization header,
 * injected through git's ENV-based config (`GIT_CONFIG_COUNT`/`_KEY_0`/`_VALUE_0`,
 * git >= 2.31). Env-based rather than `-c http.extraHeader=…` because the latter
 * would still expose the token in the process's argv, and unlike a URL credential
 * it is never written into the clone's config.
 */
export function gitAuthEnv(repo: WorkerRepoTransport): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-token:${repo.gitToken}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
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

  const authEnv = gitAuthEnv(repo);
  if (!existsSync(join(cacheDir, ".git"))) {
    await gitExecOrThrow(["clone", gitUrl, cacheDir], { timeout: 10 * 60 * 1000, env: authEnv });
  } else {
    // A token is per-assignment — always fetch with the CURRENT credential.
    await gitExecOrThrow(["fetch", gitUrl, "+refs/heads/*:refs/remotes/origin/*", "--prune"], {
      cwd: cacheDir,
      timeout: 10 * 60 * 1000,
      env: authEnv,
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
  const startPoint = execSucceeded(branchProbe)
    ? `refs/remotes/origin/${repo.branch}`
    : `refs/remotes/origin/${repo.baseBranch}`;
  await gitExecOrThrow(["worktree", "add", "-b", localBranch, checkoutDir, startPoint], { cwd: cacheDir });

  // #553: through the shared writer, not a raw writeFileSync. The hand-rolled version
  // had no `isSafeSkillName` guard and emitted no frontmatter, so a remote worker's
  // skills were not discoverable as slash-commands the way every local one is.
  for (const skill of repo.skills ?? []) {
    await writeAgentSkillFile(checkoutDir, {
      name: skill.name,
      description: skill.description ?? "",
      prompt: skill.content,
    });
  }

  // #749: the ticket-context file(s) the board wrote into ITS worktree. They arrive as
  // name + content because a board path names nothing here, and they must land BEFORE the
  // agent starts: claude reads `CLAUDE.local.md` as project memory at session start, and
  // copilot attaches it by (now relative) name. Written after the skills and before the
  // setup script so a setup script could still consult them.
  for (const file of repo.contextFiles ?? []) {
    if (!isBareFileName(file.name)) {
      // Defence in depth: the parser already drops these, but this write is what would
      // escape the checkout, so it refuses on its own account too.
      console.warn(`[worker] refusing context file with a non-bare name: ${file.name}`);
      continue;
    }
    writeFileSync(join(checkoutDir, file.name), file.content, "utf-8");
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
    env: gitAuthEnv(repo),
  });
}

/** Best-effort teardown of the per-session worktree (cache clone stays). */
export async function cleanupWorkerCheckout(checkout: WorkerCheckout): Promise<void> {
  await gitExec(["worktree", "remove", "--force", checkout.cwd], { cwd: checkout.cacheDir });
}
