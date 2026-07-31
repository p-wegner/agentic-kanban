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
import type { WorkerLaunchSpec, WorkerRepoTransport, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  provisionWorkerCheckout,
  pushWorkerResult,
  cleanupWorkerCheckout,
  type WorkerCheckout,
} from "./worker-repo.js";

export type SendToBoard = (message: WorkerToBoardMessage) => void;

export interface WorkerAgentRunnerOptions {
  /** Board base URL — required to compose git-transport URLs for repo assignments. */
  boardUrl?: string;
  workRoot?: string;
}

export function createWorkerAgentRunner(send: SendToBoard, options: WorkerAgentRunnerOptions = {}) {
  const processes = new Map<string, ChildProcess>();
  const exited = new Set<string>();
  /** Sessions whose work lives in a worker-side checkout that must be pushed back. */
  const checkouts = new Map<string, { checkout: WorkerCheckout; repo: WorkerRepoTransport }>();
  /** Sessions provisioning a checkout — running for bookkeeping before a pid exists. */
  const provisioning = new Set<string>();

  function emitExit(sessionId: string, exitCode: number | null): void {
    if (exited.has(sessionId)) return;
    exited.add(sessionId);
    processes.delete(sessionId);
    provisioning.delete(sessionId);
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
        const message = err instanceof Error ? err.message : String(err);
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
        provisioning.delete(sessionId);
        // The board composed cwd from ITS filesystem; the real cwd is here.
        assign(sessionId, { ...spec, cwd: checkout.cwd });
      } catch (err) {
        provisioning.delete(sessionId);
        const message = err instanceof Error ? err.message : String(err);
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
    exited.delete(sessionId);

    let proc: ChildProcess;
    try {
      proc = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: spec.useShell ?? false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      send({ type: "assign_failed", sessionId, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    processes.set(sessionId, proc);
    console.log(`[worker] launched agent: sessionId=${sessionId} pid=${proc.pid} command=${spec.command}`);

    proc.stdout?.on("data", (chunk: Buffer) => {
      const data = sanitizeUtf8(chunk.toString());
      if (data) send({ type: "event", event: { type: "stdout", sessionId, data } });
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const data = sanitizeUtf8(chunk.toString());
      if (data) send({ type: "event", event: { type: "stderr", sessionId, data } });
    });
    proc.on("error", (err) => {
      send({ type: "event", event: { type: "stderr", sessionId, data: `Process error: ${err.message}` } });
      emitExit(sessionId, 1);
    });
    proc.on("exit", (code) => {
      console.log(`[worker] agent exited: sessionId=${sessionId} code=${code}`);
      emitExit(sessionId, code);
    });

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
