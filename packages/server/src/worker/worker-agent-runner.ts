// Worker-side agent execution (epic #1, phase 1b #4).
//
// Runs the agent subprocesses a fleet worker was assigned and streams their
// output back to the board as protocol events. Deliberately simpler than the
// board's agent.service: no detach/reattach dance (the daemon owns its
// children for their whole life), no output files — pipes stream straight into
// WS messages. Survives socket loss: processes keep running and their events
// are re-sent... no, events during a disconnect are DROPPED (phase 1b);
// buffering/replay is a phase 3 concern. Exit events are queued by the daemon
// until the socket is back so session finalization is never lost.

import { workerLog } from "./worker-updater.js";
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { resolveAgentHangTimeoutMs, startHangWatchdog } from "../lib/agent-launch-env.js";
import { startSessionTemp, releaseSessionTemp } from "../lib/session-temp-dir.js";
import { killProcessTree } from "../services/process-exec.js";
import type {
  BoardToWorkerMessage,
  WorkerLaunchSpec,
  WorkerPhaseTimings,
  WorkerRepoOpAuth,
  WorkerRepoOpKind,
  WorkerRepoTransport,
  WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import {
  defaultWorkerWorkRoot,
  provisionWorkerCheckout,
  pushWorkerResult,
  pushWorkerHead,
  syncWorkerCheckout,
  cleanupWorkerCheckout,
  type WorkerCheckout,
  type WorkerRepoOpOutcome,
} from "./worker-repo.js";
import {
  type PendingResult,
  type PushOutcome,
  type UnpushedResult,
  createUndeliveredStore,
} from "./worker-undelivered-retry.js";
import { createGitTokenRequester } from "./worker-git-token.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { createWorkerSessionRegistry } from "./worker-session-registry.js";
import { resolveSpecCommand } from "./worker-command-resolver.js";
import { applyProfileToSpec } from "./worker-profiles.js";
import { createAuthFailureTracker } from "./worker-auth-failure.js";
import type { ProfileAlias } from "../lib/local-profile-discovery.js";
import { FLEET_MCP_TOKEN_ENV_VAR } from "@agentic-kanban/shared/lib/worker-protocol";
import { createAgentTreeTracker } from "./agent-process-tree.js";
import { applyHarnessToSpec, type WorkerHarness } from "./worker-harness.js";

export type SendToBoard = (message: WorkerToBoardMessage) => void;

/** #1379: the alias/home seams `applyProfileToSpec` resolves against. */
function profileResolveOptions(o: { profileAliases?: ProfileAlias[]; profileHome?: string }) {
  return { ...(o.profileAliases ? { aliases: o.profileAliases } : {}), ...(o.profileHome ? { home: o.profileHome } : {}) };
}

/** The board URL to compose git-transport URLs from, read at use time (#1337). */
function boardUrlOf(options: { boardUrl?: string | (() => string) }): string | undefined {
  return typeof options.boardUrl === "function" ? options.boardUrl() : options.boardUrl;
}

export interface WorkerAgentRunnerOptions {
  /** #1379: `--profile-alias` entries, so an assign naming an aliased profile resolves to its real dir. */
  profileAliases?: ProfileAlias[];
  /** Test seam: home dir profile resolution reads. */
  profileHome?: string;
  /**
   * Board base URL — required to compose git-transport URLs for repo assignments. A function is
   * read at USE time (#1337): the daemon passes one so the git URL follows whichever of several
   * board URLs is connected right now.
   */
  boardUrl?: string | (() => string);
  workRoot?: string;
  /** #1426: a session died of an auth failure before any tool call; the profile it ran as (undefined = unpinned). */
  onAuthFailure?: (profile: string | undefined) => void;
  /**
   * This machine's own concurrency ceiling (#266). The board also tracks capacity
   * (#248), but that only protects against a well-behaved board — the point of a
   * worker DECLARING capacity is that the machine's owner controls its load, so it
   * must enforce it itself rather than trust the assigner. Defaults to 1, matching
   * `worker-registry.service.ts`.
   */
  maxConcurrency?: number;
  /**
   * The three git-transport collaborators, overridable for tests (#754).
   *
   * A port, not a convenience: what had to be verified is that a shutdown WAITS for the
   * result push, and a real `git push` can be made neither to hang on demand nor to finish
   * on demand — while a real `provisionWorkerCheckout` needs a live git-HTTP listener and a
   * real repo just to reach the code under test. Production passes nothing and gets the
   * real three.
   */
  repoOps?: Partial<WorkerRepoOps>;
  /**
   * Backoff before each RETRY of a failed result push (#750). One entry per retry, so
   * `[a, b]` means up to three attempts. Overridable for tests; production gets
   * {@link DEFAULT_PUSH_RETRY_DELAYS_MS}.
   */
  pushRetryDelaysMs?: number[];
  /**
   * The worker-owned provider config (#1367). Absent = inherit mode: the session sees this
   * machine's own `~/.claude` and env exactly as before.
   */
  harness?: WorkerHarness;
}

/**
 * How long the worker waits before each retry of a failed result push (#750, #870).
 *
 * Bounded on purpose: the board does not see the session's `exit` until the push resolves,
 * so this list is the delay a completed-but-undelivered run adds to the board's view. Five
 * attempts spread over roughly two minutes (#870) — enough to ride out a board restart or a
 * connect timeout (the observed failure burned 21 s on ONE attempt) without holding the
 * exit hostage forever; a longer outage is covered by `retryPendingPushes` on the next
 * reconnect (with the entry persisted across a daemon restart, #871) instead of by
 * waiting here.
 */
/** An agent that exits non-zero within this long gets its stderr tail written to the worker log (#1383). */
const FAST_EXIT_LOG_MS = 60_000;

export const DEFAULT_PUSH_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 75_000];

/** The worker's git-transport boundary: get a checkout, push it back, tear it down. */
export interface WorkerRepoOps {
  provision: (
    boardUrl: string,
    repo: WorkerRepoTransport,
    sessionId: string,
    workRoot?: string,
  ) => Promise<WorkerCheckout>;
  push: (boardUrl: string, repo: WorkerRepoTransport, checkout: WorkerCheckout) => Promise<void>;
  cleanup: (checkout: WorkerCheckout) => Promise<void>;
  /** #783: fast-forward the live checkout to the board's branch tip. Never destructive. */
  sync: (boardUrl: string, auth: WorkerRepoOpAuth, checkout: WorkerCheckout) => Promise<WorkerRepoOpOutcome>;
  /** #784: push the live checkout's HEAD to the incoming ref, mid-session. */
  pushHead: (boardUrl: string, auth: WorkerRepoOpAuth, checkout: WorkerCheckout) => Promise<WorkerRepoOpOutcome>;
}

/**
 * Reason string for a refusal caused by this worker's own capacity ceiling (#266).
 * Distinguishable on purpose: the board must be able to tell "this machine is full"
 * (place elsewhere, release the pending slot) apart from a launch failure.
 */
export const ASSIGN_REFUSED_AT_CAPACITY = "worker at capacity";

export function createWorkerAgentRunner(send: SendToBoard, options: WorkerAgentRunnerOptions = {}) {
  const repoOps: WorkerRepoOps = {
    provision: options.repoOps?.provision ?? provisionWorkerCheckout,
    push: options.repoOps?.push ?? pushWorkerResult,
    cleanup: options.repoOps?.cleanup ?? cleanupWorkerCheckout,
    sync: options.repoOps?.sync ?? syncWorkerCheckout,
    pushHead: options.repoOps?.pushHead ?? pushWorkerHead,
  };
  const processes = new Map<string, ChildProcess>();
  /** Epoch ms each agent was spawned, for the per-phase timings on its exit (#1328). */
  const agentStartedAtMs = new Map<string, number>();
  const exited = new Set<string>();
  /** Last ~2 KB of each agent's stderr, logged when it dies fast with a non-zero exit (#1383). */
  const stderrTails = new Map<string, string>();
  const authWatch = createAuthFailureTracker((m) => safeSend(m), options.onAuthFailure); // #1426
  /** Sessions whose work lives in a worker-side checkout that must be pushed back. */
  const checkouts = new Map<string, PendingResult>();
  /**
   * Result pushes currently in flight, by session (#754).
   *
   * These used to be a fire-and-forget async IIFE that nothing held a reference to, so
   * `daemon.stop()` + `process.exit(0)` in the CLI killed the process mid-push: the agent
   * had finished, the commit existed on the worker, and the board learned about it only
   * via its 60 s disconnect grace — as a FAILURE. Holding them is what makes a bounded
   * drain possible at all.
   */
  const inFlightPushes = new Map<string, Promise<void>>();
  const workRoot = options.workRoot ?? defaultWorkerWorkRoot();
  const retryDelaysMs = options.pushRetryDelaysMs ?? DEFAULT_PUSH_RETRY_DELAYS_MS;
  /** Sessions provisioning a checkout — running for bookkeeping before a pid exists. */
  const provisioning = new Set<string>();
  /**
   * Can this session's stdin still receive input (#900)? Set from the spec at launch
   * (`keepStdinOpen && !suppressStdinPrompt`, the same rule `agent-remote.service.ts` uses
   * board-side), cleared on `closeStdin` and on exit. This is what makes a `probe_session`
   * answer for an ADOPTED session trustworthy — the board's own copy of this flag died with
   * the process that launched it, but the worker actually holds the child's stdin.
   */
  const stdinOpen = new Map<string, boolean>();
  /** Per-session silence watchdogs; reset on every byte of agent output. */
  const hangWatchdogs = new Map<string, { reset(): void; close(): void }>();
  let maxConcurrency = options.maxConcurrency && options.maxConcurrency > 0 ? options.maxConcurrency : 1;
  const tree = createAgentTreeTracker(workRoot); // #1336

  /**
   * Slots this machine currently holds. A provisioning session counts: it is already
   * cloning and about to spawn, so ignoring it would let a burst of assigns all pass
   * the check before any of them owns a pid.
   */
  function occupiedSlots(): number {
    let count = provisioning.size;
    for (const sessionId of processes.keys()) {
      if (!provisioning.has(sessionId)) count += 1;
    }
    return count;
  }

  /** True when accepting one more session would exceed this worker's own ceiling (#266). */
  function wouldExceedCapacity(sessionId: string): boolean {
    if (processes.has(sessionId) || provisioning.has(sessionId)) return false; // already holds a slot
    return occupiedSlots() + 1 > maxConcurrency;
  }

  function refuseAtCapacity(sessionId: string): void {
    workerLog(
      `[worker] refusing assign: sessionId=${sessionId} would exceed maxConcurrency=${maxConcurrency} (in use: ${occupiedSlots()})`,
    );
    send({ type: "assign_failed", sessionId, error: ASSIGN_REFUSED_AT_CAPACITY });
  }

  function closeWatchdog(sessionId: string): void {
    hangWatchdogs.get(sessionId)?.close();
    hangWatchdogs.delete(sessionId);
  }

  /** Sleep that never keeps the event loop alive on its own. */
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer.unref) timer.unref();
    });
  }

  /**
   * `send` that cannot throw into a push path (#870). The push/retain flow runs on the
   * child's `exit` event and inside detached promises, so an exception out of the daemon's
   * send callback here is a process-level uncaught exception — the exact "daemon threw ...
   * daemon exited" that turned one failed push into every agent on the machine dying.
   */
  function safeSend(message: WorkerToBoardMessage): void {
    try {
      send(message);
    } catch (err) {
      workerLog(`[worker] could not send a ${message.type} message to the board: ${errorMessage(err)}`);
    }
  }

  /** #1383: a fresh git token after a 401, asked of the board and answered by `git_token`. */
  const gitTokens = createGitTokenRequester((message) => safeSend(message));

  /**
   * Delivering a finished result — retry, retain, persist, re-retry on reconnect — is its own
   * leaf (#899). It holds no runner state: everything it needs is right here in the argument
   * list, which is why it extracts at all.
   */
  const undelivered = createUndeliveredStore({
    workRoot,
    get boardUrl() { return boardUrlOf(options) ?? ""; },
    retryDelaysMs,
    push: repoOps.push,
    cleanup: repoOps.cleanup,
    safeSend,
    wait,
    refreshToken: gitTokens.request,
  });

  /**
   * The ledger of every id the board ever handed this worker (#887), which is what makes
   * `unknown` an authoritative answer rather than a guess. A leaf like the store above: it
   * holds no process, so it takes the process table as two injected questions.
   */
  const seen = createWorkerSessionRegistry({
    isLive: (sessionId) => processes.has(sessionId) || provisioning.has(sessionId),
    pidOf: (sessionId) => processes.get(sessionId)?.pid,
    stdinOpenOf: (sessionId) => stdinOpen.get(sessionId),
    safeSend,
  });

  /**
   * Answer one board-initiated repo operation on a LIVE session's checkout (#783, #784).
   *
   * Always answers, including when this worker has no such checkout (`no-session`): the
   * board BLOCKS on the reply — a follow-up turn is refused when the sync did not complete
   * — so a silent drop would turn a knowable refusal into a timeout.
   */
  function repoOp(op: WorkerRepoOpKind, sessionId: string, requestId: string, auth: WorkerRepoOpAuth): void {
    const answer = (outcome: WorkerRepoOpOutcome): void => {
      safeSend({ type: "repo_op_result", sessionId, result: { requestId, op, ...outcome } });
    };
    const pending = checkouts.get(sessionId);
    if (!pending) {
      answer({
        ok: false,
        status: "no-session",
        error:
          `this worker holds no git-transport checkout for session ${sessionId} ` +
          `(it never ran here, it has already exited, or its result was already pushed)`,
      });
      return;
    }
    if (!boardUrlOf(options)) {
      answer({ ok: false, status: "error", error: "worker has no board URL for git transport" });
      return;
    }
    void (async () => {
      try {
        const outcome = op === "sync"
          ? await repoOps.sync(boardUrlOf(options)!, auth, pending.checkout)
          : await repoOps.pushHead(boardUrlOf(options)!, auth, pending.checkout);
        answer(outcome);
      } catch (err) {
        answer({ ok: false, status: "error", error: errorMessage(err) });
      }
    })();
  }

  function emitExit(sessionId: string, exitCode: number | null): void {
    if (exited.has(sessionId)) return;
    exited.add(sessionId);
    seen.noteExit(sessionId, exitCode);
    const startedAt = agentStartedAtMs.get(sessionId);
    agentStartedAtMs.delete(sessionId);
    const agentMs = startedAt === undefined ? undefined : Date.now() - startedAt;
    processes.delete(sessionId);
    provisioning.delete(sessionId);
    stdinOpen.delete(sessionId);
    closeWatchdog(sessionId);
    tree.untrack(sessionId); releaseSessionTemp(sessionId);
    const pending = checkouts.get(sessionId);
    if (authWatch.exit(sessionId, exitCode, pending && (() => repoOps.cleanup(pending.checkout)))) {
      checkouts.delete(sessionId); // #1426: a launch failure, not a failed build
      return;
    }
    if (!pending) {
      // safeSend, not send: this runs synchronously on the child's `exit` event, where a
      // throw is a process-level uncaught exception (#870).
      safeSend({ type: "event", event: { type: "exit", sessionId, exitCode } });
      return;
    }
    // Git transport: the board must not see `exit` until the work is actually
    // pushed, otherwise review/merge would run against a branch that has not
    // arrived yet. Push failure is reported as stderr and downgrades the exit
    // code so the session is never recorded as a clean success.
    checkouts.delete(sessionId);
    const push = (async () => {
      let effectiveExit = exitCode;
      const pushStart = Date.now();
      try {
        const outcome = await undelivered.pushWithRetry(sessionId, pending);
        if (outcome.ok) {
          try {
            await repoOps.cleanup(pending.checkout);
          } catch { /* best-effort */ }
        } else {
          // #750/#775 item 2: the checkout is NOT removed. A `git worktree remove --force`
          // here leaves the commits only on the `kanban/<sessionId>` branch of the cache
          // clone, which nothing on either machine enumerates — so a failed push used to
          // cost the whole run in every practical sense.
          undelivered.retain(sessionId, pending, outcome);
          effectiveExit = exitCode === 0 || exitCode === null ? 1 : exitCode;
        }
      } catch (err) {
        // #870: NOTHING on this path may escape. This IIFE runs detached off the child's
        // exit event, so an exception here was an unhandled rejection — and observed live,
        // one failed push took the whole daemon (and every other agent on the machine)
        // down with "[run] daemon threw". Retain the result like any exhausted retry and
        // hand it to the #871 undelivered tracking; the daemon stays up.
        const message = errorMessage(err);
        workerLog(
          `[worker] result push path failed unexpectedly (daemon staying up): sessionId=${sessionId}: ${message}`,
        );
        try {
          undelivered.retain(sessionId, pending, { ok: false, attempts: 0, lastError: message });
        } catch (retainErr) {
          workerLog(`[worker] could not retain the unpushed result: sessionId=${sessionId}`, retainErr);
        }
        effectiveExit = exitCode === 0 || exitCode === null ? 1 : exitCode;
      }
      const phases: WorkerPhaseTimings = {
        ...pending.checkout.phases,
        ...(agentMs !== undefined ? { agentMs } : {}),
        pushMs: Date.now() - pushStart,
      };
      workerLog(`[worker] phases for session ${sessionId}: ${JSON.stringify(phases)}`);
      safeSend({ type: "event", event: { type: "exit", sessionId, exitCode: effectiveExit, phases } });
    })().finally(() => {
      inFlightPushes.delete(sessionId);
    });
    // Retained (#754) so a shutdown can WAIT for it. Errors are already handled inside,
    // so the stored promise never rejects — but attach a sink anyway: an unhandled
    // rejection here would take the daemon down with every other agent on it.
    inFlightPushes.set(sessionId, push.catch(() => {}));
  }

  /**
   * Git-transport assignment: clone/fetch from the board, carve a worktree, run
   * setup, then spawn the agent in that checkout. Provisioning is async, so the
   * session is marked running immediately and a provisioning failure is
   * reported as assign_failed (the board classifies it as a launch failure).
   */
  function assignWithRepo(sessionId: string, spec: WorkerLaunchSpec, repo: WorkerRepoTransport): void {
    // An exit, not assign_failed: the board ended this session and must not re-place it elsewhere (#1407).
    if (seen.noteAssigned(sessionId)) return emitExit(sessionId, null);
    if (processes.has(sessionId) || provisioning.has(sessionId)) {
      send({ type: "assign_failed", sessionId, error: "session already running on this worker" });
      return;
    }
    if (wouldExceedCapacity(sessionId)) {
      refuseAtCapacity(sessionId);
      return;
    }
    if (!boardUrlOf(options)) {
      send({ type: "assign_failed", sessionId, error: "worker has no board URL for git transport" });
      return;
    }
    provisioning.add(sessionId);
    exited.delete(sessionId);
    void (async () => {
      try {
        const checkout = await repoOps.provision(boardUrlOf(options)!, repo, sessionId, options.workRoot);
        if (!provisioning.has(sessionId)) {
          // Stopped while provisioning — do not launch; drop the checkout.
          await repoOps.cleanup(checkout).catch(() => {});
          return;
        }
        checkouts.set(sessionId, { checkout, repo });
        // The board composed cwd from ITS filesystem; the real cwd is here.
        // Stay in `provisioning` across this call so the capacity check sees the
        // slot this session already holds and cannot refuse it to itself (#266);
        // release it only once the process exists.
        // #799 — the board MCP bearer token for a provider configured through the ENVIRONMENT
        // (codex). It travels in its own field rather than in `spec.env`, which is projected
        // through an allowlist that deliberately drops anything token-shaped; putting it into
        // the child's environment is the WORKER's job, here, at the last moment before spawn.
        // Merged into `spec.env` (not `process.env`) so it reaches only this agent.
        assign(sessionId, {
          ...spec,
          cwd: checkout.cwd,
          ...(repo.boardMcpToken
            ? { env: { ...(spec.env ?? {}), [FLEET_MCP_TOKEN_ENV_VAR]: repo.boardMcpToken } }
            : {}),
        });
        provisioning.delete(sessionId);
      } catch (err) {
        provisioning.delete(sessionId);
        const message = errorMessage(err);
        workerLog(`[worker] repo provisioning failed: sessionId=${sessionId}: ${message}`);
        safeSend({ type: "assign_failed", sessionId, error: `repo provisioning failed: ${message}` });
      }
    })();
  }

  /**
   * #1455: an assign refused AFTER its checkout was provisioned (unknown profile, spawn failure)
   * never starts an agent, so nothing else would remove the worktree or its `kanban/<sessionId>`
   * branch — and the board re-places the SAME sessionId, whose next `worktree add -b` would then
   * collide on that branch. Best-effort, after the refusal has been sent.
   */
  function dropRefusedCheckout(sessionId: string): void {
    const pending = checkouts.get(sessionId);
    if (!pending) return;
    checkouts.delete(sessionId);
    void repoOps.cleanup(pending.checkout).catch(() => {});
  }

  function assign(sessionId: string, specAsSent: WorkerLaunchSpec): void {
    // An exit, not assign_failed: the board ended this session and must not re-place it elsewhere (#1407).
    if (seen.noteAssigned(sessionId)) return emitExit(sessionId, null);
    if (processes.has(sessionId)) {
      send({ type: "assign_failed", sessionId, error: "session already running on this worker" });
      return;
    }
    if (wouldExceedCapacity(sessionId)) {
      refuseAtCapacity(sessionId);
      return;
    }
    exited.delete(sessionId);
    authWatch.begin(sessionId, specAsSent.intent?.profile);

    // #1027: the board may PIN this launch to a profile NAME (never a credential — the
    // board has none of ours). Resolving the name is this machine's job, and so is
    // refusing it: an attestation can be stale, and running the assignment under some
    // other local login is exactly the silent fallback #651 refused remote dispatch to
    // prevent. A rejection reaches the board as a launch failure it can re-place.
    const resolvedProfile = applyProfileToSpec(specAsSent, { log: (line) => workerLog(line), ...profileResolveOptions(options) });
    if (!resolvedProfile.ok) {
      workerLog(`[worker] refusing assign: sessionId=${sessionId} ${resolvedProfile.error}`);
      send({ type: "assign_failed", sessionId, error: resolvedProfile.error });
      dropRefusedCheckout(sessionId);
      return;
    }
    // #1367: unless the worker runs in inherit mode, the session gets the worker's own clean
    // harness config dir, the stored token (if any) and `--strict-mcp-config`.
    const spec = applyHarnessToSpec(resolvedProfile.spec, options.harness);

    // #747: the board no longer decides how to invoke the agent on a machine it cannot
    // see. When the spec carries a launch INTENT, the executable and the shell decision are
    // resolved HERE, against this platform — which is what makes a mixed-OS fleet possible.
    const launch = resolveSpecCommand(spec);
    if (spec.intent) {
      workerLog(
        `[worker] resolved launch intent: sessionId=${sessionId} provider=${spec.intent.provider} ` +
        `program=${spec.intent.program} -> ${launch.command} (${launch.source}, shell=${launch.useShell})`,
      );
    }

    // #841 (closes the #836 remainder) — `detached: true`, POSIX-only, shell launches only.
    // On POSIX a `useShell` launch is `sh -c "<command>"`; a pipeline/`&&`/redirect leaves
    // `sh` a real parent (the #833 shape), so the child must LEAD its own process group for
    // `killProcessTree`'s `group: true` arm to reach it instead of falling back to the bare
    // (shell) pid. win32 is excluded: `detached: true` + `shell: true` measured HANGS there
    // (child never exits, stdout never closes) — the same combo `shouldDetachAgent` refuses
    // on the host, and the common Windows path here since `resolveSpecCommand` returns
    // `useShell: true` for every `.cmd`/`.bat`/`.ps1` shim. A detached child that outlives
    // the daemon (SIGKILL, crash) is unreapable — `stopAll()` still reaches it via the group
    // kill on a graceful shutdown, but there is no recovery otherwise; accepted, since the
    // alternative leaves the #833 gap open on every POSIX pipeline/`&&`/redirect launch.
    // #1336: on POSIX EVERY agent now leads its own process group (not just shell launches),
    // so a recorded pgid names the whole tree for the next daemon's startup sweep. On win32
    // the equivalent is the kill-on-close Job Object attached after the spawn below.
    let proc: ChildProcess;
    try {
      proc = spawn(launch.command, spec.args, {
        cwd: spec.cwd,
        // #244: MERGE the board's (allowlisted, non-secret) wiring over THIS
        // machine's environment — never replace it. The worker authenticates its
        // agent with its own local login, so HOME/USERPROFILE/PATH and the
        // provider config dir must stay this machine's (decision 012).
        env: { ...process.env, ...spec.env, ...startSessionTemp(sessionId) }, // #1391 per-session TMPDIR, applied LAST
        shell: launch.useShell,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      releaseSessionTemp(sessionId); send({ type: "assign_failed", sessionId, error: errorMessage(err) });
      dropRefusedCheckout(sessionId);
      return;
    }
    processes.set(sessionId, proc);
    agentStartedAtMs.set(sessionId, Date.now());
    workerLog(`[worker] launched agent: sessionId=${sessionId} pid=${proc.pid} command=${launch.command}`);
    if (proc.pid) tree.track(sessionId, proc.pid, spec.cwd);

    // Every byte of agent output proves liveness, so it resets the silence
    // watchdog armed below.
    const emitOutput = (type: "stdout" | "stderr", chunk: Buffer) => {
      const data = sanitizeUtf8(chunk.toString());
      if (!data) return;
      if (type === "stderr") stderrTails.set(sessionId, ((stderrTails.get(sessionId) ?? "") + data).slice(-2048));
      authWatch.noteOutput(sessionId, type, data);
      seen.noteOutput(sessionId);
      hangWatchdogs.get(sessionId)?.reset();
      // safeSend: this runs on the child's stream 'data' events, where a throw out of the
      // send seam is a process-level uncaught exception (#870).
      safeSend({ type: "event", event: { type, sessionId, data } });
    };
    proc.stdout?.on("data", (chunk: Buffer) => emitOutput("stdout", chunk));
    proc.stderr?.on("data", (chunk: Buffer) => emitOutput("stderr", chunk));
    // #754: an EPIPE on this pipe used to CRASH THE WHOLE DAEMON, orphaning every other
    // agent on the machine. An unhandled 'error' on a stream is a process-level uncaught
    // exception, and the write below is synchronous-throw-guarded only — the async EPIPE
    // that arrives when an agent exits before draining a large prompt (a bad flag, or a
    // provider CLI that is not logged in — the runbook's own "starts then fails
    // immediately" case) was never handled anywhere in worker/.
    proc.stdin?.on("error", (err: Error & { code?: string }) => {
      const expected = err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED";
      workerLog(
        `[worker] stdin ${err.code ?? "error"} for sessionId=${sessionId}` +
          (expected ? " (agent exited before reading its prompt)" : `: ${err.message}`),
      );
      // Not reported as session stderr: the agent's own exit and output are the real
      // evidence, and a synthesized line here would read like agent output that is not.
    });
    proc.on("error", (err) => {
      safeSend({ type: "event", event: { type: "stderr", sessionId, data: `Process error: ${err.message}` } });
      emitExit(sessionId, 1);
    });
    proc.on("exit", (code) => {
      workerLog(`[worker] agent exited: sessionId=${sessionId} code=${code}`);
      // #1383: a fast non-zero exit used to leave nothing in the worker log to say why.
      const startedAt = agentStartedAtMs.get(sessionId);
      if (code !== 0 && startedAt !== undefined && Date.now() - startedAt < FAST_EXIT_LOG_MS) {
        const tail = (stderrTails.get(sessionId) ?? "").trim().split(/\r?\n/).slice(-8).join(" | ");
        workerLog(
          `[worker] agent exited fast: sessionId=${sessionId} code=${code} after ${Date.now() - startedAt}ms; ` +
          `stderr tail: ${tail || "(none)"}`,
        );
      }
      stderrTails.delete(sessionId);
      emitExit(sessionId, code);
    });

    // Hang watchdog, mirroring the host spawn site: an agent that produces NO
    // output for the timeout is killed, and the kill drives the normal exit path
    // (push-back, then the exit event) so the board classifies it instead of the
    // session hanging "running" until a human notices. The board sets the policy
    // per assignment (0 for mock agents); absent, fall back to this machine's own
    // setting. Without this a remote session silently lost the protection its
    // host twin has.
    const hangTimeoutMs = spec.hangTimeoutMs ?? resolveAgentHangTimeoutMs();
    if (hangTimeoutMs > 0) {
      hangWatchdogs.set(sessionId, startHangWatchdog(`sessionId=${sessionId}`, hangTimeoutMs, () => {
        const seconds = Math.round(hangTimeoutMs / 1000);
        workerLog(`[worker] hang watchdog fired: sessionId=${sessionId} pid=${proc.pid} - no output for ${seconds}s; killing`);
        safeSend({
          type: "event",
          event: {
            type: "stderr",
            sessionId,
            data: `Agent hang watchdog: no output for ${seconds}s - process killed on worker.`,
          },
        });
        stop(sessionId);
      }));
    }

    // Same stdin contract as agent.service.writeInitialStdin: argv-prompt agents
    // get stdin closed untouched; multi-turn keeps it open; default is
    // write-and-close (Windows claude.exe buffers stdout until stdin closes).
    // Guarded because a process that is ALREADY gone throws synchronously here, while one
    // that dies mid-write emits on the handler above (#754). Both are normal.
    try {
      if (spec.suppressStdinPrompt) {
        proc.stdin?.end();
      } else if (spec.keepStdinOpen) {
        proc.stdin?.write((spec.stdinPrompt ?? "") + "\n");
      } else {
        proc.stdin?.end((spec.stdinPrompt ?? "") + "\n");
      }
    } catch (err) {
      workerLog(`[worker] could not write the prompt to sessionId=${sessionId}: ${errorMessage(err)}`);
    }
    // #900: mirrors the board's own `Boolean(config.keepStdinOpen && !config.suppressStdinPrompt)`
    // (agent-remote.service.ts) — the same rule, recorded on the machine that actually holds
    // the pipe, so a `probe_session` answer for a session ADOPTED after a board restart is
    // trustworthy even though the board's own copy of this flag died with the old process.
    stdinOpen.set(sessionId, Boolean(spec.keepStdinOpen && !spec.suppressStdinPrompt));
  }

  function input(sessionId: string, data: string): boolean {
    const proc = processes.get(sessionId);
    if (!proc?.stdin || proc.stdin.destroyed) return false;
    try {
      return proc.stdin.write(data.endsWith("\n") ? data : data + "\n");
    } catch (err) {
      workerLog(`[worker] input write failed: sessionId=${sessionId}`, err);
      return false;
    }
  }

  function closeStdin(sessionId: string): boolean {
    stdinOpen.set(sessionId, false);
    const proc = processes.get(sessionId);
    if (!proc?.stdin || proc.stdin.destroyed) return false;
    proc.stdin.end();
    return true;
  }

  function stop(sessionId: string): boolean {
    const proc = processes.get(sessionId);
    if (!proc?.pid) {
      // Stop during repo provisioning: cancel before the agent is launched.
      closeWatchdog(sessionId);
      if (provisioning.delete(sessionId)) {
        workerLog(`[worker] cancelled provisioning session: sessionId=${sessionId}`);
        emitExit(sessionId, null);
        return true;
      }
      // Nothing running and nothing provisioning: either a long-gone session or one whose
      // assign has not arrived yet (#1407). Remember it unless it already exited here.
      return seen.noteStopped(sessionId);
    }
    workerLog(`[worker] stopping agent: sessionId=${sessionId} pid=${proc.pid}`);
    // #836: through the ONE kill seam (#832/#833) rather than a private
    // `process.platform` branch. What that buys is not reach — see the header note above
    // `assign`'s spawn — but assertability: the platform decision lives inside
    // `killProcessTree`, so a test can mock the seam and pin the arguments on EITHER
    // platform. The branch this replaced had the pre-#833 shape exactly: a win32 arm
    // spawning `taskkill` and a POSIX arm calling `proc.kill` directly, which no test on
    // this repo's Windows box could ever observe.
    //
    // `signal: "SIGTERM"` matters independently: the seam defaults to SIGKILL, and a
    // stopped agent is asked to shut down (so its provider CLI can flush a transcript),
    // not shot. Fire-and-forget with the host `killPid`'s error contract — `stop()` is
    // synchronous for `stopAll()` and the hang watchdog, and an already-dead process is
    // not a failure worth logging.
    const pid = proc.pid;
    void killProcessTree(pid, { timeout: 5000, signal: "SIGTERM", group: true }).catch((err) => {
      if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return; // already gone
      workerLog(`[worker] kill failed: sessionId=${sessionId} pid=${pid}`, err);
    });
    return true;
  }

  function stopAll(): void {
    for (const sessionId of [...processes.keys(), ...provisioning]) stop(sessionId);
  }

  /** `--leave-agents` (#1336): the agent trees survive this daemon ON PURPOSE. */
  const releaseAgents = (): void => tree.release([...processes.keys()]);

  function runningSessionIds(): string[] {
    return [...new Set([...processes.keys(), ...provisioning])];
  }

  /**
   * Wait for every in-flight result push, up to `timeoutMs` (#754).
   *
   * Reports what it saved and what it abandoned rather than just resolving: a shutdown
   * that lost a completed agent's work must SAY so, because the board's only other signal
   * is a 60 s disconnect grace that finalizes the session as a failure.
   *
   * A push that starts AFTER the deadline (an agent killed at the very end of the window)
   * is not waited for — bounding the wait is the point, and the ceiling is the operator's.
   */
  async function drainPushes(timeoutMs: number): Promise<{ completed: number; abandoned: number }> {
    // #750: stop waiting out retry backoffs. The attempt in flight still finishes, and a
    // result that ends up unpushed is retained (with its checkout) rather than deleted.
    undelivered.suspendRetries();
    const started = inFlightPushes.size;
    if (started === 0) return { completed: 0, abandoned: 0 };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (timer.unref) timer.unref();
    });
    // Re-read the map each round: an agent killed by stopAll() reaches its exit handler
    // (and therefore starts its push) only after this function is already waiting.
    while (inFlightPushes.size > 0) {
      const outcome = await Promise.race([Promise.allSettled([...inFlightPushes.values()]), deadline]);
      if (outcome === "timeout") break;
    }
    if (timer) clearTimeout(timer);
    const abandoned = inFlightPushes.size;
    return { completed: started - abandoned, abandoned };
  }

  /** How many result pushes are in flight right now. For tests and diagnostics. */
  function pendingPushCount(): number {
    return inFlightPushes.size;
  }

  return {
    // #1381: setMaxConcurrency = the board changed this worker's ceiling; running sessions are never stopped by it.
    setMaxConcurrency: (n: number): void => { if (n > 0) maxConcurrency = n; }, assign, assignWithRepo, input, closeStdin, stop, stopAll, releaseAgents, runningSessionIds,
    drainPushes, pendingPushCount, repoOp, gitToken: gitTokens.answer, checkoutCwd: (sid: string): string | undefined => checkouts.get(sid)?.checkout.cwd, // #1447
    probeSession: seen.answerProbe, rememberedSessionCount: seen.size,
    retryPendingPushes: undelivered.retryPending,
    unpushedResults: undelivered.list, lostResults: undelivered.listLost,
  };
}

export type WorkerAgentRunner = ReturnType<typeof createWorkerAgentRunner>;

// Re-exported so existing importers keep their path; the declarations moved to the
// retention leaf (#899), which is where they are actually used.
export type { PushOutcome, UnpushedResult };

/** ws's RawData is Buffer | ArrayBuffer | Buffer[]; a bare `.toString()` on the array case yields garbage. */
export function rawDataToBuffer(data: unknown): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data as readonly Uint8Array[]);
  return Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data as ArrayBuffer));
}

/** Route one parsed board frame to the agent runner. Throws propagate to the caller's guard (#870). */
export function dispatchBoardMessage(
  message: BoardToWorkerMessage,
  runner: WorkerAgentRunner,
  sendToBoard: (message: WorkerToBoardMessage) => void,
  draining: boolean,
): void {
  switch (message.type) {
    case "assign":
      // #1338: a draining daemon (an update waiting for its last session) takes no new
      // work — the board stops assigning on its next heartbeat, this covers the race.
      if (draining) {
        sendToBoard({ type: "assign_failed", sessionId: message.sessionId, error: "worker is draining (self-update or shutdown in progress)" });
        break;
      }
      if (message.repo) runner.assignWithRepo(message.sessionId, message.spec, message.repo);
      else runner.assign(message.sessionId, message.spec);
      break;
    case "input":
      runner.input(message.sessionId, message.data);
      break;
    case "close_stdin":
      runner.closeStdin(message.sessionId);
      break;
    case "stop":
      runner.stop(message.sessionId);
      break;
    case "sync_repo":
      runner.repoOp("sync", message.sessionId, message.requestId, message.auth);
      break;
    case "push_head":
      runner.repoOp("push", message.sessionId, message.requestId, message.auth);
      break;
    case "git_token":
      runner.gitToken(message.requestId, message.gitToken ?? null);
      break;
    case "probe_session":
      runner.probeSession(message.sessionId, message.requestId);
      break;
  }
}
