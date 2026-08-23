/**
 * The worker-event rows a REMOTE SESSION leaves behind (#801).
 *
 * Extracted from `agent-remote.service.ts` rather than living beside the launch code, for
 * two reasons that point the same way. The mechanical one: that module is at the god-module
 * gate's 1000-line ceiling, and a diagnostic concern is the cheapest cohesive thing to lift
 * out of it. The real one: these two rows are a self-contained story — "this worker was
 * handed session X" and "here is what became of it" — with exactly one dependency (a
 * database) and no share in the launch, transport or liveness logic around them. Keeping
 * them there made the assign path read as if recording were part of dispatching.
 *
 * Both are fire-and-forget by contract: `recordWorkerEvent` never throws and is never
 * awaited into a caller's critical path, because a diagnostic that can fail a launch is
 * worse than a missing diagnostic.
 */
import type { Database } from "../db/index.js";
import { recordWorkerEvent } from "./worker-events.service.js";

/** What the session's transport was, as it appears in the recorded payload. */
export type RemoteSessionTransport = "git" | "shared-filesystem";

export interface RemoteSessionEventRecorder {
  /** The opening row of an assignment. Called only once the `assign` is ON THE WIRE. */
  noteAssigned(sessionId: string, workerId: string, payload: Record<string, unknown>): void;
  /** The terminal row. Every finalizer calls it, so no ending is unrecorded. */
  noteSessionExit(
    sessionId: string,
    session: { workerId: string; repo?: { branch: string } },
    exitCode: number | null,
    how: string,
  ): void;
}

export function createRemoteSessionEventRecorder(database: Database): RemoteSessionEventRecorder {
  return {
    noteAssigned(sessionId, workerId, payload) {
      void recordWorkerEvent({
        database,
        workerId,
        sessionId,
        type: "assigned",
        summary: `session ${sessionId} assigned to this worker (${String(payload.transport)})`,
        payload,
      });
    },

    noteSessionExit(sessionId, session, exitCode, how) {
      // Called from BOTH finalizers, so a session that ended by exiting, by being lost, by
      // being abandoned or by refusing to launch all leave the same kind of row. Without
      // that, the log records what a worker took and never what became of it — which is
      // precisely the half a #699/#706 post-mortem needs.
      void recordWorkerEvent({
        database,
        workerId: session.workerId,
        sessionId,
        type: "session_exit",
        summary: `session ${sessionId} ended on this worker (${how}, exit ${exitCode ?? "null"})`,
        payload: {
          exitCode,
          how,
          ...(session.repo
            ? { branch: session.repo.branch, transport: "git" satisfies RemoteSessionTransport }
            : { transport: "shared-filesystem" satisfies RemoteSessionTransport }),
        },
      });
    },
  };
}
