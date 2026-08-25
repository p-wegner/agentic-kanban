// #871 — the board side of a COMPLETED but UNDELIVERED worker result.
//
// A separate module for the same reason as agent-remote-events.ts (#801):
// agent-remote.service.ts sits at the 1000-line god-module ceiling, and this
// handler is a self-contained leaf — it reads one message, writes one worker
// event and (when the session row still exists) one transcript row, and never
// touches the live-session machinery beyond the callback its caller hands it.
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { Database } from "../db/index.js";
import { getSessionLiveness } from "../repositories/worker.repository.js";
import { insertSessionMessages } from "../repositories/broadcast.repository.js";

export type UndeliveredResultMessage = Extract<WorkerToBoardMessage, { type: "undelivered_result" }>;

/**
 * Record an undelivered-result report so the finished work is visible instead of
 * silently missing: loud log, durable worker event (via `noteUndeliveredResult`),
 * and a transcript stamp — through `reportToLiveSession` when the session is still
 * tracked in memory, directly into `session_messages` when it is already finalized.
 */
export function recordUndeliveredResult(opts: {
  workerId: string;
  message: UndeliveredResultMessage;
  database: Database;
  /** The #801 recorder's durable worker-event row. */
  noteUndeliveredResult: (workerId: string, message: UndeliveredResultMessage) => void;
  /** Deliver `text` to the still-live session; return false when it is not tracked (finalized). */
  reportToLiveSession: (text: string) => boolean;
}): void {
  const { workerId, message, database, noteUndeliveredResult, reportToLiveSession } = opts;
  // #871: a COMPLETED run whose result never arrived — even after the worker's
  // reconnect retry. The session was long finalized (its exit was downgraded when the
  // in-run retries exhausted), so without this the finished work is invisible: it
  // sits in a checkout on the worker's disk, which this machine cannot enumerate.
  console.error(
    `[agent-remote] worker ${workerId} holds a COMPLETED but UNDELIVERED result for session ` +
      `${message.sessionId}: push to ${message.incomingRef} failed ${message.attempts} time(s) ` +
      `(last error: ${message.lastError}). The work is KEPT on the worker at ${message.checkoutPath}. ` +
      `Once a push lands, use the Worker Fleet incoming view (POST /api/workers/incoming/land) to ` +
      `bring it onto ${message.branch}.`,
  );
  // The durable record — visible in `worker events <id>` and the fleet panel timeline.
  noteUndeliveredResult(workerId, message);
  const text =
    `Fleet worker ${workerId} reports this session COMPLETED but its result is still UNDELIVERED: ` +
    `the push to ${message.incomingRef} failed ${message.attempts} time(s) ` +
    `(last error: ${message.lastError}). The work is not lost — it is kept on the worker at ` +
    `${message.checkoutPath} — but it has not reached the board.`;
  if (reportToLiveSession(text)) return;
  // Finalized (the normal case): stamp the transcript directly, IF the session row
  // exists — the undelivered state must be visible on the session, not only in a log.
  void (async () => {
    const live = await getSessionLiveness(message.sessionId, database).catch(() => null);
    if (!live) return;
    await insertSessionMessages(
      message.sessionId,
      [{ type: "stderr", data: text, exitCode: null }],
      null,
      database,
    ).catch((err: unknown) => {
      console.error(`[agent-remote] could not record the undelivered state on session ${message.sessionId}`, err);
    });
  })();
}
