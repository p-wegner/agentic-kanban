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
import type { WorkerLaunchSpec, WorkerRepoTransport, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  provisionWorkerCheckout,
  pushWorkerResult,
  cleanupWorkerCheckout,
  type WorkerCheckout,
} from "./worker-repo.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
}

/**
 * Reason string for a refusal caused by this worker's own capacity ceiling (#266).
 * Distinguishable on purpose: the board must be able to tell "this machine is full"
 * (place elsewhere, release the pending slot) apart from a launch failure.
 */
export const ASSIGN_REFUSED_AT_CAPACITY = "worker at capacity";

export function createWorkerAgentRunner(send: SendToBoard, options: WorkerAgentRunnerOptions = {}) {
  const processes = new Map<string, ChildProcess>();
  const exited = new Set<string>();
  /** Sessions whose work lives in a worker-side checkout that must be pushed back. */
  const checkouts = new Map<string, { checkout: WorkerCheckout; repo: WorkerRepoTransport }>();
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

  function emitExit(sessionId: string, exitCode: number | null): void {
    if (exited.has(sessionId)) return;
    exited.add(sessionId);
    processes.delete(sessionId);
    provisioning.delete(sessionId);
    closeWatchdog(sessionId);
    const pending = checkouts.get(sessionId);
    if (!pending) {
      send({ type: "event", event: { type: "exit", sessionId, exitCode } });
      return;
    }
    // Git transport: the board must not see `exit` until the work is actually
    // pushed, otherwise review/merge would run against a branch that has not
    // arrived yet. Push failure is reported as stderr and downgrades the exit
    // code so the session is never recorded as a clean success.
    checkouts.delete(sessionId);
    void (async () => {
      let effectiveExit = exitCode;
      try {
        await pushWorkerResult(options.boardUrl ?? "", pending.repo, pending.checkout);
        console.log(`[worker] pushed session result: sessionId=${sessionId} ref=${pending.repo.incomingRef}`);
      } catch (err) {
        const message = errorMessage(err);
        console.error(`[worker] push failed: sessionId=${sessionId}: ${message}`);
        send({ type: "event", event: { type: "stderr", sessionId, data: `Worker could not push its result: ${message}` } });
        effectiveExit = exitCode === 0 || exitCode === null ? 1 : exitCode;
      }
      try {
        await cleanupWorkerCheckout(pending.checkout);
      } catch { /* best-effort */ }
      send({ type: "event", event: { type: "exit", sessionId, exitCode: effectiveExit } });
    })();
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
        const checkout = await provisionWorkerCheckout(options.boardUrl!, repo, sessionId, options.workRoot);
        if (!provisioning.has(sessionId)) {
          // Stopped while provisioning — do not launch; drop the checkout.
          await cleanupWorkerCheckout(checkout).catch(() => {});
          return;
        }
        checkouts.set(sessionId, { checkout, repo });
        // The board composed cwd from ITS filesystem; the real cwd is here.
        // Stay in `provisioning` across this call so the capacity check sees the
        // slot this session already holds and cannot refuse it to itself (#266);
        // release it only once the process exists.
        assign(sessionId, { ...spec, cwd: checkout.cwd });
        provisioning.delete(sessionId);
      } catch (err) {
        provisioning.delete(sessionId);
        const message = errorMessage(err);
        console.error(`[worker] repo provisioning failed: sessionId=${sessionId}: ${message}`);
        send({ type: "assign_failed", sessionId, error: `repo provisioning failed: ${message}` });
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

    let proc: ChildProcess;
    try {
      proc = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        // #244: MERGE the board's (allowlisted, non-secret) wiring over THIS
        // machine's environment — never replace it. The worker authenticates its
        // agent with its own local login, so HOME/USERPROFILE/PATH and the
        // provider config dir must stay this machine's (decision 012).
        env: { ...process.env, ...spec.env },
        shell: spec.useShell ?? false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      send({ type: "assign_failed", sessionId, error: errorMessage(err) });
      return;
    }
    processes.set(sessionId, proc);
    console.log(`[worker] launched agent: sessionId=${sessionId} pid=${proc.pid} command=${spec.command}`);

    // Every byte of agent output proves liveness, so it resets the silence
    // watchdog armed below.
    const emitOutput = (type: "stdout" | "stderr", chunk: Buffer) => {
      const data = sanitizeUtf8(chunk.toString());
      if (!data) return;
      hangWatchdogs.get(sessionId)?.reset();
      send({ type: "event", event: { type, sessionId, data } });
    };
    proc.stdout?.on("data", (chunk: Buffer) => emitOutput("stdout", chunk));
    proc.stderr?.on("data", (chunk: Buffer) => emitOutput("stderr", chunk));
    proc.on("error", (err) => {
      send({ type: "event", event: { type: "stderr", sessionId, data: `Process error: ${err.message}` } });
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
        send({
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
    if (spec.suppressStdinPrompt) {
      proc.stdin?.end();
    } else if (spec.keepStdinOpen) {
      proc.stdin?.write((spec.stdinPrompt ?? "") + "\n");
    } else {
      proc.stdin?.end((spec.stdinPrompt ?? "") + "\n");
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
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { shell: true, windowsHide: true });
    } else {
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        console.warn(`[worker] kill failed: sessionId=${sessionId}`, err);
      }
    }
    return true;
  }

  function stopAll(): void {
    for (const sessionId of [...processes.keys(), ...provisioning]) stop(sessionId);
  }

  function runningSessionIds(): string[] {
    return [...new Set([...processes.keys(), ...provisioning])];
  }

  return { assign, assignWithRepo, input, closeStdin, stop, stopAll, runningSessionIds };
}

export type WorkerAgentRunner = ReturnType<typeof createWorkerAgentRunner>;
