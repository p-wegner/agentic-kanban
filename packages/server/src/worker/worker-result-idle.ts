// #1464: end a remote agent that lingers after its final `result` event. Extracted from
// createWorkerAgentRunner (nloc ratchet). Node builtins only — the worker binary is bounded
// by worker-cli-isolation.

import type { ChildProcess } from "node:child_process";
import { workerLog } from "./worker-updater.js";

export interface ResultIdleDeps {
  graceMs: number;
  getProcess: (sessionId: string) => ChildProcess | undefined;
  /** The worker closed this session's stdin itself. */
  onStdinClosed: (sessionId: string) => void;
  stop: (sessionId: string) => unknown;
}

export function createResultIdleTracker({ graceMs, getProcess, onStdinClosed, stop }: ResultIdleDeps) {
  /** Sessions whose last stdout event was a `result` (final turn over) — idle there means DONE. */
  const resultSeen = new Set<string>();
  const resultTimers = new Map<string, NodeJS.Timeout>();
  const stdoutPartials = new Map<string, string>();
  /** Sessions the worker itself ended (grace or hang watchdog) after a result event. */
  const killedAfterResult = new Set<string>();

  /** Forget everything the idle-after-result logic knows about a session. */
  function clear(sessionId: string): void {
    const timer = resultTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    resultTimers.delete(sessionId);
    resultSeen.delete(sessionId);
    stdoutPartials.delete(sessionId);
    killedAfterResult.delete(sessionId);
  }

  /**
   * Scan a stdout chunk for stream-json events. A `result` event means the agent's final
   * turn is over; any other event after it means the agent is still working (a new turn).
   */
  function noteStdout(sessionId: string, data: string): void {
    const buffered = (stdoutPartials.get(sessionId) ?? "") + data;
    const lines = buffered.split("\n");
    stdoutPartials.set(sessionId, (lines.pop() ?? "").slice(-65536));
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      if (/"type"\s*:\s*"result"/.test(line.slice(0, 4096)) || /"type"\s*:\s*"result"/.test(line.slice(-512))) {
        try {
          if ((JSON.parse(line) as { type?: unknown }).type === "result") {
            resultSeen.add(sessionId);
            continue;
          }
        } catch { /* not a complete event; treat as other output */ }
      }
      resultSeen.delete(sessionId);
    }
  }

  /** (Re)arm the grace timer after a result event; any later output re-arms it from scratch. */
  function arm(sessionId: string): void {
    const old = resultTimers.get(sessionId);
    if (old) clearTimeout(old);
    resultTimers.delete(sessionId);
    if (!resultSeen.has(sessionId) || graceMs <= 0) return;
    const timer = setTimeout(() => {
      resultTimers.delete(sessionId);
      const proc = getProcess(sessionId);
      if (!proc || !resultSeen.has(sessionId)) return;
      workerLog(`[worker] session ${sessionId} idle ${graceMs}ms after its result event; ending it (completed)`);
      killedAfterResult.add(sessionId);
      try { proc.stdin?.end(); } catch { /* already closed */ }
      onStdinClosed(sessionId);
      // stdin EOF is the polite ask; a process that ignores it gets SIGTERM shortly after.
      const killTimer = setTimeout(() => {
        if (getProcess(sessionId) === proc) stop(sessionId);
      }, Math.min(5_000, graceMs));
      if (killTimer.unref) killTimer.unref();
    }, graceMs);
    if (timer.unref) timer.unref();
    resultTimers.set(sessionId, timer);
  }

  /**
   * The hang watchdog fired. Idle after the final result is DONE, not hung: returns the stderr
   * note to surface (and records the session as completed), or undefined when it really hung.
   */
  function hangCompletion(sessionId: string, seconds: number): string | undefined {
    if (!resultSeen.has(sessionId)) return undefined;
    killedAfterResult.add(sessionId);
    workerLog(`[worker] session ${sessionId} completed (killed idle after result) after ${seconds}s of silence`);
    return `Session completed (killed idle after result): no output for ${seconds}s after the final result event.`;
  }

  /** A process the worker ended idle after its result FINISHED — the signal exit code is ours, not the agent's verdict. */
  function shouldRecordCompleted(sessionId: string, code: number | null): boolean {
    if (!killedAfterResult.has(sessionId) || !resultSeen.has(sessionId) || code === 0) return false;
    workerLog(`[worker] session ${sessionId} completed (killed idle after result); recording exit 0 instead of ${code}`);
    return true;
  }

  return { clear, noteStdout, arm, hangCompletion, shouldRecordCompleted };
}
