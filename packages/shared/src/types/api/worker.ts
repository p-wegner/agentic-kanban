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
