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

import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import {
  isBareFileName,
  type WorkerRepoOpAuth,
  type WorkerRepoOpStatus,
  type WorkerRepoTransport,
} from "@agentic-kanban/shared/lib/worker-protocol";
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

/** Outcome of a mid-session repo operation in a worker checkout (#783, #784). */
export interface WorkerRepoOpOutcome {
  ok: boolean;
  status: WorkerRepoOpStatus;
  sha?: string;
  error?: string;
}

/**
 * The URL + auth for a mid-session operation, built from the FRESH per-request token
 * (#783). The assignment's own token is expiring and a board restart invalidates it
 * (#775), so the request's token is what travels — `branch`/`incomingRef` come with it so
 * a stale stored transport can never redirect the operation.
 */
function opTransport(auth: WorkerRepoOpAuth): WorkerRepoTransport {
  return {
    projectId: auth.projectId,
    gitPort: auth.gitPort,
    gitToken: auth.gitToken,
    branch: auth.branch,
    // Never used by a mid-session operation — a sync is relative to the session's own
    // branch and a push aims at the incoming ref. Present only to satisfy the shape.
    baseBranch: auth.branch,
    incomingRef: auth.incomingRef,
  };
}

/**
 * Pull the BOARD's current tip of the session's branch into the worker's live checkout
 * (#783).
 *
 * Between two turns of a remote session the board may have rebased the branch
 * (`update-base`), landed a fix-and-merge commit, or committed a review fix — all of which
 * exist only board-side. Without this, the second turn runs against the tree the session
 * cloned and can rebuild on the wrong base.
 *
 * FAST-FORWARD ONLY, and deliberately in a shape that cannot lose work:
 *  - no `reset --hard`, so the agent's uncommitted edits are never discarded;
 *  - no `--force`, no `--rebase`, no `--autostash`;
 *  - a checkout whose HEAD is not an ancestor of the board's tip is reported `diverged`
 *    and left exactly as it is, which is the same contract `worker-remote-sync.service.ts`
 *    applies board-side;
 *  - a `merge --ff-only` that git refuses because it would overwrite local changes is
 *    reported `dirty-held`, not retried with force.
 */
export async function syncWorkerCheckout(
  boardUrl: string,
  auth: WorkerRepoOpAuth,
  checkout: WorkerCheckout,
): Promise<WorkerRepoOpOutcome> {
  const repo = opTransport(auth);
  const gitUrl = composeGitUrl(boardUrl, repo);
  const authEnv = gitAuthEnv(repo);
  const remoteRef = `refs/remotes/origin/${auth.branch}`;
  const fetched = await gitExec(
    ["fetch", gitUrl, `+refs/heads/${auth.branch}:${remoteRef}`],
    { cwd: checkout.cwd, timeout: 5 * 60 * 1000, env: authEnv },
  );
  if (!execSucceeded(fetched)) {
    const detail = (fetched.stderr || fetched.stdout).trim().slice(-400);
    // A branch the board no longer has is `missing`, not a transport error: the board
    // must be able to tell "I cannot reach you" from "there is nothing to sync to".
    const status: WorkerRepoOpStatus = /couldn't find remote ref|not our ref/i.test(detail)
      ? "missing"
      : "error";
    return { ok: false, status, error: `fetch of ${auth.branch} failed: ${detail}` };
  }
  const target = await gitExec(["rev-parse", "--verify", `${remoteRef}^{commit}`], { cwd: checkout.cwd });
  if (!execSucceeded(target)) {
    return { ok: false, status: "missing", error: `board has no ${auth.branch} to sync to` };
  }
  const sha = target.stdout.trim();
  const head = await gitExec(["rev-parse", "HEAD"], { cwd: checkout.cwd });
  if (!execSucceeded(head)) {
    return { ok: false, status: "error", error: `could not read HEAD in ${checkout.cwd}` };
  }
  if (head.stdout.trim() === sha) return { ok: true, status: "unchanged", sha };
  const ancestor = await gitExec(["merge-base", "--is-ancestor", "HEAD", sha], { cwd: checkout.cwd });
  if (!execSucceeded(ancestor)) {
    return {
      ok: false,
      status: "diverged",
      error:
        `the worker checkout (${head.stdout.trim().slice(0, 8)}) is not an ancestor of the board's ` +
        `${auth.branch} (${sha.slice(0, 8)}); refusing to fast-forward — this needs a human`,
    };
  }
  const merged = await gitExec(["merge", "--ff-only", sha], { cwd: checkout.cwd });
  if (!execSucceeded(merged)) {
    return {
      ok: false,
      status: "dirty-held",
      error:
        `fast-forward to ${sha.slice(0, 8)} was refused (most likely local changes the agent ` +
        `has not committed): ${(merged.stderr || merged.stdout).trim().slice(-400)}`,
    };
  }
  console.log(`[worker] checkout fast-forwarded to ${sha.slice(0, 8)} for ${auth.branch}`);
  return { ok: true, status: "updated", sha };
}

/**
 * Push the checkout's CURRENT HEAD to the incoming ref mid-session (#784), so the board
 * can show a diff before the agent exits.
 *
 * Cheap and non-disturbing by construction: it reads HEAD and pushes, and touches neither
 * the index nor the working tree, so the running agent cannot observe it. Force is correct
 * for the same reason it is in {@link pushWorkerResult} — the incoming namespace is a
 * board-owned staging slot for exactly this branch — and the BOARD's landing is still
 * fast-forward only, so a force here can never rewrite history the board has accepted.
 *
 * Only COMMITTED work travels. The worker will not commit on the agent's behalf, so a
 * mid-session diff shows what the agent has committed, not its working tree.
 */
export async function pushWorkerHead(
  boardUrl: string,
  auth: WorkerRepoOpAuth,
  checkout: WorkerCheckout,
): Promise<WorkerRepoOpOutcome> {
  const repo = opTransport(auth);
  const head = await gitExec(["rev-parse", "HEAD"], { cwd: checkout.cwd });
  if (!execSucceeded(head)) {
    return { ok: false, status: "error", error: `could not read HEAD in ${checkout.cwd}` };
  }
  const sha = head.stdout.trim();
  const pushed = await gitExec(
    ["push", "--force", composeGitUrl(boardUrl, repo), `HEAD:${auth.incomingRef}`],
    { cwd: checkout.cwd, timeout: 5 * 60 * 1000, env: gitAuthEnv(repo) },
  );
  if (!execSucceeded(pushed)) {
    return {
      ok: false,
      status: "error",
      error: `mid-session push to ${auth.incomingRef} failed: ${(pushed.stderr || pushed.stdout).trim().slice(-400)}`,
    };
  }
  return { ok: true, status: "pushed", sha };
}

/** Best-effort teardown of the per-session worktree (cache clone stays). */
export async function cleanupWorkerCheckout(checkout: WorkerCheckout): Promise<void> {
  await gitExec(["worktree", "remove", "--force", checkout.cwd], { cwd: checkout.cacheDir });
}

/** Outcome of a {@link reapOrphanedCheckouts} pass. */
export interface ReapCheckoutsReport {
  /** Checkout directories examined. */
  scanned: number;
  /** Directories removed because no cached clone's worktree list named them. */
  reaped: string[];
  /** Directories a removal attempt failed for (logged, left in place). */
  errored: string[];
}

/**
 * Remove checkout directories under `<workRoot>/checkouts/` whose git worktree
 * registration is gone (#850).
 *
 * A daemon stopped, disconnected, or crashed mid-session leaves its per-session
 * checkout on disk while `git worktree` forgets it — nothing else in the worker
 * ever revisits `checkouts/`, so those directories (each a full clone's worth of
 * files) accumulate forever. A checkout is orphaned when its absolute path does
 * not appear in `git worktree list --porcelain` for ANY of this machine's cached
 * clones under `repos/` — including when the checkout's own project cache is
 * itself gone, which is exactly the "git no longer knows about it" state this
 * ticket reports.
 *
 * Best-effort and non-throwing: called from daemon startup, where a scan failure
 * must never block pairing/connecting.
 */
export async function reapOrphanedCheckouts(
  workRoot: string = defaultWorkerWorkRoot(),
  log: (line: string) => void = () => {},
): Promise<ReapCheckoutsReport> {
  const checkoutsDir = join(workRoot, "checkouts");
  const reposDir = join(workRoot, "repos");
  const report: ReapCheckoutsReport = { scanned: 0, reaped: [], errored: [] };

  let checkoutNames: string[];
  try {
    checkoutNames = readdirSync(checkoutsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return report; // no checkouts directory yet — nothing to scan
  }
  report.scanned = checkoutNames.length;
  if (checkoutNames.length === 0) return report;

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(reposDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(reposDir, e.name));
  } catch {
    // No caches at all: every checkout below is orphaned by definition.
  }

  const known = new Set<string>();
  for (const cacheDir of projectDirs) {
    const listed = await gitExec(["worktree", "list", "--porcelain"], { cwd: cacheDir });
    if (!execSucceeded(listed)) continue; // corrupt/missing cache — its checkouts fall through as orphaned
    for (const line of listed.stdout.split("\n")) {
      if (line.startsWith("worktree ")) known.add(resolve(line.slice("worktree ".length).trim()));
    }
  }

  for (const name of checkoutNames) {
    const dir = join(checkoutsDir, name);
    if (known.has(resolve(dir))) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      report.reaped.push(dir);
      log(`[worker] reaped orphaned checkout (no worktree registration): ${dir}`);
    } catch (err) {
      report.errored.push(dir);
      log(`[worker] could not reap orphaned checkout ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}
