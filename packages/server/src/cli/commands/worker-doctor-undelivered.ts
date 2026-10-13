// Doctor check (#1416): list the results this worker still owes the board, with age and attempts.
import {
  UNDELIVERED_MAX_ATTEMPTS,
  loadUndelivered,
  undeliveredAgeMs,
  undeliveredStateFile,
} from "../../worker/worker-undelivered.js";
import { loadPendingDeletes } from "../../worker/worker-pending-delete.js";
import type { DoctorCheck } from "./worker-doctor.js";

function formatAge(ms: number | null): string {
  if (ms === null) return "age unknown";
  const h = ms / 3_600_000;
  return h >= 48 ? `${Math.round(h / 24)}d old` : h >= 1 ? `${Math.round(h)}h old` : `${Math.round(ms / 60_000)}m old`;
}

/** #1445: checkouts a locked file kept from being deleted, awaiting the next sweep. */
export function checkPendingDeletes(workRoot: string): DoctorCheck {
  const name = "pending checkout deletions";
  const records = loadPendingDeletes(workRoot);
  if (records.length === 0) return { name, status: "pass", detail: "none queued" };
  return {
    name,
    status: "warn",
    detail: `${records.length} queued: ${records.map((r) => `${r.dir} (${r.attempts} attempt(s))`).join("; ")}`,
    remedy: "Retried at daemon start and every few minutes; usually a running process still holds a file. Stop it and the next sweep finishes the delete.",
  };
}

export function checkUndeliveredResults(workRoot: string, nowMs: number = Date.now()): DoctorCheck {
  const name = "undelivered results";
  const records = loadUndelivered(workRoot);
  if (records.length === 0) return { name, status: "pass", detail: "none held" };
  const lines = records.map(
    (r) => `${r.sessionId.slice(0, 8)} (${formatAge(undeliveredAgeMs(r.recordedAt, nowMs))}, ${r.attempts} attempt(s))`,
  );
  return {
    name,
    status: "warn",
    detail: `${records.length} held: ${lines.join("; ")}`,
    remedy:
      `Each is retried on reconnect and dropped after ${UNDELIVERED_MAX_ATTEMPTS} attempts or 7 days. ` +
      `Delete an entry from ${undeliveredStateFile(workRoot)} to drop it now - the running daemon honours that.`,
  };
}
