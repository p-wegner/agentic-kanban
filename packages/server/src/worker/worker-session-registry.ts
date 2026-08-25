/**
 * Every `sessionId` this worker was ever told about, and what became of it (#887).
 *
 * The board cannot tell "the assignment never arrived" from "the agent is working
 * silently": zero output is not evidence either way, which is why it waits. Measured, it
 * waited 100 minutes on a session whose id appears NOWHERE in the worker's log — not even
 * on the "resolved launch intent" line the worker writes BEFORE spawning. The assignment
 * was lost in transit and the board spent an hour and a half treating a non-event as
 * possible progress.
 *
 * This module is what makes the cheap answer possible. The worker remembers every id it
 * was handed, so `unknown` is an AUTHORITATIVE never-started answer in a way "no output"
 * can never be — a fact rather than a timeout's guess. It is a leaf on purpose: it holds
 * no process, spawns nothing, and reaches no socket, so the runner keeps the process table
 * and this keeps the ledger.
 *
 * **Bounded, and the bound is why an eviction cannot lie.** Entries are kept newest-first
 * up to {@link MAX_REMEMBERED}; past that the oldest is dropped, and a dropped id would
 * answer `unknown` when the truthful answer is "I have forgotten". That is safe here only
 * because of WHEN the board probes: within minutes of the assign, while the entry is at
 * the head of the map. An id that has been pushed out by a thousand later assignments is
 * not one any live probe is asking about.
 */

import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

/** How many session ids this worker remembers. See the module header for why a bound is safe. */
export const MAX_REMEMBERED = 1000;

interface SessionRecord {
  startedAtMs: number;
  lastOutputAtMs?: number;
  exitCode?: number | null;
  exitedAtMs?: number;
}

/** How a probe was answered, for the daemon's log and for tests. */
export interface SessionProbeAnswer {
  state: "unknown" | "running" | "exited";
  pid?: number;
  startedAtMs?: number;
  lastOutputAtMs?: number;
  exitCode?: number | null;
  exitedAtMs?: number;
  /** `running` only (#900): can this session still receive stdin input right now? */
  stdinOpen?: boolean;
}

export interface SessionRegistryDeps {
  /** The runner's never-throwing send — this answers the board directly (see `answerProbe`). */
  safeSend: (message: WorkerToBoardMessage) => void;
  /** Is the session live on this worker right now (spawned, or provisioning its checkout)? */
  isLive: (sessionId: string) => boolean;
  /** The agent's pid, when one exists. Absent while a git-transport checkout is provisioning. */
  pidOf: (sessionId: string) => number | undefined;
  /**
   * Can this session's stdin still receive input (#900)? Undefined = the caller does not
   * track this (an older embedding, or a test) — omitted from the answer rather than
   * guessed, since a wrong `true` here is what makes a board deliver a turn into a dead pipe.
   */
  stdinOpenOf?: (sessionId: string) => boolean | undefined;
  /** Injectable clock (`nowMs`, the sanctioned spelling for arithmetic). */
  nowMs?: () => number;
}

export function createWorkerSessionRegistry(deps: SessionRegistryDeps) {
  const records = new Map<string, SessionRecord>();

  /** Remember an id the board handed us. Idempotent: a re-assign must not restart the clock. */
  function noteAssigned(sessionId: string, nowMs: number = Date.now()): void {
    if (records.has(sessionId)) return;
    records.set(sessionId, { startedAtMs: nowMs });
    while (records.size > MAX_REMEMBERED) {
      const oldest = records.keys().next();
      if (oldest.done) break;
      records.delete(oldest.value);
    }
  }

  function noteOutput(sessionId: string, nowMs: number = Date.now()): void {
    const record = records.get(sessionId);
    if (record) record.lastOutputAtMs = nowMs;
  }

  function noteExit(sessionId: string, exitCode: number | null, nowMs: number = Date.now()): void {
    const record = records.get(sessionId);
    if (!record) return;
    record.exitCode = exitCode;
    record.exitedAtMs = nowMs;
  }

  /**
   * Answer one probe.
   *
   * `running` wins over a recorded exit: the live process table is the fresher fact, and a
   * re-assign of a remembered id must not be reported dead. A remembered id with neither a
   * live process nor a recorded exit is reported `exited` with a null code — the narrow
   * window where a spawn threw and the board was already told `assign_failed`; the one
   * thing it must not be is `unknown`, which would claim the assignment never arrived.
   */
  function probe(sessionId: string): SessionProbeAnswer {
    const record = records.get(sessionId);
    if (deps.isLive(sessionId)) {
      const pid = deps.pidOf(sessionId);
      const stdinOpen = deps.stdinOpenOf?.(sessionId);
      return {
        state: "running",
        ...(pid !== undefined ? { pid } : {}),
        ...(stdinOpen !== undefined ? { stdinOpen } : {}),
        ...(record ? { startedAtMs: record.startedAtMs } : {}),
        ...(record?.lastOutputAtMs !== undefined ? { lastOutputAtMs: record.lastOutputAtMs } : {}),
      };
    }
    if (!record) return { state: "unknown" };
    return {
      state: "exited",
      startedAtMs: record.startedAtMs,
      ...(record.lastOutputAtMs !== undefined ? { lastOutputAtMs: record.lastOutputAtMs } : {}),
      exitCode: record.exitCode ?? null,
      ...(record.exitedAtMs !== undefined ? { exitedAtMs: record.exitedAtMs } : {}),
    };
  }

  /**
   * Answer one `probe_session` (#887). ALWAYS answers, including `unknown` — the board blocks
   * on the reply, so a silent drop would turn the one authoritative answer into a timeout,
   * which is the failure this whole mechanism exists to remove.
   */
  function answerProbe(sessionId: string, requestId: string): void {
    const answer = probe(sessionId);
    console.log(`[worker] session probe: sessionId=${sessionId} state=${answer.state}`);
    deps.safeSend({ type: "session_probe_result", sessionId, probe: { requestId, ...answer } });
  }

  /** How many ids are remembered. For diagnostics and for the bound's own test. */
  function size(): number {
    return records.size;
  }

  return { noteAssigned, noteOutput, noteExit, probe, answerProbe, size };
}

export type WorkerSessionRegistry = ReturnType<typeof createWorkerSessionRegistry>;
