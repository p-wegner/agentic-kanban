// Worker-side repo provisioning for git-transport assignments (epic #184,
// phase 2 #188).
//
// The worker keeps ONE cached clone per project under its work root and carves
// a per-session git worktree out of it. The feature branch starts from
// origin/<branch> when the board already has it (resume) and from
// origin/<baseBranch> otherwise. After the agent exits the result is pushed to
// the board's incoming namespace (refs/kanban/incoming/<branch>) Ã¢â‚¬â€ never to
// refs/heads/* Ã¢â‚¬â€ and the board fast-forwards the real branch from there.
//
// Every git call goes through the sanctioned @agentic-kanban/shared git-exec
// adapter (single-spawn architecture gate).

import { workerLog } from "./worker-updater.js";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";
import { TICKET_CONTEXT_FILENAME } from "@agentic-kanban/shared/lib/ticket-context";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { withWorktreeAdminLock, WORKTREE_PRUNE_MIN_AGE } from "@agentic-kanban/shared/lib/git-service";

/** Age-bounded prune of a cached clone, under the worktree admin lock (#1353). */
const pruneCacheWorktrees = (cacheDir: string) =>
  withWorktreeAdminLock(cacheDir, () => gitExec(["worktree", "prune", `--expire=${WORKTREE_PRUNE_MIN_AGE}`], { cwd: cacheDir }));
/** `git worktree remove --force` of one checkout, under the worktree admin lock (#1353). */
const removeCacheWorktree = (cacheDir: string, dir: string) =>
  withWorktreeAdminLock(cacheDir, () => gitExec(["worktree", "remove", "--force", dir], { cwd: cacheDir }));
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import {
  isBareFileName,
  type WorkerRepoOpAuth,
  type WorkerRepoOpStatus,
  type WorkerPhaseTimings,
  type WorkerRepoTransport,
  type WorkerCommitterIdentity,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

export function defaultWorkerWorkRoot(): string {
  return join(homedir(), ".agentic-kanban", "worker");
}

/**
 * The clone/fetch/push URL for a repo transport Ã¢â‚¬â€ WITHOUT the token.
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
 * git >= 2.31). Env-based rather than `-c http.extraHeader=Ã¢â‚¬Â¦` because the latter
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
  /** What provisioning cost, per phase (#1328). Absent on a checkout rebuilt from disk. */
  phases?: Pick<WorkerPhaseTimings, "fetchKind" | "fetchMs" | "worktreeMs" | "setupMs">;
}

/**
 * Marker-based fallback install command for a checkout whose assignment carried no
 * setup script (#852).
 *
 * The board derives a stack-aware `setup_script` per project at registration (#810) and
 * the assignment carries it Ã¢â‚¬â€ but projects registered before that backfill have a null
 * column, so the assignment arrives with no script and the worker used to install NOTHING.
 * The dispatched agent then ran `pnpm exec vitest` against a checkout with no linked
 * binaries, burned a turn on `Command "vitest" not found`, and shipped unverified work
 * with exit 0.
 *
 * Deliberately Node-only and deliberately tiny: the worker binary is isolated from the
 * board's service layer (`worker-cli-isolation`), so it cannot reuse the full
 * `detectStackProfile` cascade Ã¢â‚¬â€ and Node is the stack where a missing install is silent
 * (a JVM/Python agent fails loudly and immediately on a missing build). Non-Node stacks
 * are expected to travel via the assignment's setup script.
 */
export function deriveFallbackSetupCommand(checkoutDir: string): string | null {
  const has = (name: string): boolean => existsSync(join(checkoutDir, name));
  if (!has("package.json")) return null;
  if (has("pnpm-lock.yaml") || has("pnpm-workspace.yaml")) {
    // pnpm installs the whole workspace from the root; `-r` is surfaced for monorepos to
    // make that explicit (same shape the board's own derivation emits).
    return has("pnpm-workspace.yaml") ? "pnpm install -r" : "pnpm install";
  }
  if (has("yarn.lock")) return "yarn install";
  if (has("bun.lockb") || has("bun.lock")) return "bun install";
  return "npm install --no-audit --no-fund";
}

/**
 * Give the checkout the board's committer identity for whichever half it lacks (#1369).
 *
 * The worker never commits for the agent, so on a machine with no global `user.name` /
 * `user.email` the AGENT's commit fails. The board therefore sends the project's identity in
 * the assignment and it is set here with `git config --local` - but only for a key the
 * checkout does not already resolve, so a worker owner's own global identity always wins.
 * Best-effort: a failure is logged, never fatal to the assignment.
 */
export async function applyCommitterIdentity(
  checkoutDir: string,
  committer: WorkerCommitterIdentity | undefined,
  log: (line: string) => void = workerLog,
): Promise<void> {
  if (!committer) return;
  for (const [key, value] of [["user.name", committer.name], ["user.email", committer.email]] as const) {
    try {
      const current = await gitExec(["config", key], { cwd: checkoutDir });
      if (execSucceeded(current) && current.stdout.trim()) continue;
      await gitExecOrThrow(["config", "--local", key, value], { cwd: checkoutDir });
      log(`[worker] no ${key} on this machine - set the board's project committer identity for ${checkoutDir}`);
    } catch (err) {
      log(`[worker] could not set ${key} in ${checkoutDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
  log: (line: string) => void = workerLog,
): Promise<WorkerCheckout> {
  // #1334: one line per repo phase, so a remote operator can time a session from the log.
  // #1328: the same durations are also kept, so they reach the board on the session's exit.
  const phases: NonNullable<WorkerCheckout["phases"]> = {};
  const phase = async <T>(label: string, run: () => Promise<T>, record?: (ms: number) => void): Promise<T> => {
    const t0 = Date.now();
    try {
      const out = await run();
      record?.(Date.now() - t0);
      log(`[worker] ${label} ${Date.now() - t0}ms`);
      return out;
    } catch (err) {
      log(`[worker] ${label} FAILED after ${Date.now() - t0}ms`);
      throw err;
    }
  };
  const gitUrl = composeGitUrl(boardUrl, repo);
  const cacheDir = join(workRoot, "repos", repo.projectId);
  const checkoutDir = join(workRoot, "checkouts", sessionId);
  mkdirSync(join(workRoot, "repos"), { recursive: true });
  mkdirSync(join(workRoot, "checkouts"), { recursive: true });

  const authEnv = gitAuthEnv(repo);
  if (!existsSync(join(cacheDir, ".git"))) {
    phases.fetchKind = "clone";
    await phase(`clone ${repo.projectId}`, () =>
      gitExecOrThrow(["clone", gitUrl, cacheDir], { timeout: 10 * 60 * 1000, env: authEnv }),
      (ms) => { phases.fetchMs = ms; });
  } else {
    // A token is per-assignment Ã¢â‚¬â€ always fetch with the CURRENT credential.
    phases.fetchKind = "fetch";
    await phase(`fetch ${repo.projectId}`, () =>
      gitExecOrThrow(["fetch", gitUrl, "+refs/heads/*:refs/remotes/origin/*", "--prune"], {
        cwd: cacheDir,
        timeout: 10 * 60 * 1000,
        env: authEnv,
      }),
      (ms) => { phases.fetchMs = ms; });
  }

  // Stale worktree from a crashed prior session with the same id Ã¢â‚¬â€ remove it.
  if (existsSync(checkoutDir)) {
    await removeCacheWorktree(cacheDir, checkoutDir);
  }
  // A prior session for the SAME branch holds the branch name; a branch can be
  // checked out in at most one worktree, so reuse-or-recreate via a session-
  // scoped branch would diverge from the board's branch name (the push target
  // is a ref, so the LOCAL branch name is free) Ã¢â‚¬â€ use a detached-then-branch
  // form: check out the start point detached, then move to a session-local
  // branch name that can never collide.
  const localBranch = `kanban/${sessionId}`;
  const branchProbe = await gitExec(["rev-parse", "--verify", `refs/remotes/origin/${repo.branch}`], { cwd: cacheDir });
  const startPoint = execSucceeded(branchProbe)
    ? `refs/remotes/origin/${repo.branch}`
    : `refs/remotes/origin/${repo.baseBranch}`;
  await phase("worktree add", () =>
    withWorktreeAdminLock(cacheDir, () =>
      gitExecOrThrow(["worktree", "add", "-b", localBranch, checkoutDir, startPoint], { cwd: cacheDir })),
    (ms) => { phases.worktreeMs = ms; });

  // #1397: the ticket brief and review prompt name the board's branch (`repo.branch`), but this
  // checkout sits on `kanban/<sessionId>`. Point the board's name at the same commit so
  // `git diff <base>...<branch>` and `git log <branch>` resolve. It is NOT checked out here
  // (HEAD stays on localBranch), so it never collides with another session's worktree; `-f`
  // moves a stale pointer left in the shared cache by an earlier session. Best-effort.
  if (repo.branch && repo.branch !== localBranch) {
    const alias = await gitExec(["branch", "-f", repo.branch, "HEAD"], { cwd: checkoutDir });
    if (!execSucceeded(alias)) log(`[worker] could not alias branch ${repo.branch} to the checkout HEAD (non-fatal)`);
  }

  await applyCommitterIdentity(checkoutDir, repo.committer, log);

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
      workerLog(`[worker] refusing context file with a non-bare name: ${file.name}`);
      continue;
    }
    writeFileSync(join(checkoutDir, file.name), file.content, "utf-8");
  }

  // #852: an assignment with no setup script used to mean NO install at all Ã¢â‚¬â€ the agent
  // then discovered the missing dependencies by failing (`Command "vitest" not found`)
  // and shipped unverified work with exit 0. Honor the assignment's script when it
  // travels; otherwise fall back to a marker-derived install so the agent can verify
  // its own work.
  const assignmentScript = repo.setupScript?.trim();
  const setupCommand = assignmentScript || deriveFallbackSetupCommand(checkoutDir);
  if (setupCommand) {
    const source = assignmentScript
      ? "assignment setup script"
      : "fallback install (assignment carried no setup script)";
    log(`[worker] setup start (${source}) for session ${sessionId}: ${setupCommand}`);
    const setupStart = Date.now();
    const result = await runSetupScript(checkoutDir, setupCommand);
    phases.setupMs = Date.now() - setupStart;
    log(
      `[worker] setup end for session ${sessionId}: exit ${result.exitCode}` +
        `${result.timedOut ? " (timed out)" : ""} in ${Date.now() - setupStart}ms`,
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).slice(-400);
      throw new Error(
        result.timedOut
          ? `setup (${setupCommand}) timed out - dependencies are incomplete, the agent could not verify its work`
          : `setup script failed (exit ${result.exitCode}): ${detail}`,
      );
    }
    warnIfBinariesUnlinked(checkoutDir, setupCommand);
  }

  return { cwd: checkoutDir, cacheDir, phases };
}

/**
 * The #852 failure shape made VISIBLE: an install that exits 0 but links no binaries
 * (`node_modules` exists with packages in it, no `.bin` directory), so no test runner
 * resolves and the agent works blind.
 *
 * A warning rather than a throw: a root manifest whose few deps carry no bin entries
 * legitimately gets no `.bin`, and failing the whole dispatch on that heuristic would
 * permanently block such projects. Instead the note is appended to the ticket-context
 * file the agent reads at session start, so it is TOLD it may be unable to verify Ã¢â‚¬â€
 * and told to say so Ã¢â‚¬â€ instead of discovering it by failure.
 */
function warnIfBinariesUnlinked(checkoutDir: string, setupCommand: string): void {
  if (!existsSync(join(checkoutDir, "package.json"))) return;
  if (!existsSync(join(checkoutDir, "node_modules"))) return;
  if (existsSync(join(checkoutDir, "node_modules", ".bin"))) return;
  const warning =
    `setup (${setupCommand}) completed but node_modules/.bin was not created - ` +
    `package binaries (test runners, linters) may not resolve in this checkout`;
  workerLog(`[worker] ${warning}`);
  const contextFile = join(checkoutDir, TICKET_CONTEXT_FILENAME);
  if (!existsSync(contextFile)) return;
  try {
    appendFileSync(
      contextFile,
      `\n\n## Worker checkout warning (#852)\n\n` +
        `${warning}. If you cannot run the project's tests here, say so explicitly in your ` +
        `final summary and commit message ("unverified") instead of finishing silently - ` +
        `the board re-verifies before merge, but it must know this work was not verified locally.\n`,
      "utf-8",
    );
  } catch (err) {
    workerLog(`[worker] could not append the .bin warning to ${contextFile}: ${String(err)}`);
  }
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
 * (#775), so the request's token is what travels Ã¢â‚¬â€ `branch`/`incomingRef` come with it so
 * a stale stored transport can never redirect the operation.
 */
function opTransport(auth: WorkerRepoOpAuth): WorkerRepoTransport {
  return {
    projectId: auth.projectId,
    gitPort: auth.gitPort,
    gitToken: auth.gitToken,
    branch: auth.branch,
    // Never used by a mid-session operation Ã¢â‚¬â€ a sync is relative to the session's own
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
 * (`update-base`), landed a fix-and-merge commit, or committed a review fix Ã¢â‚¬â€ all of which
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
        `${auth.branch} (${sha.slice(0, 8)}); refusing to fast-forward - this needs a human`,
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
  workerLog(`[worker] checkout fast-forwarded to ${sha.slice(0, 8)} for ${auth.branch}`);
  return { ok: true, status: "updated", sha };
}

/**
 * Push the checkout's CURRENT HEAD to the incoming ref mid-session (#784), so the board
 * can show a diff before the agent exits.
 *
 * Cheap and non-disturbing by construction: it reads HEAD and pushes, and touches neither
 * the index nor the working tree, so the running agent cannot observe it. Force is correct
 * for the same reason it is in {@link pushWorkerResult} Ã¢â‚¬â€ the incoming namespace is a
 * board-owned staging slot for exactly this branch Ã¢â‚¬â€ and the BOARD's landing is still
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

/**
 * Best-effort teardown of the per-session worktree (cache clone stays).
 *
 * `git worktree remove` can leave the directory behind holding only the `.codex/skills`
 * link/shell `writeAgentSkillFile` materializes (#1320), so the directory itself is
 * removed afterwards Ã¢â‚¬â€ one leaked shell per session otherwise, reaped only at next boot.
 */
export async function cleanupWorkerCheckout(checkout: WorkerCheckout): Promise<void> {
  await removeCacheWorktree(checkout.cacheDir, checkout.cwd);
  try {
    rmSync(checkout.cwd, { recursive: true, force: true });
  } catch (err) {
    workerLog(`[worker] could not remove checkout directory ${checkout.cwd}: ${String(err)}`);
  }
  // #1322: the checkout dir is named for the session id; drop its `kanban/<sessionId>` branch
  // (git refuses while the worktree is registered, hence after the remove + prune).
  await pruneCacheWorktrees(checkout.cacheDir);
  await gitExec(["branch", "-D", `kanban/${basename(checkout.cwd)}`], { cwd: checkout.cacheDir });
}

/**
 * #1322: delete `kanban/*` branches in a cached clone that no worktree holds Ã¢â‚¬â€ the
 * leftovers of sessions that ended before branch deletion existed. A branch checked out
 * in a live worktree is skipped (git would refuse anyway).
 */
async function sweepUnheldSessionBranches(
  cacheDir: string,
  log: (line: string) => void,
  report: ReapCheckoutsReport,
): Promise<void> {
  const listed = await gitExec(["for-each-ref", "--format=%(refname:short)", "refs/heads/kanban/"], { cwd: cacheDir });
  if (!execSucceeded(listed)) return;
  const branches = listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (branches.length === 0) return;
  await pruneCacheWorktrees(cacheDir);
  const wt = await gitExec(["worktree", "list", "--porcelain"], { cwd: cacheDir });
  if (!execSucceeded(wt)) return;
  const held = new Set(
    wt.stdout.split("\n").filter((l) => l.startsWith("branch ")).map((l) => l.slice(7).trim().replace(/^refs\/heads\//, "")),
  );
  for (const branch of branches) {
    if (held.has(branch)) continue;
    const del = await gitExec(["branch", "-D", branch], { cwd: cacheDir });
    if (execSucceeded(del)) {
      report.branchesDeleted.push(branch);
      log(`[worker] deleted unheld session branch ${branch} in ${cacheDir}`);
    }
  }
}

/** Outcome of a {@link reapOrphanedCheckouts} pass. */
export interface ReapCheckoutsReport {
  /** Checkout directories examined. */
  scanned: number;
  /** Directories removed because no cached clone's worktree list named them. */
  reaped: string[];
  /** Directories a removal attempt failed for (logged, left in place). */
  errored: string[];
  /** #1321: registered, ownerless checkouts deliberately left (`leaveAgents`). */
  stranded: string[];
  /** #1322: `kanban/*` branches deleted because no worktree held them. */
  branchesDeleted: string[];
}

export interface ReapCheckoutsOptions {
  /** Session ids (directory names) whose agent THIS daemon owns Ã¢â‚¬â€ never reaped. */
  owned?: ReadonlySet<string>;
  /** `--leave-agents`: report registered ownerless checkouts instead of removing them. */
  leaveAgents?: boolean;
}

/**
 * #1321: remove a dead session's checkout that git still has registered Ã¢â‚¬â€
 * `worktree remove --force`, delete `kanban/<sessionId>`, `worktree prune`.
 */
async function reapRegisteredCheckout(
  dir: string,
  sessionId: string,
  cacheDirs: string[],
  log: (line: string) => void,
  report: ReapCheckoutsReport,
): Promise<void> {
  try {
    for (const cacheDir of cacheDirs) {
      const listed = await gitExec(["worktree", "list", "--porcelain"], { cwd: cacheDir });
      if (!execSucceeded(listed) || !listed.stdout.split("\n").some((l) => l.startsWith("worktree ") && resolve(l.slice(9).trim()) === resolve(dir))) continue;
      await removeCacheWorktree(cacheDir, dir);
      await gitExec(["branch", "-D", `kanban/${sessionId}`], { cwd: cacheDir });
      await pruneCacheWorktrees(cacheDir);
    }
    rmSync(dir, { recursive: true, force: true });
    report.reaped.push(dir);
    log(`[worker] reaped dead session checkout (worktree still registered): ${dir}`);
  } catch (err) {
    report.errored.push(dir);
    log(`[worker] could not reap dead session checkout ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Remove checkout directories under `<workRoot>/checkouts/` whose git worktree
 * registration is gone (#850).
 *
 * A daemon stopped, disconnected, or crashed mid-session leaves its per-session
 * checkout on disk while `git worktree` forgets it Ã¢â‚¬â€ nothing else in the worker
 * ever revisits `checkouts/`, so those directories (each a full clone's worth of
 * files) accumulate forever. A checkout is orphaned when its absolute path does
 * not appear in `git worktree list --porcelain` for ANY of this machine's cached
 * clones under `repos/` Ã¢â‚¬â€ including when the checkout's own project cache is
 * itself gone, which is exactly the "git no longer knows about it" state this
 * ticket reports.
 *
 * Best-effort and non-throwing: called from daemon startup, where a scan failure
 * must never block pairing/connecting.
 */
export async function reapOrphanedCheckouts(
  workRoot: string = defaultWorkerWorkRoot(),
  log: (line: string) => void = () => {},
  opts: ReapCheckoutsOptions = {},
): Promise<ReapCheckoutsReport> {
  const report: ReapCheckoutsReport = { scanned: 0, reaped: [], errored: [], stranded: [], branchesDeleted: [] };
  await reapCheckoutDirs(workRoot, log, opts, report);
  // #1322: after the checkouts are gone, `kanban/*` branches no worktree holds are leftovers.
  try {
    const reposDir = join(workRoot, "repos");
    for (const e of readdirSync(reposDir, { withFileTypes: true })) {
      if (e.isDirectory()) await sweepUnheldSessionBranches(join(reposDir, e.name), log, report);
    }
  } catch {
    // no repos directory Ã¢â‚¬â€ nothing to sweep
  }
  return report;
}

async function reapCheckoutDirs(
  workRoot: string,
  log: (line: string) => void,
  opts: ReapCheckoutsOptions,
  report: ReapCheckoutsReport,
): Promise<ReapCheckoutsReport> {
  const checkoutsDir = join(workRoot, "checkouts");
  const reposDir = join(workRoot, "repos");

  let checkoutNames: string[];
  try {
    checkoutNames = readdirSync(checkoutsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return report; // no checkouts directory yet Ã¢â‚¬â€ nothing to scan
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
    if (!execSucceeded(listed)) continue; // corrupt/missing cache Ã¢â‚¬â€ its checkouts fall through as orphaned
    for (const line of listed.stdout.split("\n")) {
      if (line.startsWith("worktree ")) known.add(resolve(line.slice("worktree ".length).trim()));
    }
  }

  for (const name of checkoutNames) {
    const dir = join(checkoutsDir, name);
    if (known.has(resolve(dir))) {
      // #1321: still registered, but no agent of THIS daemon owns it (a daemon owns its
      // checkouts only after it provisions them, and this runs before any provisioning),
      // so it is a dead session's Ã¢â‚¬â€ a crash leaves the worktree registered.
      if (opts.owned?.has(name)) continue;
      if (opts.leaveAgents) {
        report.stranded.push(dir);
        log(`[worker] ownerless checkout left in place (--leave-agents; its agent may still be running): ${dir}`);
        continue;
      }
      await reapRegisteredCheckout(dir, name, projectDirs, log, report);
      continue;
    }
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
