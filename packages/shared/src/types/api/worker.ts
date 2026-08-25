/**
 * Worker-fleet wire DTOs (epic #184).
 *
 * `WorkerEvent` used to be declared twice — once in `services/worker-events.service.ts` and
 * once in `components/WorkerEventTimeline.tsx` — which is exactly the drift
 * `wire-dto-single-declaration.test.ts` exists to stop: two hand-maintained copies of one
 * shape, kept in step only by whoever happens to remember. It is one declaration now, and
 * both sides import it (#801).
 *
 * Only the SHAPE lives here. The event VOCABULARY (`WORKER_EVENT_TYPES`) deliberately stays
 * in the server service: nothing outside the server writes an event, and the worker binary's
 * leaf modules must not gain a db-graph import (the worker-cli-isolation guard). Hence
 * `type: string` rather than the union — a wire DTO describes what crosses the wire, and a
 * client rendering a row it does not recognise must not be a type error.
 */
export interface WorkerEvent {
  id: string;
  workerId: string;
  type: string;
  sessionId: string | null;
  summary: string;
  /** Parsed `payload_json`, or null. Parsed server-side so no consumer re-implements the try/catch. */
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Why a worker went away (#881), computed by the board from the event timeline and returned
 * alongside it by `GET /api/workers/:id/events`.
 *
 * The shape lives here for the same reason `WorkerEvent` does: the server derives it and the
 * fleet panel renders it, so a second hand-maintained copy is exactly the drift
 * `wire-dto-single-declaration.test.ts` exists to stop. The DERIVATION stays in
 * `server/src/services/worker-drop-diagnosis.ts` — this is the contract, not the logic.
 *
 * Note the deliberate difference from `WorkerEvent.type`, which is a bare `string` so a
 * client rendering an unrecognised row is not a type error: event types are written by
 * workers, whereas `cause` is produced by the board alone. A closed union is therefore safe
 * here, and useful — the panel switches on it.
 */
export type WorkerDropCause =
  | "healthy"
  | "process-gone"
  | "heartbeat-stall"
  | "silent-respawn"
  | "cycling"
  | "flapping"
  | "insufficient-data";

export interface WorkerDropDiagnosis {
  cause: WorkerDropCause;
  /** `low` when the verdict rests on fewer samples than the signal needs. Never hidden. */
  confidence: "high" | "low";
  /** One operator-facing line. Says what to DO, not just what happened. */
  headline: string;
  /** The evidence the headline rests on. */
  detail: string;
  drops: number;
  /** `connected` rows with no preceding `disconnected` — respawns or duplicate dials. */
  unpairedConnects: number;
  reconnectIntervalsMs: number[];
  /** Null (not false) when there are too few intervals to judge periodicity at all. */
  reconnectRegular: boolean | null;
  lastDropAt: string | null;
  reconnectsSinceLastDrop: number;
  msSinceLastDrop: number | null;
}
