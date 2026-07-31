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
import type { WorkerLaunchSpec, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

export type SendToBoard = (message: WorkerToBoardMessage) => void;

export function createWorkerAgentRunner(send: SendToBoard) {
  const processes = new Map<string, ChildProcess>();
  const exited = new Set<string>();

  function emitExit(sessionId: string, exitCode: number | null): void {
    if (exited.has(sessionId)) return;
    exited.add(sessionId);
    processes.delete(sessionId);
    send({ type: "event", event: { type: "exit", sessionId, exitCode } });
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
    if (!proc?.pid) return false;
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
    for (const sessionId of [...processes.keys()]) stop(sessionId);
  }

  function runningSessionIds(): string[] {
    return [...processes.keys()];
  }

  return { assign, input, closeStdin, stop, stopAll, runningSessionIds };
}

export type WorkerAgentRunner = ReturnType<typeof createWorkerAgentRunner>;
