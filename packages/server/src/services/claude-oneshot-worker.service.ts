// Place a one-shot agent call (`invokeClaudePrompt`) on a fleet worker (#1431).
//
// Builder and reviewer sessions go through `resolveSessionPlacement`; every one-shot used to
// `execFile` on the board host with no placement at all, so enhance, decompose, preflight, the
// merge-train fix agent and the train review always burned the host's CPU. This routes them
// through the same placement (`resolveWorkerPlacement`: the project's `worker_dispatch` opt-in,
// strictness, profile restriction) and over the fleet protocol's `oneshot` frame.
//
//  - Host fallback: no eligible worker, a worker that predates the frame (it never acks), or a
//    job that could not launch there all return `{ handled: false }` and the caller runs it on the
//    host exactly as before. With `worker_dispatch_strict` the same situations REFUSE instead
//    (`WorkerDispatchUnavailableError`, code NO_AVAILABLE_WORKER), never a silent host run.
//  - A prompt with no repo context needs no checkout. One that reads or edits the project passes
//    `repo`: the board pins the working tree's HEAD to a temporary branch, the worker checks it
//    out over git transport, and an `allowEdits` job pushes its commits back to an incoming ref,
//    which is fast-forwarded into the board-side working tree.
import { randomUUID } from "node:crypto";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import type { WorkerOneShotRequest, WorkerOneShotResult } from "@agentic-kanban/shared/lib/worker-protocol";
import type { Database } from "../db/index.js";
import type { ProviderName, buildAgentLaunchConfig } from "./agent-provider.js";
import { WorkerDispatchUnavailableError, type Placement } from "./agent-dispatch.service.js";
import { getWorkerFleet, resolveWorkerPlacement } from "./worker-fleet.service.js";
import { releaseWorkerSlot } from "./worker-slot-reservation.service.js";
import { ensureGitHttpServer } from "./git-http.service.js";
import { incomingRefFor } from "./worker-remote-sync.service.js";
import { resolveProjectCommitterIdentity } from "./project-committer-identity.js";
import { buildRemoteLaunchSpec } from "./remote-launch-spec.js";
import { buildRemoteSpecEnv } from "../lib/remote-spec-env.js";
import type { WorkerConnectionManager } from "./worker-connection.service.js";
import { registerOneShotDispatch } from "./oneshot-dispatch-registry.js";

/** How long a worker has to acknowledge the frame before it is treated as one that never will. */
export const ONESHOT_ACCEPT_TIMEOUT_MS = 20_000;
/** Extra time past the job's own timeout for the checkout and the push, when there is a repo. */
const REPO_GRACE_MS = 15 * 60_000;
const NO_REPO_GRACE_MS = 30_000;

type LaunchConfig = ReturnType<typeof buildAgentLaunchConfig>;
type RemotePlacement = Extract<Placement, { kind: "remote" }>;

export interface OneShotRepoContext {
  /** The project repo the worker's git transport serves (and where the temporary branch is pinned). */
  repoPath: string;
  baseBranch?: string;
  /** #1609: a train label; when the worker's fix cannot be applied it is kept on `kanban/train-fix/<label>`. */
  keepFixAs?: string;
}

export interface OneShotDispatchArgs {
  database: Database;
  projectId: string;
  providerName: ProviderName;
  /** The provider launch as built for the board host; the remote spec derives from it. */
  config: LaunchConfig;
  prompt: string;
  timeoutMs: number;
  cwd?: string;
  allowEdits: boolean;
  /** Present when the prompt needs the project's files; absent = no checkout. */
  repo?: OneShotRepoContext;
  /** The caller named an explicit agent command (it travels verbatim, no intent). */
  explicitCommand: boolean;
  /** Test seams. */
  manager?: WorkerConnectionManager;
  place?: typeof resolveWorkerPlacement;
  ackTimeoutMs?: number;
}

export type OneShotDispatchResult = { handled: false; reason: string } | { handled: true; text: string; /** #1572: the worker the run was placed on. */ worker?: string };

/** Pin `sha` to a temporary branch in the project repo, so the worker's `fetch refs/heads/*` sees it. */
async function pinWorkingTree(cwd: string, repoPath: string, branch: string): Promise<boolean> {
  const head = await gitExec(["rev-parse", "HEAD"], { cwd });
  if (head.error || !head.stdout.trim()) return false;
  const pinned = await gitExec(["update-ref", `refs/heads/${branch}`, head.stdout.trim()], { cwd: repoPath });
  return execSucceeded(pinned);
}

async function unpin(repoPath: string, branch: string): Promise<void> {
  await gitExec(["update-ref", "-d", `refs/heads/${branch}`], { cwd: repoPath }).catch(() => undefined);
  await gitExec(["update-ref", "-d", incomingRefFor(branch)], { cwd: repoPath }).catch(() => undefined);
}

/** Wait for the worker's `accepted` ack and then its `done`; null on ack timeout, error on loss. */
function awaitResult(args: {
  manager: WorkerConnectionManager;
  workerId: string;
  requestId: string;
  ackTimeoutMs: number;
  doneTimeoutMs: number;
  send: () => boolean;
}): Promise<WorkerOneShotResult | null> {
  const { manager, workerId, requestId } = args;
  return new Promise((resolve, reject) => {
    let ackTimer: NodeJS.Timeout | undefined;
    let doneTimer: NodeJS.Timeout | undefined;
    const unsubscribers: Array<() => void> = [];
    const finish = (fn: () => void): void => {
      clearTimeout(ackTimer);
      clearTimeout(doneTimer);
      for (const off of unsubscribers) off();
      fn();
    };
    unsubscribers.push(manager.onMessage((id, message) => {
      if (id !== workerId || message.type !== "oneshot_result" || message.result.requestId !== requestId) return;
      if (message.result.phase === "accepted") {
        clearTimeout(ackTimer);
        doneTimer = setTimeout(
          () => finish(() => reject(new Error(`fleet worker ${workerId} did not finish the one-shot within ${args.doneTimeoutMs}ms`))),
          args.doneTimeoutMs,
        );
        return;
      }
      finish(() => resolve(message.result));
    }));
    unsubscribers.push(manager.onDisconnect((id) => {
      if (id === workerId) finish(() => reject(new Error(`fleet worker ${workerId} disconnected before the one-shot finished`)));
    }));
    ackTimer = setTimeout(() => finish(() => resolve(null)), args.ackTimeoutMs);
    if (!args.send()) finish(() => resolve(null));
  });
}

async function buildRequest(
  args: OneShotDispatchArgs,
  placement: RemotePlacement,
  requestId: string,
  branch: string | undefined,
): Promise<WorkerOneShotRequest> {
  const sharesFs = !placement.repo && placement.sharesFilesystem !== false;
  const env = buildRemoteSpecEnv({ env: args.config.env, sharesFilesystem: sharesFs, worktreePath: args.cwd });
  const spec = buildRemoteLaunchSpec({
    config: args.config,
    env,
    cwd: args.cwd ?? "",
    hangTimeoutMs: 0,
    provider: args.providerName,
    ...(placement.profile?.name ? { profileName: placement.profile.name } : {}),
    trueRemote: !sharesFs,
    explicitCommand: args.explicitCommand,
  });
  let repo: WorkerOneShotRequest["repo"];
  if (placement.repo && branch) {
    const git = await ensureGitHttpServer(args.database);
    const incomingRef = incomingRefFor(branch);
    const committer = await resolveProjectCommitterIdentity(placement.repo.repoPath);
    repo = {
      projectId: placement.repo.projectId,
      gitPort: git.port,
      // Scoped to THIS worker, THIS project and THIS incoming ref, like a session's token (#247).
      gitToken: git.issueToken({ workerId: placement.workerId, projectId: placement.repo.projectId, incomingRef }),
      branch,
      baseBranch: placement.repo.baseBranch,
      incomingRef,
      setupScript: placement.repo.setupScript,
      ...(committer ? { committer } : {}),
    };
  }
  return {
    type: "oneshot",
    requestId,
    job: {
      command: spec.command,
      args: spec.args,
      env: spec.env,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs,
      allowEdits: args.allowEdits,
      ...(spec.useShell ? { useShell: true } : {}),
      ...(spec.intent ? { intent: spec.intent } : {}),
      ...(sharesFs && args.cwd ? { cwd: args.cwd } : {}),
    },
    ...(repo ? { repo } : {}),
  };
}

/** Fast-forward the board-side working tree onto the commit the worker pushed. */
async function applyWorkerFix(cwd: string, sha: string, keep?: { repoPath: string; label: string }): Promise<void> {
  try {
    await gitExecOrThrow(["merge", "--ff-only", sha], { cwd });
  } catch (err) {
    // #1609: a cancelled train removes or moves its tree; the shepherd's commit must outlive that.
    const ref = keep ? await keepTrainFix(keep.repoPath, keep.label, sha) : null;
    const kept = ref ? `; the fix is kept on ${ref} (reuse it with \`train land-local\` or the next train)` : "";
    throw new Error(`could not apply the worker's fix ${sha.slice(0, 8)} to ${cwd}: ${errorMessage(err).slice(0, 300)}${kept}`);
  }
}

/** Pin the fix commit to `refs/heads/kanban/train-fix/<label>`; null when it could not be written. */
export async function keepTrainFix(repoPath: string, label: string, sha: string): Promise<string | null> {
  const ref = `kanban/train-fix/${label.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  const res = await gitExec(["update-ref", `refs/heads/${ref}`, sha], { cwd: repoPath }).catch(() => null);
  return res && execSucceeded(res) ? ref : null;
}

/**
 * Run the one-shot on a worker when the project's placement says so. Throws a plain Error when
 * the agent ran and failed (same contract as the host path), and `WorkerDispatchUnavailableError`
 * when strict dispatch refuses the host.
 */
export async function dispatchOneShotToWorker(args: OneShotDispatchArgs): Promise<OneShotDispatchResult> {
  const { database, projectId } = args;
  const wantsRepo = Boolean(args.repo && args.cwd);
  // A working directory with no repo context names nothing on a worker, and an edit with no
  // checkout to push back would be lost: both stay on the host.
  if (args.cwd && !wantsRepo) return { handled: false, reason: "the prompt needs a working directory with no repo context to send" };
  if (args.allowEdits && !wantsRepo) return { handled: false, reason: "an editing one-shot needs repo context" };
  const branch = wantsRepo ? `kanban-oneshot/${randomUUID().slice(0, 12)}` : undefined;
  const repoPath = args.repo?.repoPath;
  const pinned = wantsRepo && branch && repoPath && args.cwd ? await pinWorkingTree(args.cwd, repoPath, branch) : false;
  if (wantsRepo && !pinned) return { handled: false, reason: "the working tree is not a commit in the project repo" };
  let placement: Placement | undefined;
  let endDispatch: (() => void) | undefined;
  try {
    placement = await (args.place ?? resolveWorkerPlacement)({
      database,
      projectId,
      providerName: args.providerName,
      oneShot: true,
      ...(pinned ? { branch, baseBranch: args.repo?.baseBranch } : {}),
    });
    if (placement.kind !== "remote") return { handled: false, reason: placement.reason?.detail ?? "placed on the host" };
    const requestId = randomUUID();
    const manager = args.manager ?? getWorkerFleet(database).connections;
    const request = await buildRequest(args, placement, requestId, pinned ? branch : undefined);
    // #1468: the worker pushes the fix to this branch; git-http accepts it only while registered.
    endDispatch = pinned && branch ? registerOneShotDispatch(placement.workerId, projectId, branch) : undefined;
    const result = await awaitResult({
      manager,
      workerId: placement.workerId,
      requestId,
      ackTimeoutMs: args.ackTimeoutMs ?? ONESHOT_ACCEPT_TIMEOUT_MS,
      doneTimeoutMs: args.timeoutMs + (request.repo ? REPO_GRACE_MS : NO_REPO_GRACE_MS),
      send: () => manager.send(placement!.kind === "remote" ? placement!.workerId : "", request),
    });
    return await settle(args, placement, result, request);
  } finally {
    endDispatch?.();
    if (placement?.kind === "remote") releaseWorkerSlot(placement.reservationId);
    if (pinned && branch && repoPath) await unpin(repoPath, branch);
  }
}

async function settle(
  args: OneShotDispatchArgs,
  placement: RemotePlacement,
  result: WorkerOneShotResult | null,
  request: WorkerOneShotRequest,
): Promise<OneShotDispatchResult> {
  const where = `fleet worker ${placement.workerId}`;
  const unavailable = (why: string): OneShotDispatchResult => {
    if (placement.strict) {
      throw new WorkerDispatchUnavailableError(`${why} and worker dispatch is strict for project ${args.projectId}`);
    }
    console.warn(`[oneshot] ${why}; running on the host`);
    return { handled: false, reason: why };
  };
  if (!result) return unavailable(`${where} did not acknowledge the one-shot (it may predate the frame or have dropped)`);
  if (result.phase !== "done") return unavailable(`${where} sent no outcome`);
  if (!result.ok) {
    if (result.launchFailed) return unavailable(`${where} could not launch the one-shot: ${result.error ?? "unknown"}`);
    throw new Error(`${where} one-shot failed: ${result.error ?? "unknown"}`);
  }
  if (result.pushedSha && args.cwd) {
    const keepFixAs = args.repo?.keepFixAs;
    await applyWorkerFix(args.cwd, result.pushedSha, keepFixAs && args.repo ? { repoPath: args.repo.repoPath, label: keepFixAs } : undefined);
  }
  console.log(`[oneshot] ran on ${where} (request ${request.requestId}${result.pushedSha ? `, fix ${result.pushedSha.slice(0, 8)}` : ""})`);
  return { handled: true, text: result.text ?? "", worker: placement.workerId };
}
