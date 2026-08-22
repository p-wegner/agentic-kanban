// Worker capacity RESERVATIONS — the placement-time half of fleet load (#751).
//
// Board-side load was `pendingSessionIds` (#248), which starts counting when the
// `assign` is actually put on the wire. For a same-filesystem dispatch that is the
// same synchronous turn as the placement, so the two are indistinguishable. For a
// TRUE remote (git-transport) dispatch they are not: the assign is deferred behind
// `ensureGitHttpServer` + `listAgentSkills` in a fire-and-forget IIFE, so between
// "this worker is placed" and "this worker is loaded" there is an arbitrary async
// window. Two concurrent `resolveWorkerPlacement` calls both read load 0 and both
// place on a `maxConcurrency: 1` worker; the second one comes back as
// `assign_failed: capacity` -> a failed session, not a host fallback.
//
// So capacity has to be claimed by the DECISION, not by the send. A reservation is
// taken in the same synchronous turn that reads the load (see
// `selectAndReserveWorkerForLaunch`), which is what makes the choice atomic: an
// interleaved second selection resumes after the first has already reserved.
//
// The ledger is process-wide rather than per-fleet on purpose: the dispatch proxy
// claims and releases reservations and has no database handle (it is the layer
// BELOW the fleet facade — see agent-dispatch.service.ts's header). Reservation ids
// are random, so two fleets on two databases cannot collide.

import { randomUUID } from "node:crypto";

/**
 * How long an unclaimed reservation counts against a worker.
 *
 * It only has to cover placement -> launch -> assign: container provisioning is
 * already done by then, and the git-transport prerequisites are a local listener
 * plus a DB read. Anything longer than this means the launch never happened, and a
 * reservation that outlives its launch would pin capacity for no one.
 */
export const WORKER_SLOT_RESERVATION_TTL_MS = 2 * 60 * 1000;

interface Reservation {
  workerId: string;
  expiresAt: number;
  /** Set once the launch this reservation was taken for got a sessionId. */
  sessionId?: string;
}

const reservations = new Map<string, Reservation>();

function sweep(nowMs: number): void {
  for (const [id, reservation] of reservations) {
    if (reservation.expiresAt <= nowMs) reservations.delete(id);
  }
}

/**
 * Claim one slot on `workerId`. Call this in the SAME synchronous turn as the load
 * read it is based on — a reservation taken after an intervening `await` proves
 * nothing about what another placement decided in between.
 */
export function reserveWorkerSlot(workerId: string, nowMs = Date.now()): string {
  sweep(nowMs);
  const id = randomUUID();
  reservations.set(id, { workerId, expiresAt: nowMs + WORKER_SLOT_RESERVATION_TTL_MS });
  return id;
}

/**
 * Bind a reservation to the session that was actually launched under it. From this
 * point the reservation stops adding load of its own: the session is counted by the
 * connection manager's assigned set once the `assign` lands, and counting it twice
 * would make a `maxConcurrency: 2` worker look full with one session on it.
 */
export function claimWorkerSlot(reservationId: string, sessionId: string): void {
  const reservation = reservations.get(reservationId);
  if (reservation) reservation.sessionId = sessionId;
}

/** Give the slot back — the placement was discarded (host fallback, strict refusal, kill). */
export function releaseWorkerSlot(reservationId: string | undefined): void {
  if (reservationId) reservations.delete(reservationId);
}

/**
 * Extra load on `workerId` from reservations that the connection manager cannot see
 * yet: every live reservation that is either unclaimed, or claimed by a session the
 * worker has not been told about (or has not reported) yet.
 *
 * `assignedSessionIds` is the manager's answer for the same worker, passed in rather
 * than imported so this module stays dependency-free and testable on its own.
 */
export function reservedSlotCount(
  workerId: string,
  assignedSessionIds: readonly string[],
  nowMs = Date.now(),
): number {
  sweep(nowMs);
  const assigned = new Set(assignedSessionIds);
  let count = 0;
  for (const reservation of reservations.values()) {
    if (reservation.workerId !== workerId) continue;
    if (reservation.sessionId && assigned.has(reservation.sessionId)) continue;
    count += 1;
  }
  return count;
}

/** Test seam: the ledger is process-wide, so suites must not inherit each other's slots. */
export function __resetWorkerSlotReservations(): void {
  reservations.clear();
}

/** Test/diagnostic seam: how many live reservations this worker holds, ignoring dedupe. */
export function __reservationCount(workerId: string, nowMs = Date.now()): number {
  sweep(nowMs);
  return [...reservations.values()].filter((r) => r.workerId === workerId).length;
}
