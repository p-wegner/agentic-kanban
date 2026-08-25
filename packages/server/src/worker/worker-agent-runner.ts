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

import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { resolveAgentHangTimeoutMs, startHangWatchdog } from "../lib/agent-launch-env.js";
import { killProcessTree } from "../services/process-exec.js";
import type {
  WorkerLaunchSpec,
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
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { resolveSpecCommand } from "./worker-command-resolver.js";
import { FLEET_MCP_TOKEN_ENV_VAR } from "@agentic-kanban/shared/lib/worker-protocol";

export type SendToBoard = (message: WorkerToBoardMessage) => void;

export interface WorkerAgentRunnerOptions {
  /** Board base URL — required to compose git-transport URLs for repo assignments. */
  boardUrl?: string;
  workRoot?: string;
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
  const exited = new Set<string>();
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
  /** Per-session silence watchdogs; reset on every byte of agent output. */
  const hangWatchdogs = new Map<string, { reset(): void; close(): void }>();
  const maxConcurrency = options.maxConcurrency && options.maxConcurrency > 0 ? options.maxConcurrency : 1;

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
    console.warn(
      `[worker] refusing assign: sessionId=${sessionId} would exceed maxConcurrency=${maxConcurrency} (in use: ${occupiedSlots()})`,
    );
    send({ type: "assign_failed", sessionId, error: ASSIGN_REFUSED_AT_CAPACITY });
  }

  function closeWatchdog(sessionId: string): void {
    const watchdog = hangWatchdogs.get(sessionId);
    if (watchdog) {
      watchdog.close();
      hangWatchdogs.delete(sessionId);
    }
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
      console.error(`[worker] could not send a ${message.type} message to the board: ${errorMessage(err)}`);
    }
  }

  /**
   * Delivering a finished result — retry, retain, persist, re-retry on reconnect — is its own
   * leaf (#899). It holds no runner state: everything it needs is right here in the argument
   * list, which is why it extracts at all.
   */
  const undelivered = createUndeliveredStore({
    workRoot,
    boardUrl: options.boardUrl ?? "",
    retryDelaysMs,
    push: repoOps.push,
    cleanup: repoOps.cleanup,
    safeSend,
    wait,
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
    if (!options.boardUrl) {
      answer({ ok: false, status: "error", error: "worker has no board URL for git transport" });
      return;
    }
    void (async () => {
      try {
        const outcome = op === "sync"
          ? await repoOps.sync(options.boardUrl!, auth, pending.checkout)
          : await repoOps.pushHead(options.boardUrl!, auth, pending.checkout);
        answer(outcome);
      } catch (err) {
        answer({ ok: false, status: "error", error: errorMessage(err) });
      }
    })();
  }

  function emitExit(sessionId: string, exitCode: number | null): void {
    if (exited.has(sessionId)) return;
    exited.add(sessionId);
    processes.delete(sessionId);
    provisioning.delete(sessionId);
    closeWatchdog(sessionId);
    const pending = checkouts.get(sessionId);
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
        console.error(
          `[worker] result push path failed unexpectedly (daemon staying up): sessionId=${sessionId}: ${message}`,
        );
        try {
          undelivered.retain(sessionId, pending, { ok: false, attempts: 0, lastError: message });
        } catch (retainErr) {
          console.error(`[worker] could not retain the unpushed result: sessionId=${sessionId}`, retainErr);
        }
        effectiveExit = exitCode === 0 || exitCode === null ? 1 : exitCode;
      }
      safeSend({ type: "event", event: { type: "exit", sessionId, exitCode: effectiveExit } });
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
    if (processes.has(sessionId) || provisioning.has(sessionId)) {
      send({ type: "assign_failed", sessionId, error: "session already running on this worker" });
      return;
    }
    if (wouldExceedCapacity(sessionId)) {
      refuseAtCapacity(sessionId);
      return;
    }
    if (!options.boardUrl) {
      send({ type: "assign_failed", sessionId, error: "worker has no board URL for git transport" });
      return;
    }
    provisioning.add(sessionId);
    exited.delete(sessionId);
    void (async () => {
      try {
        const checkout = await repoOps.provision(options.boardUrl!, repo, sessionId, options.workRoot);
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
        console.error(`[worker] repo provisioning failed: sessionId=${sessionId}: ${message}`);
        safeSend({ type: "assign_failed", sessionId, error: `repo provisioning failed: ${message}` });
      }
    })();
  }

  function assign(sessionId: string, spec: WorkerLaunchSpec): void {
    if (processes.has(sessionId)) {
      send({ type: "assign_failed", sessionId, error: "session already running on this worker" });
      return;
    }
    if (wouldExceedCapacity(sessionId)) {
      refuseAtCapacity(sessionId);
      return;
    }
    exited.delete(sessionId);

    // #747: the board no longer decides how to invoke the agent on a machine it cannot
    // see. When the spec carries a launch INTENT, the executable and the shell decision are
    // resolved HERE, against this platform — which is what makes a mixed-OS fleet possible.
    const launch = resolveSpecCommand(spec);
    if (spec.intent) {
      console.log(
        `[worker] resolved launch intent: sessionId=${sessionId} provider=${spec.intent.provider} ` +
        `program=${spec.intent.program} -> ${launch.command} (${launch.source}, shell=${launch.useShell})`,
      );
    }

    // #836 — why there is no `detached: true` here, and what that costs.
    //
    // On POSIX a `useShell` launch makes the child `sh -c "<command>"`. `sh` execs through
    // for a single simple command, but a pipeline, an `&&` or a trailing redirect leaves it
    // a real parent — the #833 shape. Closing that needs the child to LEAD its own process
    // group (`detached: true`), because `killProcessTree`'s `group` arm signals `-pid` and
    // falls back to the bare pid on ESRCH when there is no such group. So `group: true` in
    // `stop()` below is honest but currently INERT on POSIX: it is the seam call the fix
    // needs, not the fix itself.
    //
    // Detaching was rejected here, for reasons that are the worker's and not the host's:
    //   - **Measured**: `detached: true` + `shell: true` on win32 hangs — the child never
    //     reaches its `exit` and its piped stdout never closes (a 4-cell probe of
    //     detached x shell; the other three cells stream and exit normally). That is the
    //     same combination `shouldDetachAgent` refuses on the host, and on THIS module it is
    //     the common Windows path: `resolveSpecCommand` returns `useShell: true` for every
    //     `.cmd`/`.bat`/`.ps1` shim. Any detach here must therefore be POSIX-gated.
    //   - A POSIX-gated detach cannot be exercised on the board's Windows box at all, and it
    //     contradicts this module's stated invariant (see the file header): the daemon owns
    //     its children for their whole life — there is no pid persistence and no reattach, so
    //     a child that outlives the daemon is unreapable and its output conduit is gone.
    //   - The exposure is narrow. `resolveSpecCommand` returns `useShell: false` for EVERY
    //     intent-carrying spec on POSIX, so the shell only appears for a same-filesystem or
    //     legacy-board spec that sent `useShell` verbatim.
    // Detaching POSIX-only, verified on Linux, is tracked as #841 (and #834 is the Linux CI
    // run that would give it evidence).
    let proc: ChildProcess;
    try {
      proc = spawn(launch.command, spec.args, {
        cwd: spec.cwd,
        // #244: MERGE the board's (allowlisted, non-secret) wiring over THIS
        // machine's environment — never replace it. The worker authenticates its
        // agent with its own local login, so HOME/USERPROFILE/PATH and the
        // provider config dir must stay this machine's (decision 012).
        env: { ...process.env, ...spec.env },
        shell: launch.useShell,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      send({ type: "assign_failed", sessionId, error: errorMessage(err) });
      return;
    }
    processes.set(sessionId, proc);
    console.log(`[worker] launched agent: sessionId=${sessionId} pid=${proc.pid} command=${launch.command}`);

    // Every byte of agent output proves liveness, so it resets the silence
    // watchdog armed below.
    const emitOutput = (type: "stdout" | "stderr", chunk: Buffer) => {
      const data = sanitizeUtf8(chunk.toString());
      if (!data) return;
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
      console.warn(
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
      console.log(`[worker] agent exited: sessionId=${sessionId} code=${code}`);
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
        console.warn(`[worker] hang watchdog fired: sessionId=${sessionId} pid=${proc.pid} — no output for ${seconds}s; killing`);
        safeSend({
          type: "event",
          event: {
            type: "stderr",
            sessionId,
            data: `Agent hang watchdog: no output for ${seconds}s — process killed on worker.`,
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
      console.warn(`[worker] could not write the prompt to sessionId=${sessionId}: ${errorMessage(err)}`);
    }
  }

  function input(sessionId: string, data: string): boolean {
    const proc = processes.get(sessionId);
    if (!proc?.stdin || proc.stdin.destroyed) return false;
    try {
      return proc.stdin.write(data.endsWith("\n") ? data : data + "\n");
    } catch (err) {
      console.error(`[worker] input write failed: sessionId=${sessionId}`, err);
      return false;
    }
  }

  function closeStdin(sessionId: string): boolean {
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
        console.log(`[worker] cancelled provisioning session: sessionId=${sessionId}`);
        emitExit(sessionId, null);
        return true;
      }
      return false;
    }
    console.log(`[worker] stopping agent: sessionId=${sessionId} pid=${proc.pid}`);
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
      console.warn(`[worker] kill failed: sessionId=${sessionId} pid=${pid}`, err);
    });
    return true;
  }

  function stopAll(): void {
    for (const sessionId of [...processes.keys(), ...provisioning]) stop(sessionId);
  }

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
    assign, assignWithRepo, input, closeStdin, stop, stopAll, runningSessionIds,
    drainPushes, pendingPushCount, repoOp,
    retryPendingPushes: undelivered.retryPending,
    unpushedResults: undelivered.list,
  };
}

export type WorkerAgentRunner = ReturnType<typeof createWorkerAgentRunner>;

// Re-exported so existing importers keep their path; the declarations moved to the
// retention leaf (#899), which is where they are actually used.
export type { PushOutcome, UnpushedResult };
